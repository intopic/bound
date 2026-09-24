/**
 * `bound-verify`: Bound's protected swap for bots in any language (Python, Rust, Go...). The bot
 * keeps its key and signs one message itself; this command does everything else the example does,
 * the same code: your own floor, the full check on your RPC, the durable record before finalize,
 * finalize, and the outcome read on the chain for the wallet's own signature. JSON in (stdin), JSON
 * out (stdout), and an exit code:
 *
 *   bound-verify prepare    {"intent": {...}}                       0 ok: sign `message`   1 refused   3 settle first   4 Bound said no
 *   bound-verify finalize   {"checked": ..., "signature": "..."}    0 confirmed   1 not swapped   3 unknown: recover before anything new
 *   bound-verify recover                                            0 all settled   3 something is still unknown
 *   bound-verify check      {"prepared": ..., "intent": {...}}      0 safe to sign   1 refused   (for bots that call the API themselves)
 *   2 on any usage or configuration error; 5 when `intent.id` names an order that already swapped or
 *   whose transaction may still land (the same order is never swapped twice).
 *
 * `intent` is the example's `Intent`: owner, inputMint, outputMint, amountIn (base units, strings),
 * and optionally minOut, maxFeeBps, maxNetworkFeeLamports, maxRouteCostLamports, maxSolFeeLamports,
 * acceptCostBps, version. `prepare` answers `checked` (pass it to finalize unchanged) and `message`,
 * the transaction's message in base64: sign those bytes with the wallet's ed25519 key and pass the
 * 64-byte signature to finalize in base58 as `signature`, or the whole signed transaction in base64
 * as `signedTransaction`. Finalize checks everything again before anything is sent.
 *
 * Environment: SOLANA_RPC_URL (your own RPC; always), BOUND_API_URL and BOUND_API_KEY (prepare,
 * finalize), JUPITER_API_KEY (Jupiter throttles keyless calls), BOUND_STATE_DIR (default ./.bound-state), BOUND_TREASURY
 * (only for another Bound deployment).
 */
import { createSolanaRpc, getBase58Encoder, getTransactionDecoder, getTransactionEncoder } from '@solana/kit';
import type { Address, Rpc, SignatureBytes, SolanaRpcApi } from '@solana/kit';
import {
  acquireLock, BoundApiError, checkPrepared, createFileStore, finalizeSigned, prepareChecked, recoverPending,
} from '../examples/swap.ts';
import type { Checked, Intent, OrderRecord, Prepared } from '../examples/swap.ts';
import { ownMinimum, ownSolFeeLimit } from '../lib/bound-verify.mjs';

export type CliDeps = {
  rpc: Rpc<SolanaRpcApi>;
  apiUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  jupiterApiKey?: string;
  stateDir: string;
  treasury?: string;
  pollMs?: number;
  maxWaitMs?: number;
  requestTimeoutMs?: number;
};

export type CliResult = { code: number; output: Record<string, unknown> };

const COMMANDS = ['prepare', 'finalize', 'recover', 'check'] as const;
const usage = (message: string): CliResult => ({ code: 2, output: { ok: false, error: message } });
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isIntent = (v: unknown): v is Intent => {
  const i = v as Partial<Intent> | null;
  return !!i && [i.owner, i.inputMint, i.outputMint, i.amountIn].every(x => typeof x === 'string' && x.length > 0);
};
const INTENT_SHAPE = '{"owner", "inputMint", "outputMint", "amountIn"} (strings)';

export async function runCli(command: string, input: unknown, deps: CliDeps): Promise<CliResult> {
  const body = (input ?? {}) as Record<string, unknown>;
  const store = createFileStore(deps.stateDir);

  if (command === 'check') {
    const prepared = body.prepared as Prepared | undefined;
    if (!prepared || typeof prepared.transaction !== 'string' || !isIntent(body.intent)) {
      return usage(`check reads {"prepared": <Bound's prepare answer>, "intent": ${INTENT_SHAPE}}.`);
    }
    const intent: Intent = { ...(deps.treasury ? { treasury: deps.treasury } : {}), ...body.intent };
    try {
      intent.minOut ??= await ownMinimum({
        inputMint: intent.inputMint, outputMint: intent.outputMint, amountIn: intent.amountIn, taker: intent.owner,
        maxFeeBps: intent.maxFeeBps, maxBelowBps: intent.maxBelowBps, apiKey: deps.jupiterApiKey, fetchImpl: deps.fetchImpl,
      });
      if ((prepared.policy as { feeSide?: unknown }).feeSide === 'sol' && intent.maxSolFeeLamports === undefined) {
        intent.maxSolFeeLamports = await ownSolFeeLimit({
          inputMint: intent.inputMint, amountIn: intent.amountIn, taker: intent.owner, maxFeeBps: intent.maxFeeBps, apiKey: deps.jupiterApiKey, fetchImpl: deps.fetchImpl,
        });
      }
      const problems = await checkPrepared(prepared, intent, deps.rpc);
      return { code: problems.length ? 1 : 0, output: { ok: problems.length === 0, problems, yourFloor: intent.minOut } };
    } catch (e) {
      return { code: 1, output: { ok: false, problems: [messageOf(e)] } };
    }
  }

  if (command === 'recover') {
    const { settled, unknown } = await recoverPending(store, deps.rpc, { pollMs: deps.pollMs, maxWaitMs: deps.maxWaitMs, orders: store });
    return { code: unknown.length ? 3 : 0, output: { ok: unknown.length === 0, settled, unknown } };
  }

  if (!deps.apiUrl || !deps.apiKey) return usage('Set BOUND_API_URL and BOUND_API_KEY.');
  const api = { apiUrl: deps.apiUrl.replace(/\/+$/, ''), apiKey: deps.apiKey };

  if (command === 'prepare') {
    if (!isIntent(body.intent)) return usage(`prepare reads {"intent": ${INTENT_SHAPE}}.`);
    // One swap at a time, and none while an earlier one could still land (engineering audit S1-M-01).
    const pending = (await store.list()).map(s => s.signature);
    if (pending.length) {
      return { code: 3, output: { ok: false, pending, error: 'Earlier swaps are not settled yet: run `bound-verify recover` first. Nothing was prepared.' } };
    }
    // The same order, asked again: said, not swapped twice (final audit, item 7).
    const orderId = body.intent.id;
    const prior = orderId ? await store.order(orderId) : null;
    if (prior && (prior.state === 'confirmed' || prior.state === 'pending')) {
      return { code: 5, output: { ok: false, order: { id: orderId, ...prior }, error: prior.state === 'confirmed' ? 'This order already swapped. Nothing new was prepared.' : 'This order has a transaction that may still land: run `bound-verify recover`. Nothing new was prepared.' } };
    }
    const { owner, ...rest } = body.intent;
    try {
      const checked = await prepareChecked({
        ...api, rpc: deps.rpc, owner, intent: { ...(deps.treasury ? { treasury: deps.treasury } : {}), ...rest },
        fetchImpl: deps.fetchImpl, jupiterApiKey: deps.jupiterApiKey, requestTimeoutMs: deps.requestTimeoutMs,
      });
      const tx = getTransactionDecoder().decode(Buffer.from(checked.prepared.transaction, 'base64'));
      return {
        code: 0,
        output: {
          ok: true, checked, message: Buffer.from(tx.messageBytes).toString('base64'),
          amounts: checked.prepared.amounts, costs: checked.prepared.costs, lastValidBlockHeight: checked.prepared.lastValidBlockHeight,
        },
      };
    } catch (e) {
      if (e instanceof BoundApiError) {
        return { code: 4, output: { ok: false, error: { status: e.status, code: e.code, message: e.message, retryAfter: e.retryAfter, details: e.body } } };
      }
      return { code: 1, output: { ok: false, problems: [messageOf(e)] } };
    }
  }

  if (command === 'finalize') {
    const checked = body.checked as Checked | undefined;
    const { signature, signedTransaction } = body as { signature?: unknown; signedTransaction?: unknown };
    if (!checked?.prepared || !isIntent(checked.intent) || (typeof signature !== 'string' && typeof signedTransaction !== 'string')) {
      return usage('finalize reads {"checked": <prepare\'s checked, unchanged>, "signature": "<base58>"} or {"checked": ..., "signedTransaction": "<base64>"}.');
    }
    const { prepared, intent } = checked;
    let release: () => void;
    try {
      release = acquireLock(deps.stateDir, prepared.wallet);
    } catch (e) {
      return { code: 1, output: { ok: false, sent: false, error: messageOf(e) } };
    }
    try {
      // Checked again here, on your RPC: finalize takes nothing on trust, not even prepare's output.
      const problems = await checkPrepared(prepared, intent, deps.rpc);
      if (problems.length) return { code: 1, output: { ok: false, sent: false, problems } };
      let wire = typeof signedTransaction === 'string' ? signedTransaction : '';
      if (!wire) {
        const tx = getTransactionDecoder().decode(Buffer.from(prepared.transaction, 'base64'));
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(getBase58Encoder().encode(signature as string));
        } catch {
          return { code: 1, output: { ok: false, sent: false, error: 'signature is not base58.' } };
        }
        if (bytes.length !== 64) return { code: 1, output: { ok: false, sent: false, error: 'signature must be 64 bytes, in base58.' } };
        wire = Buffer.from(getTransactionEncoder().encode({
          ...tx, signatures: { ...tx.signatures, [prepared.wallet as Address]: bytes as SignatureBytes },
        })).toString('base64');
      }
      const result = await finalizeSigned({
        ...api, rpc: deps.rpc, prepared, signedTransaction: wire, fetchImpl: deps.fetchImpl,
        pollMs: deps.pollMs, maxWaitMs: deps.maxWaitMs, requestTimeoutMs: deps.requestTimeoutMs,
        // Kept on disk before finalize: if this process stops, `recover` settles it first. An order
        // is taken here too, atomically when new, so two runs cannot both send it.
        onSigned: async s => {
          const orderId = intent.id;
          if (orderId) {
            const record: OrderRecord = { signature: s.signature, state: 'pending' };
            const prior = await store.order(orderId);
            if (prior && (prior.state === 'confirmed' || prior.state === 'pending')) throw new Error(`Order ${orderId} is already ${prior.state} (${prior.signature}).`);
            if (prior) await store.recordOrder(orderId, record);
            else if (!await store.claimOrder(orderId, record)) throw new Error(`Order ${orderId} was taken by another run.`);
          }
          await store.put({ ...s, ...(orderId ? { intentId: orderId } : {}) });
        },
      });
      if (intent.id) await store.recordOrder(intent.id, { signature: result.signature, state: result.outcome === 'unknown' ? 'pending' : result.outcome });
      if (result.outcome !== 'unknown') await store.remove(result.signature);
      return {
        code: result.outcome === 'confirmed' ? 0 : result.outcome === 'unknown' ? 3 : 1,
        output: {
          ok: result.outcome === 'confirmed', signature: result.signature, outcome: result.outcome,
          ...(result.refusal ? { refusal: result.refusal } : {}), amounts: prepared.amounts,
        },
      };
    } catch (e) {
      // Thrown before finalize was asked: nothing was sent. A record kept by then is settled by `recover`.
      return { code: 1, output: { ok: false, sent: false, error: messageOf(e) } };
    } finally {
      release();
    }
  }

  return usage(`Commands: ${COMMANDS.join(', ')}.`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(): Promise<void> {
  const command = process.argv[2] ?? '';
  const print = (r: CliResult) => {
    process.stdout.write(`${JSON.stringify(r.output, null, 2)}\n`);
    process.exitCode = r.code;
  };
  if (!(COMMANDS as readonly string[]).includes(command)) return print(usage(`usage: bound-verify <${COMMANDS.join('|')}> < input.json`));
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) return print(usage('Set SOLANA_RPC_URL to your own RPC.'));
  if (!process.env.JUPITER_API_KEY && command !== 'recover') {
    process.stderr.write('JUPITER_API_KEY is not set: Jupiter throttles keyless calls, and your own floor may not be priced.\n');
  }
  let input: unknown = {};
  if (command !== 'recover') {
    try {
      input = JSON.parse(await readStdin());
    } catch {
      return print(usage('The input on stdin is not JSON.'));
    }
  }
  print(await runCli(command, input, {
    rpc: createSolanaRpc(rpcUrl),
    apiUrl: process.env.BOUND_API_URL,
    apiKey: process.env.BOUND_API_KEY,
    jupiterApiKey: process.env.JUPITER_API_KEY || undefined,
    stateDir: process.env.BOUND_STATE_DIR || '.bound-state',
    treasury: process.env.BOUND_TREASURY || undefined,
  }));
}
