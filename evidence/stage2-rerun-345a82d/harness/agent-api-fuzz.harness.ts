/**
 * The agent API fuzz harness (Stage 2 re-run): property tests over /api/v1/prepare, /api/v1/finalize
 * and the skill's bookkeeping, against the fake chain and Jupiter the other tests use. Each property
 * is an invariant that must hold whatever the input or the fault:
 *
 *   A  prepare: any body, key or header is answered without a 500 and without a send; a 200 is bound
 *      to exactly the message it returns, unsigned, with a fee within the cap.
 *   B  finalize: a changed ticket, message, signature, key or wire sends nothing, and whatever is ever
 *      sent is the exact message Bound built, signed by W and E.
 *   C  finalize under faults: one transaction per ticket, nothing sent once it landed or while paused,
 *      nothing sent when the chain cannot be read, and every refusal names the transaction.
 *   D  secret rotation: a ticket opens with any listed secret that sealed it, and with no other.
 *   E  the skill: one lock holder per wallet (M-01), one swap per wallet in flight (H-02), and the
 *      chain's outcome survives bookkeeping failures (M-03).
 *
 * Outside `npm test` on purpose: a property that fails here is a finding, not a broken build.
 *
 *   BOUND_FC_SEED=20260924 npx vitest run -c evidence/stage2-rerun-345a82d/harness/vitest.config.ts
 *
 * BOUND_FUZZ_RUNS sets the cases per property (default 25; `--mode fuzz` 1,000). fast-check prints
 * the seed and path of any counterexample; the same BOUND_FC_SEED replays it.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  address, generateKeyPairSigner, getBase58Decoder, getPublicKeyFromAddress, getSignatureFromTransaction, getTransactionDecoder,
  getTransactionEncoder, partiallySignTransaction, signBytes, SolanaError, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, verifySignature,
} from '@solana/kit';
import type { Address, KeyPairSigner, Rpc, SignatureBytes, SolanaRpcApi, Transaction } from '@solana/kit';
import { ataOf, SYSTEM_PROGRAM, WSOL_MINT } from '@bound/core';
import { BONK, DEX, fakeJupiter, fakeRpc, fundedAccounts, lamportsSentToTaker, mint, POOL, PUMP, tokenAccount, USDC } from '../../../packages/jupiter/test/fakes.ts';
import type { Account } from '../../../packages/jupiter/test/fakes.ts';
import { agentFinalize, agentPrepare } from '../../../apps/web/lib/server/agent/api.ts';
import type { AgentDeps } from '../../../apps/web/lib/server/agent/api.ts';
import { ephemeralFor, openTicket, sealTicket } from '../../../apps/web/lib/server/agent/ticket.ts';
import { acquireLock, createFileStore, protectedSwap } from '../../../skills/bound-protected-swap/examples/swap.ts';
import type { OrderBook, PendingStore } from '../../../skills/bound-protected-swap/examples/swap.ts';
import { runCli } from '../../../skills/bound-protected-swap/src/cli.ts';

// F: faults in the file system itself, off unless a test turns them on. Unlike a store handed to
// bound-verify, this reaches every commit, including those whose bound-verify takes no store.
const fsFaults = vi.hoisted(() => ({ rmPending: false, readdir: false }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const enospc = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  return {
    ...fs,
    rmSync: ((path: string, ...rest: unknown[]) => {
      if (fsFaults.rmPending && String(path).includes('pending-')) throw enospc();
      return (fs.rmSync as (...a: unknown[]) => void)(path, ...rest);
    }) as typeof fs.rmSync,
    readdirSync: ((path: string, ...rest: unknown[]) => {
      if (fsFaults.readdir) throw enospc();
      return (fs.readdirSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readdirSync,
  };
});

const RUNS = Number(process.env.BOUND_FUZZ_RUNS ?? ((import.meta as { env?: { MODE?: string } }).env?.MODE === 'fuzz' ? 1_000 : 25));
// Generous: a prepare builds, verifies and simulates a whole swap.
const TIMEOUT = 120_000 + RUNS * 400;

const KEY = 'bnd_fuzz_harness_key_for_agent_0001';
const OTHER_KEY = 'bnd_fuzz_harness_key_for_agent_0002';
const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
// A real mint (JUP) that this fake chain does not hold.
const UNKNOWN_MINT = address('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');
const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
/** Every status the API may answer; a 500 means an input reached code that did not expect it. */
const ANSWERED = new Set([200, 400, 401, 409, 410, 422, 426, 429, 503]);

// --- the world: the fake chain, with faults that can be switched between calls

type Chaos = {
  statusFails: boolean;
  send: 'ok' | 'preflight' | 'http429' | 'http503' | 'network';
  landOnSend: boolean;
};
const httpError = (statusCode: number) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: `HTTP ${statusCode}`, statusCode } as never);

let n = 0;
async function world(opts: { secrets?: Uint8Array[]; minSkillVersion?: string | null; takerRent?: bigint; cashback?: bigint; jupiter?: AgentDeps['jupiter']; treasuryWallet?: boolean } = {}) {
  const W = await generateKeyPairSigner();
  const accounts = new Map<string, Account>([
    [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
    [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [POOL, { owner: DEX, data: new Uint8Array(300) }],
    [PUMP, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [await ataOf(TREASURY, USDC), tokenAccount(TREASURY, USDC)],
    ...await fundedAccounts(W.address, USDC),
    // With a wallet, the treasury can take its fee in SOL (a sale into SOL, a buy with SOL).
    ...(opts.treasuryWallet ? [[TREASURY, { owner: SYSTEM_PROGRAM, data: new Uint8Array(0) }] as [string, Account]] : []),
  ]);
  const sent: string[] = [];
  const statuses: NonNullable<NonNullable<Parameters<typeof fakeRpc>[1]>['statuses']> = new Map();
  const base = fakeRpc(accounts, { sent, statuses, takerRent: opts.takerRent, cashback: opts.cashback });
  const chaos: Chaos = { statusFails: false, send: 'ok', landOnSend: false };
  const rpc = {
    ...base,
    getSignatureStatuses: (...a: never[]) => ({
      send: async () => {
        if (chaos.statusFails) throw httpError(503);
        return (base.getSignatureStatuses as (...x: never[]) => { send: () => Promise<unknown> })(...a).send();
      },
    }),
    sendTransaction: (wire: string, ...rest: never[]) => ({
      send: async () => {
        if (chaos.send === 'preflight') throw new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {} as never);
        if (chaos.send === 'http429') throw httpError(429);
        if (chaos.send === 'http503') throw httpError(503);
        const answer = await (base.sendTransaction as (...x: never[]) => { send: () => Promise<unknown> })(wire as never, ...rest).send();
        if (chaos.landOnSend) {
          statuses.set(getSignatureFromTransaction(getTransactionDecoder().decode(fromB64(wire))), { confirmationStatus: 'confirmed', err: null });
        }
        // Forwarded, then the answer was lost on the way back.
        if (chaos.send === 'network') throw new TypeError('fetch failed');
        return answer;
      },
    }),
  } as unknown as AgentDeps['rpc'];
  const deps: AgentDeps = {
    rpc, jupiter: opts.jupiter ?? fakeJupiter(), secrets: opts.secrets ?? [new Uint8Array(32).fill(7)],
    keys: new Map([[sha(KEY), 'agent-one'], [sha(OTHER_KEY), 'agent-two']]),
    feeBps: 20n, treasury: TREASURY, excludeDexes: ['HumidiFi'], maxNetworkFeeLamports: 200_000n,
    disabled: false, v1: false,
    // The harness sends far more than a minute's quota; the limiter has tests of its own.
    perMinute: 1e9,
    minSkillVersion: opts.minSkillVersion ?? null,
  };
  return { W, deps, sent, statuses, chaos, accounts };
}
type World = Awaited<ReturnType<typeof world>>;

const post = (path: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }) =>
  new Request(`http://bound.test/api/v1/${path}?n=${++n}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

type Prepared = { ticket: string; transaction: string; messageSha256: string; temporaryAuthority: string; wallet: string; lastValidBlockHeight: string };

async function prepareHonest(w: World): Promise<Prepared> {
  const res = await agentPrepare(post('prepare', { owner: w.W.address, inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000' }), w.deps);
  expect(res.status).toBe(200);
  return (await res.json()) as Prepared;
}

async function signAsWallet(W: KeyPairSigner, wire: string): Promise<string> {
  const signed = await partiallySignTransaction([W.keyPair], getTransactionDecoder().decode(fromB64(wire)));
  return b64(new Uint8Array(getTransactionEncoder().encode(signed)));
}

const signatureOfWire = (wire: string) => getSignatureFromTransaction(getTransactionDecoder().decode(fromB64(wire)));

const finalize = (w: World, ticket: unknown, signedTransaction: unknown, key = KEY) =>
  agentFinalize(post('finalize', { ticket, signedTransaction }, { authorization: `Bearer ${key}` }), w.deps);

/** The one invariant of every send: the exact message Bound built, with valid signatures from W and E. */
async function expectCanonical(wires: string[], p: Prepared) {
  for (const wire of wires) {
    const tx = getTransactionDecoder().decode(fromB64(wire));
    expect(sha(new Uint8Array(tx.messageBytes))).toBe(p.messageSha256);
    for (const signer of [p.wallet, p.temporaryAuthority] as Address[]) {
      const s = tx.signatures[signer];
      expect(s, `signature of ${signer}`).toBeTruthy();
      expect(await verifySignature(await getPublicKeyFromAddress(signer), s!, tx.messageBytes)).toBe(true);
    }
  }
}

// --- A: prepare

const u64 = 2n ** 64n - 1n;
const amountArb = fc.oneof(
  fc.bigInt({ min: 1n, max: u64 }).map(String),
  fc.constantFrom('1', '1000000', String(u64), String(u64 + 1n), '0', '-1', '1.5', '1e6', ' 1', '01', '', '٣', '0x10', '99999999999999999999999'),
  fc.integer().map(x => x as unknown as string),
  fc.constant(null as unknown as string),
);
const addressArb = (w: World) => fc.oneof(
  fc.constantFrom<unknown>(w.W.address, USDC, WSOL_MINT, BONK, UNKNOWN_MINT, TREASURY),
  fc.constantFrom<unknown>('not-an-address', '', '1'.repeat(44), 'O0Il'.repeat(11), 42, null, [], {}),
  fc.string({ maxLength: 50 }),
);
const bodyArb = (w: World) => fc.oneof(
  { weight: 6, arbitrary: fc.record({
    owner: addressArb(w), inputMint: addressArb(w), outputMint: addressArb(w), amountIn: amountArb,
    minOut: fc.option(amountArb, { nil: undefined }),
    acceptCostBps: fc.option(fc.oneof(fc.constantFrom('0', '50', '99999', '100000', '-1', 'x'), fc.integer().map(x => x as unknown as string)), { nil: undefined }),
    version: fc.option(fc.constantFrom<unknown>(0, 1, 2, '0', null, true), { nil: undefined }),
  }, { requiredKeys: ['owner', 'inputMint', 'outputMint', 'amountIn'] }) as fc.Arbitrary<unknown> },
  { weight: 1, arbitrary: fc.json({ maxDepth: 3 }) },
  { weight: 1, arbitrary: fc.string({ maxLength: 200 }) },
  { weight: 1, arbitrary: fc.constant('x'.repeat(17 * 1024)) },
);
const authArb = fc.oneof(
  { weight: 5, arbitrary: fc.constant<Record<string, string>>({ authorization: `Bearer ${KEY}` }) },
  { weight: 1, arbitrary: fc.constantFrom<Record<string, string>>(
    {}, { authorization: `bearer ${KEY}` }, { authorization: `Bearer ${OTHER_KEY}` }, { authorization: KEY },
    { authorization: `Bearer ${KEY} ` }, { authorization: `Bearer ${KEY.slice(0, -1)}` }, { authorization: 'Bearer ' + 'a'.repeat(201) },
  ) },
  { weight: 1, arbitrary: fc.string({ maxLength: 60 }).map(s => ({ authorization: `Bearer ${s}` })) },
);


/** What a 200 from prepare must be: exactly its message, unsigned, sealed to this key and wallet, fee within the cap. */
async function expectBound(w: World, json: Record<string, any>, owner: string) {
  const tx = getTransactionDecoder().decode(fromB64(json.transaction));
  expect(sha(new Uint8Array(tx.messageBytes))).toBe(json.messageSha256);
  const opened = await openTicket(w.deps.secrets, json.ticket);
  expect(opened?.ticket.msg).toBe(json.messageSha256);
  expect(opened?.ticket.key).toBe('agent-one');
  expect(opened?.ticket.owner).toBe(owner);
  // Nothing is signed at prepare: Bound signs as E only in finalize, after W.
  expect(Object.keys(tx.signatures).sort()).toEqual([json.wallet, json.temporaryAuthority].sort());
  expect(Object.values(tx.signatures).every(s => s === null)).toBe(true);
  expect(BigInt(json.amounts.feeBps)).toBeLessThanOrEqual(100n);
  if (BigInt(json.amounts.fee) > 0n) expect(BigInt(json.amounts.feeBps)).toBe(w.deps.feeBps);
  // The temporary authority is the E finalize will derive from this ticket.
  const E = await ephemeralFor(opened!.secret, opened!.ticket.nonce);
  expect(E.address).toBe(json.temporaryAuthority);
}

describe('A: prepare, whatever it is sent', () => {
  it('A1: any body, key or header is answered without a 500 and without a send', async () => {
    const w = await world({ minSkillVersion: '1.0.0' });
    const seen: Record<number, number> = {};
    await fc.assert(fc.asyncProperty(
      bodyArb(w), authArb, fc.option(fc.constantFrom('0.9.9', '1.0.0', '2.0.0', 'x', ''), { nil: undefined }),
      async (body, auth, skill) => {
        const before = w.sent.length;
        const res = await agentPrepare(post('prepare', body as never, { ...auth, ...(skill !== undefined ? { 'x-bound-skill': skill } : {}) }), w.deps);
        const text = await res.text();
        seen[res.status] = (seen[res.status] ?? 0) + 1;
        expect(ANSWERED.has(res.status), `status ${res.status}: ${text.slice(0, 300)}`).toBe(true);
        expect(w.sent.length).toBe(before);
        const json = JSON.parse(text);
        if (res.status !== 200) {
          expect(typeof json.error?.code).toBe('string');
          return;
        }
        await expectBound(w, json, (body as { owner: string }).owner);
      },
    ), { numRuns: RUNS });
    console.log(`[coverage A] statuses ${JSON.stringify(seen)}`);
  }, TIMEOUT);

  it('A2: a well-formed swap is built bound to exactly its message, unsigned, fee within the cap, and nothing is sent', async () => {
    const w = await world();
    const seen: Record<string, number> = {};
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(WSOL_MINT, BONK), fc.bigInt({ min: 20_000n, max: 10n ** 9n }),
      fc.option(fc.bigInt({ min: 1n, max: 990_000_000n }), { nil: undefined }), fc.option(fc.constantFrom('0', '50', '10000'), { nil: undefined }),
      async (outputMint, amountIn, minOut, acceptCostBps) => {
        const body = { owner: w.W.address, inputMint: USDC, outputMint, amountIn: String(amountIn), ...(minOut ? { minOut: String(minOut) } : {}), ...(acceptCostBps ? { acceptCostBps } : {}) };
        const res = await agentPrepare(post('prepare', body), w.deps);
        const json = await res.json();
        const key = res.status === 200 ? '200' : `${res.status}:${json.error?.code}`;
        seen[key] = (seen[key] ?? 0) + 1;
        expect(ANSWERED.has(res.status), `${res.status} ${JSON.stringify(json).slice(0, 300)}`).toBe(true);
        expect(w.sent).toHaveLength(0);
        if (res.status === 200) await expectBound(w, json, w.W.address);
      },
    ), { numRuns: RUNS });
    console.log(`[coverage A2] ${JSON.stringify(seen)}`);
    // Not vacuous: most well-formed swaps are built.
    expect(seen['200'] ?? 0).toBeGreaterThan(RUNS / 2);
  }, TIMEOUT);

  it('H-01: whatever route a market offers, a 200 leaves nothing under E; a cashback account is refused, never built', async () => {
    const PUMP_RENT = 1_346_200n;
    const seen: Record<string, number> = {};
    await fc.assert(fc.asyncProperty(
      // Padding up to where the close stops fitting in v0 (about 7 to 10 accounts here), and beyond.
      // The fake chain recognises the close of the curve's account only, so a PumpSwap route with
      // rent fails closed (refused) here; the curve is where a 200 with rent is possible.
      fc.nat({ max: 12 }), fc.constantFrom(0n, PUMP_RENT, PUMP_RENT), fc.oneof({ weight: 3, arbitrary: fc.constant(0n) }, { weight: 1, arbitrary: fc.bigInt({ min: 1n, max: 10n ** 7n }) }),
      fc.bigInt({ min: 10_000_000n, max: 10n ** 9n }), fc.constantFrom(true, true, true, false),
      async (padding, takerRent, cashback, amountIn, curve) => {
        const extraAccounts = await Promise.all(Array.from({ length: padding }, async () => (await generateKeyPairSigner()).address));
        const jupiter = fakeJupiter({ label: curve ? 'Pump.fun' : 'Pump.fun Amm', curveProgram: curve, routeAccount: true, extraAccounts });
        const w = await world({ takerRent, cashback, jupiter, treasuryWallet: true });
        const res = await agentPrepare(post('prepare', { owner: w.W.address, inputMint: WSOL_MINT, outputMint: BONK, amountIn: String(amountIn) }), w.deps);
        const json = await res.json();
        const where = `pad=${padding} rent=${takerRent} cashback=${cashback} curve=${curve}: ${res.status} ${JSON.stringify(json.error ?? {}).slice(0, 250)}`;
        const key = res.status === 200 ? `200${takerRent ? '+rent' : ''}` : `${res.status}:${json.error?.code}`;
        seen[key] = (seen[key] ?? 0) + 1;
        expect(ANSWERED.has(res.status), where).toBe(true);
        expect(w.sent, where).toHaveLength(0);
        if (res.status !== 200) return;
        await expectBound(w, json, w.W.address);
        const t = lamportsSentToTaker(json.transaction);
        // What E holds at the end, as the chain would leave it: what W sent it, less what the market
        // took, plus what closing the market's account returns, less what E passes back to W.
        const held = takerRent > 0n ? takerRent + cashback : 0n;
        const left = t.lamports - takerRent + (t.closesRouteAccount ? held : 0n) - t.sentByTaker;
        expect(left, where).toBe(0n);
        if (takerRent > 0n) expect(t.closesRouteAccount, where).toBe(true);
        if (takerRent > 0n) expect(cashback, where).toBe(0n);
      },
    ), { numRuns: RUNS });
    console.log(`[coverage H-01] ${JSON.stringify(seen)}`);
    expect(seen['200+rent'] ?? 0).toBeGreaterThan(0);
  }, TIMEOUT);
});

// --- B: finalize with a changed ticket, message, signature, key or wire

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
type Tamper =
  | { kind: 'ticket-char'; at: number; to: number }
  | { kind: 'ticket-cut'; at: number }
  | { kind: 'ticket-field'; field: 'owner' | 'msg' | 'lvbh' | 'key' | 'nonce' | 'kid'; value: string }
  | { kind: 'ticket-other'; value: unknown }
  | { kind: 'message'; at: number; bit: number }
  | { kind: 'wallet-signature'; with: 'zeros' | 'random' | 'other-signer'; bytes: Uint8Array }
  | { kind: 'no-wallet-signature' }
  | { kind: 'other-key' }
  | { kind: 'junk'; bytes: Uint8Array }
  | { kind: 'wire'; at: number; bit: number };

const tamperArb: fc.Arbitrary<Tamper> = fc.oneof(
  fc.record({ kind: fc.constant('ticket-char' as const), at: fc.nat(), to: fc.nat({ max: 63 }) }),
  fc.record({ kind: fc.constant('ticket-cut' as const), at: fc.nat() }),
  fc.record({
    kind: fc.constant('ticket-field' as const), field: fc.constantFrom('owner', 'msg', 'lvbh', 'key', 'nonce', 'kid'),
    value: fc.oneof(fc.string({ maxLength: 70 }), fc.constantFrom('agent-two', '99999999999', '0'.repeat(64), 'f'.repeat(64))),
  }),
  fc.record({ kind: fc.constant('ticket-other' as const), value: fc.oneof(fc.constantFrom<unknown>('', '.', 'a.b', 'a.b.c', null, 1, 'x'.repeat(2_001)), fc.string()) }),
  fc.record({ kind: fc.constant('message' as const), at: fc.nat(), bit: fc.nat({ max: 7 }) }),
  fc.record({ kind: fc.constant('wallet-signature' as const), with: fc.constantFrom('zeros', 'random', 'other-signer'), bytes: fc.uint8Array({ minLength: 64, maxLength: 64 }) }),
  fc.constant({ kind: 'no-wallet-signature' as const }),
  fc.constant({ kind: 'other-key' as const }),
  fc.record({ kind: fc.constant('junk' as const), bytes: fc.uint8Array({ maxLength: 1_400 }) }),
  fc.record({ kind: fc.constant('wire' as const), at: fc.nat(), bit: fc.nat({ max: 7 }) }),
);

async function applyTamper(w: World, p: Prepared, honest: string, t: Tamper): Promise<{ ticket: unknown; signed: unknown; key: string }> {
  const tx = getTransactionDecoder().decode(fromB64(p.transaction));
  const encode = (x: Transaction) => b64(new Uint8Array(getTransactionEncoder().encode(x)));
  switch (t.kind) {
    case 'ticket-char': {
      const at = t.at % p.ticket.length;
      const to = B64URL[t.to] === p.ticket[at] ? B64URL[(t.to + 1) % 64] : B64URL[t.to];
      return { ticket: p.ticket.slice(0, at) + to + p.ticket.slice(at + 1), signed: honest, key: KEY };
    }
    case 'ticket-cut':
      return { ticket: p.ticket.slice(0, t.at % p.ticket.length), signed: honest, key: KEY };
    case 'ticket-field': {
      const [payload, mac] = p.ticket.split('.');
      const fields = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (fields[t.field] === t.value) return { ticket: p.ticket + 'x', signed: honest, key: KEY };
      fields[t.field] = t.value;
      return { ticket: `${Buffer.from(JSON.stringify(fields)).toString('base64url')}.${mac}`, signed: honest, key: KEY };
    }
    case 'ticket-other':
      return { ticket: t.value, signed: honest, key: KEY };
    case 'message': {
      // Built as raw bytes, with W's signature over the changed message in W's slot (the first: W
      // pays), so that even a message kit would refuse to encode (a version it does not know) reaches
      // the API.
      const bytes = fromB64(honest);
      const start = 1 + 64 * bytes[0];
      const message = bytes.subarray(start);
      message[t.at % message.length] ^= 1 << t.bit;
      bytes.set(new Uint8Array(await signBytes(w.W.keyPair.privateKey, message)), 1);
      return { ticket: p.ticket, signed: b64(bytes), key: KEY };
    }
    case 'wallet-signature': {
      const other = await generateKeyPairSigner();
      const bytes = t.with === 'zeros' ? new Uint8Array(64)
        : t.with === 'random' ? t.bytes
          : new Uint8Array(await signBytes(other.keyPair.privateKey, tx.messageBytes));
      return { ticket: p.ticket, signed: encode({ ...tx, signatures: { ...tx.signatures, [w.W.address]: bytes as SignatureBytes } }), key: KEY };
    }
    case 'no-wallet-signature':
      return { ticket: p.ticket, signed: p.transaction, key: KEY };
    case 'other-key':
      return { ticket: p.ticket, signed: honest, key: OTHER_KEY };
    case 'junk':
      return { ticket: p.ticket, signed: b64(t.bytes), key: KEY };
    case 'wire': {
      const bytes = fromB64(honest);
      bytes[t.at % bytes.length] ^= 1 << t.bit;
      return { ticket: p.ticket, signed: b64(bytes), key: KEY };
    }
  }
}

describe('B: finalize, with anything changed', () => {
  it('sends nothing for a changed ticket, message, signature or key; anything ever sent is the exact message, signed by W and E', async () => {
    const w = await world();
    const p = await prepareHonest(w);
    const honest = await signAsWallet(w.W, p.transaction);
    const seen: Record<string, number> = {};
    await fc.assert(fc.asyncProperty(tamperArb, async t => {
      const before = w.sent.length;
      const { ticket, signed, key } = await applyTamper(w, p, honest, t);
      const res = await finalize(w, ticket, signed, key);
      const text = await res.text();
      seen[`${t.kind}:${res.status}`] = (seen[`${t.kind}:${res.status}`] ?? 0) + 1;
      expect(ANSWERED.has(res.status), `${t.kind}: status ${res.status}: ${text.slice(0, 300)}`).toBe(true);
      const fresh = w.sent.slice(before);
      await expectCanonical(fresh, p);
      // Only a flip that leaves the message and W's signature intact (E's empty slot) can go out.
      if (t.kind !== 'wire') {
        expect(fresh, t.kind).toHaveLength(0);
        expect(res.status, `${t.kind}: ${text.slice(0, 300)}`).toBe(400);
      }
      if (res.status === 200) {
        expect(JSON.parse(text).signature).toBe(getSignatureFromTransaction(getTransactionDecoder().decode(fromB64(honest))));
      }
    }), { numRuns: RUNS * 4 });
    console.log(`[coverage B] ${JSON.stringify(seen)}`);
  }, TIMEOUT * 4);
});

// --- C: finalize, repeated, under faults

const sometimes = fc.constantFrom(false, false, false, true);
const stepArb = fc.record({
  statusFails: sometimes,
  send: fc.constantFrom<Chaos['send']>('ok', 'ok', 'preflight', 'http429', 'http503', 'network'),
  landOnSend: fc.boolean(),
  disabled: sometimes,
});

describe('C: finalize, repeated, whatever the network does', () => {
  it('one transaction per ticket; nothing sent once landed, while paused, or when the chain cannot be read; every refusal names it', async () => {
    const seen = { steps: 0, sends: 0, landedBefore: 0, statuses: {} as Record<number, number> };
    await fc.assert(fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 6 }), async steps => {
      const w = await world();
      const p = await prepareHonest(w);
      const honest = await signAsWallet(w.W, p.transaction);
      const signature = getSignatureFromTransaction(getTransactionDecoder().decode(fromB64(honest)));
      for (const [i, s] of steps.entries()) {
        Object.assign(w.chaos, { statusFails: s.statusFails, send: s.send, landOnSend: s.landOnSend });
        w.deps.disabled = s.disabled;
        const landed = w.statuses.has(signature);
        const before = w.sent.length;
        const res = await finalize(w, p.ticket, honest);
        const body = await res.json();
        const where = `step ${i} ${JSON.stringify(s)} landed=${landed}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`;
        expect(ANSWERED.has(res.status), where).toBe(true);
        const fresh = w.sent.length - before;
        seen.steps++; seen.sends += fresh; if (landed) seen.landedBefore++;
        seen.statuses[res.status] = (seen.statuses[res.status] ?? 0) + 1;
        if (s.statusFails) {
          expect(res.status, where).toBe(503);
          expect(fresh, where).toBe(0);
        }
        if (landed && !s.statusFails) {
          expect(fresh, where).toBe(0);
          expect(res.status, where).toBe(200);
          expect(body.status, where).toBe('sent');
        }
        if (s.disabled && !landed) expect(fresh, where).toBe(0);
        expect(fresh, where).toBeLessThanOrEqual(1);
        if (res.status === 200) expect(body.signature, where).toBe(signature);
        else expect(body.error.signature, where).toBe(signature);
      }
      // Every send of this ticket is the same transaction.
      expect(new Set(w.sent).size).toBeLessThanOrEqual(1);
      await expectCanonical(w.sent, p);
    }), { numRuns: RUNS });
    console.log(`[coverage C] ${JSON.stringify(seen)}`);
  }, TIMEOUT);
});

// --- D: secret rotation

describe('D: server secrets, rotated', () => {
  it('a ticket opens with any listed secret that sealed it, and with no other', async () => {
    await fc.assert(fc.asyncProperty(
      fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.nat({ max: 2 }),
      async (a, b, layout) => {
        fc.pre(sha(a) !== sha(b));
        const w = await world({ secrets: [a] });
        const p = await prepareHonest(w);
        const honest = await signAsWallet(w.W, p.transaction);
        // 0: rotated in front of it; 1: rotated in behind it; 2: removed.
        w.deps.secrets = layout === 0 ? [b, a] : layout === 1 ? [a, b] : [b];
        const res = await finalize(w, p.ticket, honest);
        if (layout === 2) {
          expect(res.status).toBe(400);
          expect((await res.json()).error.code).toBe('invalid-ticket');
          expect(w.sent).toHaveLength(0);
        } else {
          expect(res.status).toBe(200);
          await expectCanonical(w.sent, p);
        }
        // A ticket sealed now under another secret with the same fields is not this one.
        const opened = await openTicket([a], p.ticket);
        const forged = await sealTicket(b, opened!.ticket);
        w.deps.secrets = [a];
        expect((await finalize(w, forged, honest)).status).toBe(400);
      },
    ), { numRuns: Math.max(5, Math.floor(RUNS / 2)) });
  }, TIMEOUT);
});

// --- E: the skill

/** The skill as an agent runs it, against the handlers above, on a chain it reads itself. */
async function agentWorld(opts: { lands: boolean }) {
  const w = await world();
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const req = new Request(url, init);
    return url.endsWith('/api/v1/prepare') ? agentPrepare(req, w.deps) : agentFinalize(req, w.deps);
  }) as unknown as typeof fetch;
  // The agent's RPC: the same chain; with `lands`, the transaction shows confirmed once it was sent,
  // otherwise nothing ever shows up and the height never passes its lifetime (outcome unknown).
  const agentRpc = {
    ...(w.deps.rpc as object),
    getBlockHeight: () => ({ send: async () => 1n }),
    getSignatureStatuses: (sigs: string[]) => ({
      send: async () => ({
        context: { slot: 300_000_000n },
        value: sigs.map(s => opts.lands && w.sent.some(x => getSignatureFromTransaction(getTransactionDecoder().decode(fromB64(x))) === s)
          ? { confirmationStatus: 'confirmed', err: null, slot: 300_000_000n } : null),
      }),
    }),
    getEpochInfo: () => ({ send: async () => ({ absoluteSlot: 300_000_000n, blockHeight: 1n }) }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { ...w, fetchImpl, agentRpc };
}
const intent = { inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', minOut: '1', treasury: TREASURY };

describe('E: the skill, one worker, one swap, the chain first', () => {
  it('M-01: at most one worker holds a wallet\'s lock; a worker taken over never frees its successor\'s', () => {
    type Op = { op: 'acquire' | 'release' | 'age'; worker: number };
    fc.assert(fc.property(
      fc.array(fc.record({ op: fc.constantFrom<Op['op']>('acquire', 'acquire', 'release', 'age'), worker: fc.nat({ max: 3 }) }), { maxLength: 30 }),
      ops => {
        const dir = mkdtempSync(join(tmpdir(), 'bound-fuzz-lock-'));
        const release: (null | (() => void))[] = [null, null, null, null];
        let holder: number | null = null;
        let aged = false;
        for (const [i, { op, worker }] of ops.entries()) {
          const where = `op ${i} ${op}(${worker}) holder=${holder} aged=${aged}`;
          if (op === 'age') {
            if (holder === null) continue;
            const old = new Date(Date.now() - 3_600_000);
            utimesSync(join(dir, 'lock-wallet'), old, old);
            aged = true;
          } else if (op === 'release') {
            const r = release[worker];
            if (!r) continue;
            r();
            release[worker] = null;
            if (holder === worker) {
              holder = null;
              aged = false;
            }
          } else {
            if (release[worker]) continue;
            const expected = holder === null || aged;
            let got = true;
            try {
              release[worker] = acquireLock(dir, 'wallet', 60_000);
            } catch {
              got = false;
            }
            expect(got, where).toBe(expected);
            if (got) {
              holder = worker;
              aged = false;
            }
          }
        }
      },
    ), { numRuns: RUNS * 8 });
  }, TIMEOUT);

  it('H-02: swaps from one wallet started together send at most one transaction, and none while one is pending', async () => {
    const h02: Record<string, number> = {};
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ delayMs: fc.nat({ max: 5 }), id: fc.option(fc.constantFrom('a', 'b'), { nil: undefined }) }), { minLength: 2, maxLength: 4 }),
      async runs => {
        const a = await agentWorld({ lands: false });
        const store = createFileStore(mkdtempSync(join(tmpdir(), 'bound-fuzz-h02-')));
        const results = await Promise.allSettled(runs.map(async r => {
          await new Promise(res => setTimeout(res, r.delayMs));
          return protectedSwap({
            apiUrl: 'http://bound.test', apiKey: KEY, rpc: a.agentRpc, wallet: a.W, fetchImpl: a.fetchImpl, pollMs: 1, maxWaitMs: 40,
            intent: { ...intent, ...(r.id ? { id: r.id } : {}) }, pending: store, orders: store,
          });
        }));
        const where = JSON.stringify(results.map(r => r.status === 'fulfilled' ? r.value.outcome : (r.reason as Error).constructor.name));
        h02[where] = (h02[where] ?? 0) + 1;
        // The agent re-broadcasts the same bytes while it waits: count transactions, not broadcasts.
        expect(new Set(a.sent.map(signatureOfWire)).size, where).toBeLessThanOrEqual(1);
        expect((await store.list()).length, where).toBeLessThanOrEqual(1);
        // A later swap from the wallet waits for whatever is still pending.
        const pendingNow = (await store.list()).length;
        const before = new Set(a.sent.map(signatureOfWire)).size;
        const later = await protectedSwap({
          apiUrl: 'http://bound.test', apiKey: KEY, rpc: a.agentRpc, wallet: a.W, fetchImpl: a.fetchImpl, pollMs: 1, maxWaitMs: 40,
          intent, pending: store,
        }).then(() => 'done', (e: Error) => e.constructor.name);
        if (pendingNow) {
          expect(later, where).toBe('PendingSwapError');
          expect(new Set(a.sent.map(signatureOfWire)).size, where).toBe(before);
        }
      },
    ), { numRuns: Math.max(5, Math.floor(RUNS / 2)) });
    console.log(`[coverage H-02] ${JSON.stringify(h02)}`);
  }, TIMEOUT);

  // Mostly nothing fails, so that swaps go out and what fails after them is exercised.
  it('M-02: whatever call never answers, a swap ends in time, sends at most one transaction, and never throws after one went out', async () => {
    const METHODS = ['getMultipleAccounts', 'simulateTransaction', 'getSignatureStatuses', 'getBlockHeight', 'getEpochInfo', 'sendTransaction', 'getLatestBlockhash'] as const;
    const seen: Record<string, number> = {};
    await fc.assert(fc.asyncProperty(
      // Mostly one silent call at a time, so that swaps get as far as sending and past it.
      fc.oneof({ weight: 1, arbitrary: fc.constant<string[]>([]) }, { weight: 3, arbitrary: fc.subarray([...METHODS], { maxLength: 1 }) }, { weight: 1, arbitrary: fc.subarray([...METHODS]) }),
      fc.constantFrom('none', 'none', 'prepare', 'finalize-before', 'finalize-after'), fc.boolean(),
      async (hung, bound, lands) => {
        const a = await agentWorld({ lands });
        // A call that never answers, as a transport that honours its abort signal: it ends only
        // when the caller gives up on it. Without a signal it would wait for ever.
        const never = (o?: { abortSignal?: AbortSignal }) => new Promise<never>((_, reject) =>
          o?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted: no answer'))));
        const rpc = new Proxy(a.agentRpc as unknown as Record<string, unknown>, {
          get: (target, name: string) => (hung as string[]).includes(name)
            ? () => ({ send: never })
            : target[name],
        }) as unknown as Rpc<SolanaRpcApi>;
        // Bound itself: no answer to prepare, no answer to finalize before or after it acted.
        const fetchImpl = (async (url: string, init: RequestInit) => {
          const signal = init.signal ?? undefined;
          const isPrepare = url.endsWith('/api/v1/prepare');
          if ((bound === 'prepare' && isPrepare) || (bound === 'finalize-before' && !isPrepare)) return never({ abortSignal: signal });
          const res = await a.fetchImpl(url, init);
          if (bound === 'finalize-after' && !isPrepare) return never({ abortSignal: signal });
          return res;
        }) as unknown as typeof fetch;
        const started = Date.now();
        const guard = new Promise<'hung'>(res => setTimeout(() => res('hung'), 15_000));
        const result = await Promise.race([
          protectedSwap({
            apiUrl: 'http://bound.test', apiKey: KEY, rpc, wallet: a.W, fetchImpl, pollMs: 1, maxWaitMs: 150, requestTimeoutMs: 40, intent,
          }).then(r => r, (e: Error) => e),
          guard,
        ]);
        const where = `hung=${JSON.stringify(hung)} bound=${bound} lands=${lands}: ${result instanceof Error ? result.message.slice(0, 200) : typeof result === 'string' ? result : result.outcome} after ${Date.now() - started} ms`;
        const kind = result instanceof Error ? 'threw' : typeof result === 'string' ? result : result.outcome;
        seen[kind] = (seen[kind] ?? 0) + 1;
        expect(result, where).not.toBe('hung');
        const transactions = new Set(a.sent.map(signatureOfWire)).size;
        expect(transactions, where).toBeLessThanOrEqual(1);
        if (result instanceof Error) expect(transactions, where).toBe(0);
      },
    ), { numRuns: RUNS });
    console.log(`[coverage M-02] ${JSON.stringify(seen)}`);
  }, TIMEOUT + RUNS * 15_000);

  const failAt = fc.oneof({ weight: 4, arbitrary: fc.constant<number[]>([]) }, { weight: 1, arbitrary: fc.subarray([0, 1, 2, 3]) });
  const faultsArb = fc.record({ put: failAt, remove: failAt, list: failAt, order: failAt, claimOrder: failAt, recordOrder: failAt });
  type Faults = { [K in keyof (PendingStore & OrderBook)]: number[] };
  const failing = (store: PendingStore & OrderBook, faults: Faults): PendingStore & OrderBook => {
    const calls: Record<string, number> = {};
    const wrap = <K extends keyof (PendingStore & OrderBook)>(name: K) => (async (...args: unknown[]) => {
      const k = (calls[name] = (calls[name] ?? -1) + 1);
      if (faults[name].includes(k)) throw new Error(`ENOSPC: ${name} #${k} failed`);
      return (store[name] as (...x: unknown[]) => unknown)(...args);
    }) as (PendingStore & OrderBook)[K];
    return { put: wrap('put'), remove: wrap('remove'), list: wrap('list'), order: wrap('order'), claimOrder: wrap('claimOrder'), recordOrder: wrap('recordOrder') };
  };

  it('M-03: whatever bookkeeping fails, a swap that went out is answered with its signature and outcome, never as not sent', async () => {
    const m03 = { cases: 0, wentOut: 0, withBookkeepingError: 0 };
    await fc.assert(fc.asyncProperty(faultsArb, fc.boolean(), async (faults, withId) => {
      m03.cases++;
      const a = await agentWorld({ lands: true });
      const store = failing(createFileStore(mkdtempSync(join(tmpdir(), 'bound-fuzz-m03-'))), faults);
      const result = await protectedSwap({
        apiUrl: 'http://bound.test', apiKey: KEY, rpc: a.agentRpc, wallet: a.W, fetchImpl: a.fetchImpl, pollMs: 1, maxWaitMs: 200,
        intent: { ...intent, ...(withId ? { id: 'order-1' } : {}) }, pending: store, orders: store,
      }).then(r => r, (e: Error) => e);
      const where = `${JSON.stringify(faults)} id=${withId}: ${result instanceof Error ? result.message : JSON.stringify({ ...result, prepared: undefined })}`;
      if (a.sent.length === 0) return; // stood down before anything went out: nothing to misreport
      m03.wentOut++;
      expect(result, where).not.toBeInstanceOf(Error);
      const r = result as Exclude<typeof result, Error>;
      if (r.bookkeepingError) m03.withBookkeepingError++;
      expect(r.signature, where).toBe(getSignatureFromTransaction(getTransactionDecoder().decode(fromB64(a.sent[0]))));
      expect(r.outcome, where).toBe('confirmed');
    }), { numRuns: RUNS });
    console.log(`[coverage M-03] ${JSON.stringify(m03)}`);
  }, TIMEOUT);

  it('M-03 (bound-verify): whatever bookkeeping fails, finalize of a swap that went out reports it, never sent: false', async () => {
    await fc.assert(fc.asyncProperty(faultsArb, async faults => {
      const a = await agentWorld({ lands: true });
      const stateDir = mkdtempSync(join(tmpdir(), 'bound-fuzz-m03-cli-'));
      const store = failing(createFileStore(stateDir), faults);
      const deps = { rpc: a.agentRpc, apiUrl: 'http://bound.test', apiKey: KEY, fetchImpl: a.fetchImpl, stateDir, treasury: TREASURY, pollMs: 1, maxWaitMs: 200, store };
      // A prepare that throws (property E5) has sent nothing, which is all this property asks of it.
      const ready = await runCli('prepare', { intent: { owner: a.W.address, ...intent } }, deps).catch(() => null);
      if (!ready || ready.code !== 0) {
        expect(a.sent).toHaveLength(0);
        return;
      }
      const out = JSON.parse(JSON.stringify(ready.output)) as { checked: unknown; message: string };
      const signature = getBase58Decoder().decode(await signBytes(a.W.keyPair.privateKey, fromB64(out.message)));
      const done = await runCli('finalize', { checked: out.checked, signature }, deps).catch((e: Error) => ({ code: -1, output: { thrown: e.message } as Record<string, unknown> }));
      const where = `${JSON.stringify(faults)}: ${JSON.stringify(done)}`;
      if (a.sent.length === 0) {
        expect(done.code, where).not.toBe(0);
        return;
      }
      expect(done.output.sent, where).not.toBe(false);
      expect(done.output.signature, where).toBe(signature);
      expect(done.output.outcome, where).toBe('confirmed');
    }), { numRuns: RUNS });
  }, TIMEOUT);

  it('E5 (bound-verify): every command answers with a result a bot can read, whatever the store does', async () => {
    await fc.assert(fc.asyncProperty(faultsArb, fc.constantFrom('prepare', 'recover'), async (faults, command) => {
      const a = await agentWorld({ lands: true });
      const stateDir = mkdtempSync(join(tmpdir(), 'bound-fuzz-e5-'));
      const store = failing(createFileStore(stateDir), faults);
      const deps = { rpc: a.agentRpc, apiUrl: 'http://bound.test', apiKey: KEY, fetchImpl: a.fetchImpl, stateDir, treasury: TREASURY, pollMs: 1, maxWaitMs: 50, store };
      const r = await runCli(command, { intent: { owner: a.W.address, ...intent, id: 'order-1' } }, deps)
        .then(x => x, (e: Error) => `threw: ${e.message}`);
      expect(typeof r, `${command} ${JSON.stringify(faults)}: ${String(r)}`).toBe('object');
      expect(a.sent).toHaveLength(0);
    }), { numRuns: RUNS });
  }, TIMEOUT);
});

describe('F: file-system faults, the same on every commit', () => {
  it('M-03 (bound-verify): the disk refusing to remove the record after the swap confirmed is never "not sent"', async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async withId => {
      const a = await agentWorld({ lands: true });
      const stateDir = mkdtempSync(join(tmpdir(), 'bound-fuzz-f-m03-'));
      const deps = { rpc: a.agentRpc, apiUrl: 'http://bound.test', apiKey: KEY, fetchImpl: a.fetchImpl, stateDir, treasury: TREASURY, pollMs: 1, maxWaitMs: 200 };
      const ready = await runCli('prepare', { intent: { owner: a.W.address, ...intent, ...(withId ? { id: 'order-f' } : {}) } }, deps);
      expect(ready.code).toBe(0);
      const out = JSON.parse(JSON.stringify(ready.output)) as { checked: unknown; message: string };
      const signature = getBase58Decoder().decode(await signBytes(a.W.keyPair.privateKey, fromB64(out.message)));
      fsFaults.rmPending = true;
      const done = await runCli('finalize', { checked: out.checked, signature }, deps)
        .catch((e: Error) => ({ code: -1, output: { thrown: e.message } as Record<string, unknown> }))
        .finally(() => { fsFaults.rmPending = false; });
      const where = JSON.stringify(done);
      expect(a.sent.length, where).toBeGreaterThan(0);
      expect(done.output.sent, where).not.toBe(false);
      expect(done.output.signature, where).toBe(signature);
      expect(done.output.outcome, where).toBe('confirmed');
    }), { numRuns: 4 });
  }, TIMEOUT);

  it('E5 (bound-verify): prepare and recover answer with a result, not an exception, when the state directory cannot be read', async () => {
    for (const command of ['prepare', 'recover']) {
      const a = await agentWorld({ lands: true });
      const stateDir = mkdtempSync(join(tmpdir(), 'bound-fuzz-f-e5-'));
      const deps = { rpc: a.agentRpc, apiUrl: 'http://bound.test', apiKey: KEY, fetchImpl: a.fetchImpl, stateDir, treasury: TREASURY, pollMs: 1, maxWaitMs: 50 };
      fsFaults.readdir = true;
      const r = await runCli(command, { intent: { owner: a.W.address, ...intent } }, deps)
        .then(x => x, (e: Error) => `threw: ${e.message}`)
        .finally(() => { fsFaults.readdir = false; });
      expect(typeof r, `${command}: ${String(r)}`).toBe('object');
      expect(a.sent).toHaveLength(0);
    }
  }, TIMEOUT);
});
