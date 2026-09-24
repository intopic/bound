/**
 * The agent API (API-AGJENTET.md, section 7): the real pipeline behind /v1/prepare and /v1/finalize,
 * against the fake RPC and Jupiter the pipeline's own tests use. The fee holds because Bound signs
 * as E only the exact message it built; every test here that changes that message must end with
 * nothing signed and nothing sent.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  address, compileTransaction, decompileTransactionMessage, generateKeyPairSigner, getCompiledTransactionMessageDecoder,
  SolanaError, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, getPublicKeyFromAddress, getSignatureFromTransaction, getTransactionDecoder, getTransactionEncoder,
  partiallySignTransaction, signBytes, verifySignature,
} from '@solana/kit';
import type { Address, KeyPairSigner, Transaction } from '@solana/kit';
import { ataOf, feeFor, SYSTEM_PROGRAM, WSOL_MINT } from '@bound/core';
import { fakeJupiter, fakeRpc, fundedAccounts, mint, POOL, DEX, tokenAccount, USDC, BONK } from '../../../packages/jupiter/test/fakes.ts';
import type { Account } from '../../../packages/jupiter/test/fakes.ts';
import { agentFinalize, agentPrepare } from '../lib/server/agent/api.ts';
import type { AgentDeps } from '../lib/server/agent/api.ts';
import { ephemeralFor, kidOf, openTicket, sealTicket } from '../lib/server/agent/ticket.ts';

const KEY = 'bnd_test_key_for_the_agent_api_0001';
const OTHER_KEY = 'bnd_test_key_for_another_agent_0002';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = (fill: number) => new Uint8Array(32).fill(fill);
const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

let n = 0;
async function world(opts: {
  height?: bigint; disabled?: boolean; jupiter?: AgentDeps['jupiter']; sendError?: unknown; treasury?: null; treasuryWallet?: boolean;
} = {}) {
  const W = await generateKeyPairSigner();
  const accounts = new Map<string, Account>([
    [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
    [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [POOL, { owner: DEX, data: new Uint8Array(300) }],
    // The treasury has an account for USDC, so the fee is charged.
    [await ataOf(TREASURY, USDC), tokenAccount(TREASURY, USDC)],
    ...await fundedAccounts(W.address, USDC),
    // With a wallet, the treasury takes the fee of a sale into SOL in SOL, out of the output.
    ...(opts.treasuryWallet ? [[TREASURY, { owner: SYSTEM_PROGRAM, data: new Uint8Array(0) }] as [string, Account]] : []),
  ]);
  const sent: string[] = [];
  const deps: AgentDeps = {
    rpc: fakeRpc(accounts, { height: opts.height, sent, sendError: opts.sendError }),
    jupiter: opts.jupiter ?? fakeJupiter(),
    secrets: [secret(7)],
    keys: new Map([[sha(KEY), 'agent-one'], [sha(OTHER_KEY), 'agent-two']]),
    feeBps: 20n,
    treasury: opts.treasury === null ? null : TREASURY,
    excludeDexes: ['HumidiFi'],
    maxNetworkFeeLamports: 200_000n,
    disabled: opts.disabled ?? false,
    v1: false,
    perMinute: 1_000,
  };
  return { W, deps, sent, accounts };
}

const post = (path: string, body: unknown, key: string | null = KEY) =>
  new Request(`http://bound.test/api/v1/${path}?n=${++n}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const swapBody = (W: Address, extra: Record<string, unknown> = {}) =>
  ({ owner: W, inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', ...extra });

type Prepared = { ticket: string; transaction: string; messageSha256: string; temporaryAuthority: string; amounts: { fee: string; feeBps: string } };

async function prepared(w: Awaited<ReturnType<typeof world>>, extra: Record<string, unknown> = {}): Promise<Prepared> {
  const res = await agentPrepare(post('prepare', swapBody(w.W.address, extra)), w.deps);
  expect(res.status).toBe(200);
  return res.json();
}

/** What an honest agent does: sign the transaction it was given, as W, and nothing else. */
async function signAsWallet(W: KeyPairSigner, wire: string): Promise<string> {
  const tx = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
  const signed = await partiallySignTransaction([W.keyPair], tx);
  return Buffer.from(getTransactionEncoder().encode(signed)).toString('base64');
}

/** A message with one byte changed, signed by W: the shape of an agent that edited the transaction. */
async function signChanged(W: KeyPairSigner, wire: string, at: (length: number) => number): Promise<string> {
  const tx = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
  const bytes = new Uint8Array(tx.messageBytes);
  bytes[at(bytes.length)] ^= 1;
  const changed = { ...tx, messageBytes: bytes } as unknown as Transaction;
  const signed = await partiallySignTransaction([W.keyPair], changed);
  return Buffer.from(getTransactionEncoder().encode(signed)).toString('base64');
}

const finalize = (w: Awaited<ReturnType<typeof world>>, ticket: string, signedTransaction: string, key = KEY) =>
  agentFinalize(post('finalize', { ticket, signedTransaction }, key), w.deps);

describe('prepare', () => {
  it('builds the protected swap with the fee in it, and a ticket bound to the exact message', async () => {
    const w = await world();
    const p = await prepared(w);
    expect(p.amounts.feeBps).toBe('20');
    expect(BigInt(p.amounts.fee)).toBe(feeFor(1_000_000n, { feeBps: 20n, treasury: TREASURY }));
    const tx = getTransactionDecoder().decode(Buffer.from(p.transaction, 'base64'));
    expect(createHash('sha256').update(Buffer.from(tx.messageBytes)).digest('hex')).toBe(p.messageSha256);
    const opened = await openTicket(w.deps.secrets, p.ticket);
    expect(opened?.ticket.msg).toBe(p.messageSha256);
    expect(opened?.ticket.key).toBe('agent-one');
    expect(Object.keys(tx.signatures).sort()).toEqual([w.W.address, p.temporaryAuthority].sort());
    // What the transaction has left to live, in blocks (research audit F-05): the fake chain is at 1.
    expect((p as unknown as { blocksLeft: string }).blocksLeft).toBe('999');
  });

  it("Jupiter's format changing is a 503 to retry much later, not a price (research audit F-07)", async () => {
    const w = await world({ jupiter: fakeJupiter({ unknownFormat: true }) });
    const res = await agentPrepare(post('prepare', swapBody(w.W.address)), w.deps);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('300');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('route-format');
  });

  it('refuses without a valid API key', async () => {
    const w = await world();
    expect((await agentPrepare(post('prepare', swapBody(w.W.address), null), w.deps)).status).toBe(401);
    expect((await agentPrepare(post('prepare', swapBody(w.W.address), 'bnd_not_a_key_we_ever_issued'), w.deps)).status).toBe(401);
  });

  it('refuses while swaps are paused, before anything is built', async () => {
    const w = await world({ disabled: true });
    const res = await agentPrepare(post('prepare', swapBody(w.W.address)), w.deps);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('paused');
  });

  it('refuses malformed requests with the reason', async () => {
    const w = await world();
    for (const bad of [
      { owner: 'not-an-address' }, { amountIn: '0' }, { amountIn: 1_000_000 }, { amountIn: '1.5' }, { outputMint: USDC },
      { minOut: '-1' }, { version: 2 }, { version: 1 },
    ]) {
      const res = await agentPrepare(post('prepare', swapBody(w.W.address, bad)), w.deps);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await agentPrepare(post('prepare', '[1,2]'), w.deps)).status).toBe(400);
  });

  it('a minimum the market cannot meet is put back to the agent with the new one, never lowered for it', async () => {
    const w = await world();
    const res = await agentPrepare(post('prepare', swapBody(w.W.address, { minOut: String(10n ** 12n) })), w.deps);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('price-moved');
    expect(BigInt(body.error.newMinOut)).toBeGreaterThan(0n);
  });

  it('a busy Jupiter is a 503 to retry, not a missing route', async () => {
    const honest = fakeJupiter();
    const w = await world({
      jupiter: {
        ...honest,
        async build() {
          const { JupiterError } = await import('@bound/jupiter');
          throw new JupiterError('Jupiter 429: Too many requests', 429);
        },
      },
    });
    const res = await agentPrepare(post('prepare', swapBody(w.W.address)), w.deps);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('busy');
    expect(res.headers.get('retry-after')).toBe('5');
  });
});

describe('finalize', () => {
  it('signs as E the message W signed, and sends it once', async () => {
    const w = await world();
    const p = await prepared(w);
    const res = await finalize(w, p.ticket, await signAsWallet(w.W, p.transaction));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('sent');
    expect(w.sent).toHaveLength(1);
    const signed = getTransactionDecoder().decode(Buffer.from(body.signedTransaction, 'base64'));
    expect(getSignatureFromTransaction(signed)).toBe(body.signature);
    for (const signer of [w.W.address, p.temporaryAuthority]) {
      const signature = signed.signatures[signer as Address];
      expect(signature).toBeTruthy();
      expect(await verifySignature(await getPublicKeyFromAddress(signer as Address), signature!, signed.messageBytes)).toBe(true);
    }
  });

  it('the same ticket twice gives the same transaction, which can land once', async () => {
    const w = await world();
    const p = await prepared(w);
    const signed = await signAsWallet(w.W, p.transaction);
    const first = await (await finalize(w, p.ticket, signed)).json();
    const second = await (await finalize(w, p.ticket, signed)).json();
    expect(second.signature).toBe(first.signature);
    expect(second.signedTransaction).toBe(first.signedTransaction);
  });

  // The fee: a message without it, or with any byte changed, is not the message Bound built.
  for (const [where, at] of [
    ['the first byte', () => 0],
    ['the middle', (len: number) => Math.floor(len / 2)],
    ['the last byte', (len: number) => len - 1],
  ] as const) {
    it(`a message changed at ${where} is refused: E does not sign, nothing is sent`, async () => {
      const w = await world();
      const p = await prepared(w);
      const res = await finalize(w, p.ticket, await signChanged(w.W, p.transaction, at));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('transaction-changed');
      expect(w.sent).toHaveLength(0);
    });
  }

  it('an agent that removes the fee transfer, rebuilds and signs the rest is refused', async () => {
    const w = await world();
    const res0 = await agentPrepare(post('prepare', swapBody(w.W.address)), w.deps);
    const p = await res0.json() as Prepared & { policy: { accounts: { feeDestination: string } } };
    const feeTo = p.policy.accounts.feeDestination;
    expect(feeTo).toBeTruthy();
    const tx = getTransactionDecoder().decode(Buffer.from(p.transaction, 'base64'));
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as never);
    const withoutFee = {
      ...message,
      instructions: message.instructions.filter(ix => !ix.accounts?.some(a => a.address === feeTo)),
    } as typeof message;
    expect(withoutFee.instructions.length).toBe(message.instructions.length - 1);
    const rebuilt = await partiallySignTransaction([w.W.keyPair], compileTransaction(withoutFee as never));
    const r = await finalize(w, p.ticket, Buffer.from(getTransactionEncoder().encode(rebuilt)).toString('base64'));
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe('transaction-changed');
    expect(w.sent).toHaveLength(0);
  });

  it('a transaction W did not sign is refused (R6)', async () => {
    const w = await world();
    const p = await prepared(w);
    const res = await finalize(w, p.ticket, p.transaction);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('wallet-changed-transaction');
    expect(w.sent).toHaveLength(0);
  });

  it("a signature in W's place made by another key is refused", async () => {
    const w = await world();
    const p = await prepared(w);
    const tx = getTransactionDecoder().decode(Buffer.from(p.transaction, 'base64'));
    const other = await generateKeyPairSigner();
    const forged = { ...tx, signatures: { ...tx.signatures, [w.W.address]: await signBytes(other.keyPair.privateKey, tx.messageBytes) } };
    const res = await finalize(w, p.ticket, Buffer.from(getTransactionEncoder().encode(forged as never)).toString('base64'));
    expect(res.status).toBe(400);
    expect(w.sent).toHaveLength(0);
  });

  it('a forged ticket is refused', async () => {
    const w = await world();
    const p = await prepared(w);
    const signed = await signAsWallet(w.W, p.transaction);
    const [payload] = p.ticket.split('.');
    const forged = `${payload}.${Buffer.from(new Uint8Array(32)).toString('base64url')}`;
    expect((await finalize(w, forged, signed)).status).toBe(400);
    // A ticket rewritten to point at another message, sealed with a key that is not the server's.
    const opened = (await openTicket(w.deps.secrets, p.ticket))!.ticket;
    const selfSealed = await sealTicket(secret(9), { ...opened, kid: await kidOf(secret(9)) });
    expect((await finalize(w, selfSealed, signed)).status).toBe(400);
    expect(w.sent).toHaveLength(0);
  });

  it("another API key cannot finalize this key's ticket", async () => {
    const w = await world();
    const p = await prepared(w);
    const res = await finalize(w, p.ticket, await signAsWallet(w.W, p.transaction), OTHER_KEY);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid-ticket');
    expect(w.sent).toHaveLength(0);
  });

  it('a ticket past its lifetime is refused as expired', async () => {
    const w = await world();
    const p = await prepared(w);
    const late = { ...w, deps: { ...w.deps, rpc: fakeRpc(new Map(), { height: 10_000n, sent: w.sent }) } };
    const res = await finalize(late, p.ticket, await signAsWallet(w.W, p.transaction));
    expect(res.status).toBe(410);
    expect(w.sent).toHaveLength(0);
  });

  it('a rotated secret still finalizes the tickets it sealed, while it is listed as previous', async () => {
    const w = await world();
    const p = await prepared(w);
    const signed = await signAsWallet(w.W, p.transaction);
    const rotated = { ...w, deps: { ...w.deps, secrets: [secret(8), secret(7)] } };
    expect((await finalize(rotated, p.ticket, signed)).status).toBe(200);
    const dropped = { ...w, deps: { ...w.deps, secrets: [secret(8)] } };
    expect((await finalize(dropped, p.ticket, signed)).status).toBe(400);
  });

  it('refuses while swaps are paused: E does not sign', async () => {
    const w = await world();
    const p = await prepared(w);
    const paused = { ...w, deps: { ...w.deps, disabled: true } };
    expect((await finalize(paused, p.ticket, await signAsWallet(w.W, p.transaction))).status).toBe(503);
    expect(w.sent).toHaveLength(0);
  });
});

describe('E, derived rather than stored', () => {
  it('the same secret and nonce give the same E on any instance; another nonce or secret, another E', async () => {
    const a = await ephemeralFor(secret(7), 'nonce-one');
    const b = await ephemeralFor(secret(7), 'nonce-one');
    expect(a.address).toBe(b.address);
    expect((await ephemeralFor(secret(7), 'nonce-two')).address).not.toBe(a.address);
    expect((await ephemeralFor(secret(8), 'nonce-one')).address).not.toBe(a.address);
  });

  it('its private key cannot be exported', async () => {
    const E = await ephemeralFor(secret(7), 'nonce-one');
    expect(E.keyPair.privateKey.extractable).toBe(false);
  });
});

describe('review fixes on the API', () => {
  it('a swap into a token whose balance moved since prepare is not signed (FA-04)', async () => {
    const w = await world();
    const res = await agentPrepare(post('prepare', swapBody(w.W.address, { outputMint: BONK })), w.deps);
    expect(res.status).toBe(200);
    const p = (await res.json()) as Prepared;
    // Another swap into BONK lands between prepare and finalize.
    const wOut = await ataOf(w.W.address, BONK);
    const landed = tokenAccount(w.W.address, BONK);
    new DataView(landed.data.buffer).setBigUint64(64, 5_000n, true);
    w.accounts.set(wOut, landed);
    const r = await finalize(w, p.ticket, await signAsWallet(w.W, p.transaction));
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe('output-balance-changed');
    expect(w.sent).toHaveLength(0);
  });

  it('a finalize refused by the network hands back no transaction to broadcast (FA-08)', async () => {
    const preflight = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {} as never);
    const w = await world({ sendError: preflight });
    const p = await prepared(w);
    const body = await (await finalize(w, p.ticket, await signAsWallet(w.W, p.transaction))).json();
    expect(body.status).toBe('rejected');
    expect(body.signedTransaction).toBeUndefined();
  });

  it('a fee-free swap says 0 bps, not the configured fee (FA-16)', async () => {
    const w = await world({ treasury: null });
    const p = await prepared(w);
    expect(p.amounts.fee).toBe('0');
    expect(p.amounts.feeBps).toBe('0');
  });
});

describe('API keys from the environment', () => {
  it('two keys with one id: the first one wins, so they never share tickets and limits (FA-16)', async () => {
    const { agentDeps } = await import('../lib/server/agent/config.ts');
    process.env.BOUND_API_SECRET = Buffer.alloc(32, 1).toString('base64');
    process.env.BOUND_API_KEYS = `a:${sha('key-one')},a:${sha('key-two')},b:${sha('key-three')}`;
    try {
      const deps = agentDeps()!;
      expect([...deps.keys.values()]).toEqual(['a', 'b']);
      expect(deps.keys.has(sha('key-one'))).toBe(true);
      expect(deps.keys.has(sha('key-two'))).toBe(false);
    } finally {
      delete process.env.BOUND_API_SECRET;
      delete process.env.BOUND_API_KEYS;
    }
  });
});

describe("the fee, taken like Jupiter's", () => {
  it('a sale into SOL names SOL as the fee token and states the minimum the wallet keeps', async () => {
    const w = await world({ treasuryWallet: true });
    const p = await prepared(w) as unknown as { amounts: Record<string, string>; policy: Record<string, string> };
    expect(p.amounts.feeMint).toBe(WSOL_MINT);
    expect(p.amounts.swapAmount).toBe(p.amounts.amountIn);
    expect(BigInt(p.amounts.minOut) + BigInt(p.amounts.fee)).toBe(BigInt(p.policy.minOut));
  });

  it("without a treasury wallet the sale pays in USDC, the next token in line, from the input", async () => {
    const w = await world();
    const p = await prepared(w) as unknown as { amounts: Record<string, string> };
    expect(p.amounts.feeMint).toBe(USDC);
  });
});
