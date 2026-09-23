/**
 * Second review, C-03: after a transaction may have been broadcast, "nothing moved" is only said
 * when the network proves it. Every other case is `unknown`, with the signature kept.
 */
import { describe, expect, it } from 'vitest';
import {
  appendTransactionMessageInstruction, createTransactionMessage, generateKeyPairSigner, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  SolanaError, SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from '@solana/kit';
import type { Address, Blockhash } from '@solana/kit';
import { httpStatusOf, retryingTransport, sendAndConfirm } from '../src/index.ts';
import type { SendStatus, SolanaRpc } from '../src/index.ts';

const LAST_VALID = 100n;
const timing = { pollMs: 1, rebroadcastMs: 1, giveUpMs: 150, settleTries: 3, settleMs: 1 };

async function signedTransaction() {
  const payer = await generateKeyPairSigner();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(payer, m),
    m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: LAST_VALID }, m),
    m => appendTransactionMessageInstruction({ programAddress: '11111111111111111111111111111111' as Address, data: new Uint8Array([2, 0, 0, 0]) }, m),
  );
  return signTransactionMessageWithSigners(message);
}

type Status = { confirmationStatus: 'processed' | 'confirmed' | 'finalized'; err: unknown } | null;
/** Each read takes the next scripted value; the last one repeats. 'throw' simulates a failed read. */
function fakeRpc(script: { firstSend?: 'ok' | Error; statuses?: (Status | 'throw')[]; heights?: bigint[] }) {
  let sends = 0;
  let statusReads = 0;
  let heightReads = 0;
  const next = <T>(list: T[], i: number) => list[Math.min(i, list.length - 1)];
  const rpc = {
    sendTransaction: () => ({
      send: async () => {
        if (sends++ === 0 && script.firstSend instanceof Error) throw script.firstSend;
        return 'sig';
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => {
        const s = next(script.statuses ?? [null], statusReads++);
        if (s === 'throw') throw new Error('status read failed');
        return { value: [s] };
      },
    }),
    getBlockHeight: () => ({ send: async () => next(script.heights ?? [1n], heightReads++) }),
  } as unknown as SolanaRpc;
  return { rpc, reads: () => statusReads };
}

async function run(script: Parameters<typeof fakeRpc>[0]) {
  const { rpc, reads } = fakeRpc(script);
  const events: SendStatus[] = [];
  const result = await sendAndConfirm({
    rpc, transaction: await signedTransaction(), lastValidBlockHeight: LAST_VALID, timing, onStatus: s => events.push(s),
  });
  return { result, events, reads: reads() };
}

const confirmed: Status = { confirmationStatus: 'confirmed', err: null };
const processed: Status = { confirmationStatus: 'processed', err: null };
const httpError = (statusCode: number, stoppedByBound = false) => {
  const headers = new Headers();
  if (stoppedByBound) headers.set('x-bound-not-forwarded', '1');
  return new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers, message: 'error', statusCode } as never);
};

describe('C-03: the outcome of a send', () => {
  it('reports the signature before the first request', async () => {
    const { result, events } = await run({ statuses: [confirmed] });
    expect(events[0]).toBe('sending');
    expect(result.signature.length).toBeGreaterThan(80);
  });

  it('a lost connection on the first send keeps watching: it may have landed', async () => {
    const { result } = await run({ firstSend: new Error('fetch failed'), statuses: [null, confirmed] });
    expect(result.status).toBe('confirmed');
  });

  it('a gateway error (5xx) is ambiguous, not a refusal', async () => {
    const { result } = await run({ firstSend: httpError(502), statuses: [confirmed] });
    expect(result.status).toBe('confirmed');
  });

  it('an upstream 4xx is ambiguous without Bound\'s local-refusal marker', async () => {
    const { result } = await run({ firstSend: httpError(429), statuses: [confirmed] });
    expect(result.status).toBe('confirmed');
  });

  it('an internal JSON-RPC error keeps watching because the node may have accepted the send', async () => {
    const internal = new SolanaError(SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, { __serverMessage: 'internal' });
    const { result } = await run({ firstSend: internal, statuses: [null, confirmed] });
    expect(result.status).toBe('confirmed');
  });

  it('a preflight refusal means it was never broadcast', async () => {
    const preflight = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {} as never);
    const { result, reads } = await run({ firstSend: preflight });
    expect(result.status).toBe('rejected');
    expect(reads).toBe(0);
  });

  it("a refusal from Bound's proxy (4xx) means it was never broadcast", async () => {
    expect((await run({ firstSend: httpError(429, true) })).result.status).toBe('rejected');
  });

  it('status reads that keep failing end as unknown, never as "nothing moved"', async () => {
    expect((await run({ statuses: ['throw'] })).result.status).toBe('unknown');
  });

  it('processed at expiry is not an outcome: it waits for confirmation', async () => {
    const { result } = await run({ statuses: [processed, processed, confirmed], heights: [LAST_VALID + 1n] });
    expect(result.status).toBe('confirmed');
  });

  it('processed but never confirmed after expiry ends as unknown', async () => {
    expect((await run({ statuses: [processed], heights: [LAST_VALID + 1n] })).result.status).toBe('unknown');
  });

  it('expired only when the cluster has no record of it after the blockhash expired', async () => {
    expect((await run({ statuses: [null], heights: [LAST_VALID + 1n] })).result.status).toBe('expired');
  });

  it('an on-chain error is a failure that reverted', async () => {
    const failed: Status = { confirmationStatus: 'confirmed', err: { InstructionError: [7, { Custom: 1 }] } };
    const { result } = await run({ statuses: [failed] });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('InstructionError');
  });
});

describe('who refused a send that was never broadcast', () => {
  it("Bound's kill switch (403 from the relay) is told as a pause, not as a price move", async () => {
    const { result } = await run({ firstSend: httpError(403, true) });
    expect(result.status).toBe('rejected');
    expect(result.refusal).toBe('paused');
  });

  it("the relay's send limit (429) is told as too many requests", async () => {
    expect((await run({ firstSend: httpError(429, true) })).result.refusal).toBe('busy');
  });

  it("the RPC's preflight is the network's refusal", async () => {
    const preflight = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {} as never);
    expect((await run({ firstSend: preflight })).result.refusal).toBe('network');
  });
});

describe('a rate-limited RPC in the production build', () => {
  /** Errors made as the page users load makes them: kit replaces the words with a code. */
  const productionError = (statusCode: number) => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      return httpError(statusCode);
    } finally {
      process.env.NODE_ENV = env;
    }
  };

  it('has no "429" in its message, so the status must come from the context', () => {
    const e = productionError(429);
    expect(e.message).not.toMatch(/429|Too Many Requests/i);
    expect(httpStatusOf(e)).toBe(429);
  });

  it('is retried, and the answer that follows is returned', async () => {
    let calls = 0;
    const transport = (async () => {
      if (calls++ < 2) throw productionError(429);
      return { ok: true };
    }) as unknown as Parameters<typeof retryingTransport>[0];
    expect(await retryingTransport(transport, 5, 1)({} as never)).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it('any other failure is not retried', async () => {
    let calls = 0;
    const transport = (async () => {
      calls++;
      throw productionError(502);
    }) as unknown as Parameters<typeof retryingTransport>[0];
    await expect(retryingTransport(transport, 5, 1)({} as never)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
