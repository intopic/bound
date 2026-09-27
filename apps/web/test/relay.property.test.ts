/**
 * What the site's server does with what it is sent, fuzzed:
 * - a failure report never names a wallet, a transaction or an amount, whatever the page sends;
 * - the RPC relay with a backup picks the answer the rule says, for every mix of answers from the
 *   main RPC and the backup, for reads and for sends;
 * - an amount as the success message shows it is never more than what arrived, and short of it by
 *   less than its last shown digit.
 *
 * `npm run test:fuzz` runs 200,000 cases per property; ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set a shard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { getBase64EncodedWireTransaction } from '@solana/kit';
import { compileProtectedSwap } from '@orientim/core';
import { cleanReport, receiveReport, redact } from '../lib/server/report.ts';
import { proxyRpc } from '../lib/server/rpcProxy.ts';
import { formatExact, formatUnits } from '../lib/client/format.ts';
import { LIFETIME, scenario } from '../../../packages/verifier/test/fixtures.ts';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 200_000 : 1_000));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const TIMEOUT = 60_000 + RUNS * 2;

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58 = (min: number, max: number) =>
  fc.array(fc.constantFrom(...BASE58.split('')), { minLength: min, maxLength: max }).map(a => a.join(''));

/** A number in the forms a message may carry it: 12, 0.5, 1,000, 1 000, 1_000, 1e9, 0.000001. */
const number = fc.oneof(
  fc.bigInt({ min: 0n, max: 10n ** 20n }).map(String),
  fc.tuple(fc.nat(), fc.nat()).map(([a, b]) => `${a}.${b}`),
  fc.tuple(fc.integer({ min: 1, max: 999 }), fc.array(fc.integer({ min: 0, max: 999 }), { minLength: 1, maxLength: 4 }), fc.constantFrom(',', ' ', '_', "'", ' ', ' '))
    .map(([h, rest, sep]) => [String(h), ...rest.map(r => String(r).padStart(3, '0'))].join(sep)),
  fc.tuple(fc.nat(), fc.integer({ min: -30, max: 30 })).map(([a, e]) => `${a}e${e}`),
);

/** Text a page might send: words, addresses and signatures, numbers, hex error codes, control characters. */
const piece = fc.oneof(
  fc.constantFrom('Your wallet has ', ' SOL', ' USDC', 'custom program error: ', ' lamports', ' at ', 'R', ' → ', ':', '\n', '\u0000', '\u007f', ' '),
  base58(32, 88),
  number,
  fc.array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 1, maxLength: 6 }).map(h => `0x${h.join('')}`),
  fc.string({ maxLength: 8 }),
);
const text = fc.array(piece, { maxLength: 14 }).map(p => p.join(''));

/**
 * No decimal digit is left, other than in a hex literal (a program's error code), which is kept
 * whole, or cut to its "0x" by a field's length.
 */
const digitsOutsideHex = (s: string) => /\d/.test(s.replace(/0x[0-9a-f]*/gi, ''));
const LONG_BASE58 = /[1-9A-HJ-NP-Za-km-z]{32,}/;

describe('a failure report, fuzzed', () => {
  it('redact leaves no address, signature or decimal number, and no control character', () => {
    fc.assert(fc.property(text, s => {
      const out = redact(s);
      expect(out).not.toMatch(LONG_BASE58);
      expect(digitsOutsideHex(out)).toBe(false);
      expect(out).not.toMatch(/[\u0000-\u001f\u007f]/);
    }), PARAMS);
  }, TIMEOUT);

  it('cleanReport keeps only known fields, each redacted and within its length; the wallet name keeps its version', () => {
    const MAX = { title: 200, body: 400, detail: 600, pair: 60, wallet: 60, kind: 10 } as const;
    const raw = fc.record({
      title: text, body: text, detail: text, pair: text, wallet: text, kind: text,
      owner: base58(32, 44), signature: base58(64, 88), amount: number,
    }, { requiredKeys: [] });
    fc.assert(fc.property(raw, r => {
      const out = cleanReport(r);
      if (!out) {
        expect(r.title ? redact(r.title).slice(0, MAX.title) : '').toBe('');
        return;
      }
      for (const [k, v] of Object.entries(out)) {
        expect(Object.keys(MAX)).toContain(k);
        expect(v.length).toBeLessThanOrEqual(MAX[k as keyof typeof MAX]);
        expect(v).not.toMatch(LONG_BASE58);
        // Every field but the wallet's name is the redacted text (checked above), cut to its length.
        const input = (r as Record<string, string>)[k]!;
        if (k !== 'wallet') expect(v).toBe(redact(input).slice(0, MAX[k as keyof typeof MAX]));
      }
      expect(JSON.stringify(out)).not.toContain(r.owner ?? '\u0001');
    }), PARAMS);
  }, TIMEOUT);

  it('what is logged from any body carries no address from it', async () => {
    let n = 0;
    await fc.assert(fc.asyncProperty(fc.record({ title: text, detail: text, wallet: text }), fc.boolean(), async (r, asJson) => {
      const lines: string[] = [];
      const req = new Request('http://orientim.test/api/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vercel-forwarded-for': `203.0.113.${++n % 250}-report-${n}` },
        body: asJson ? JSON.stringify(r) : `${r.title}{`,
      });
      const res = await receiveReport(req, l => lines.push(l));
      expect([204, 400]).toContain(res.status);
      expect(lines.length).toBeLessThanOrEqual(1);
      for (const l of lines) expect(JSON.parse(l).type).toBe('orientim-problem');
      for (const l of lines) for (const v of Object.values(JSON.parse(l) as Record<string, string>)) expect(v).not.toMatch(LONG_BASE58);
    }), { ...PARAMS, numRuns: Math.min(RUNS, 50_000) });
  }, TIMEOUT);
});

const MAIN = 'https://main.rpc.test/';
const BACKUP = 'https://backup.rpc.test/';

/** What one RPC does with a request. */
type Upstream = 'result' | 'rpc-error' | 'down' | '429' | '5xx';
const upstream = fc.constantFrom<Upstream>('result', 'rpc-error', 'down', '429', '5xx');
const answered = (u: Upstream) => u !== 'down';
const outage = (u: Upstream) => u === 'down' || u === '429' || u === '5xx';

function respond(u: Upstream, who: 'main' | 'backup'): Response {
  switch (u) {
    case 'result': return Response.json({ jsonrpc: '2.0', id: 1, result: who });
    case 'rpc-error': return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: `refused by ${who}` } });
    case '429': return new Response(`busy ${who}`, { status: 429 });
    case '5xx': return new Response(`failing ${who}`, { status: 503 });
    case 'down': throw new TypeError('fetch failed');
  }
}

/**
 * The rule, written out: the backup is asked when the main RPC is down, rate-limited or failing. A
 * read takes the backup's answer unless the backup is itself rate-limited or failing while the main
 * one answered; a send takes it only when it is a result. With no answer at all, 504.
 */
function expected(send: boolean, main: Upstream, backup: Upstream): { from: 'main' | 'backup' | 'none'; asked: string[] } {
  if (!outage(main)) return { from: 'main', asked: ['main'] };
  const asked = ['main', 'backup'];
  const takeBackup = send
    ? backup === 'result'
    : answered(backup) && (!answered(main) || !outage(backup));
  if (takeBackup) return { from: 'backup', asked };
  return { from: answered(main) ? 'main' : 'none', asked };
}

afterEach(() => vi.unstubAllGlobals());

describe('the RPC relay with a backup, fuzzed', () => {
  it('returns the answer the rule picks, for every mix of answers, for reads and sends', async () => {
    const s = await scenario();
    const { transaction } = compileProtectedSwap({
      policy: s.policy, swapInstruction: s.swapIx, intermediates: s.intermediates, version: 0, lifetime: LIFETIME,
      computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n, lookupTables: s.lookupTables, outputBalanceBefore: s.wOutBalance,
    });
    const sendParams = [getBase64EncodedWireTransaction(transaction), { encoding: 'base64' }];
    let n = 0;
    await fc.assert(fc.asyncProperty(fc.boolean(), upstream, upstream, fc.boolean(), async (send, main, backup, withBackup) => {
      const asked: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
        const u = String(url instanceof Request ? url.url : url);
        const who = u.startsWith(MAIN) ? 'main' : 'backup';
        asked.push(who);
        return respond(who === 'main' ? main : backup, who);
      }));
      n++;
      // A fresh client each time, so the relay's per-client limits never decide the case.
      const req = new Request('http://orientim.test/api/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vercel-forwarded-for': `198.51.100.${n % 250}-relay-${n}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: send ? 'sendTransaction' : 'getBalance', params: send ? sendParams : [] }),
      });
      const res = await proxyRpc(req, MAIN, withBackup ? BACKUP : null);
      const want = withBackup ? expected(send, main, backup) : { from: answered(main) ? 'main' : 'none', asked: ['main'] };
      expect(asked).toEqual(want.asked);
      if (want.from === 'none') {
        expect(res.status).toBe(504);
        // Never "not forwarded": the request may have reached an RPC before the connection failed.
        expect(res.headers.get('x-orientim-not-forwarded')).toBeNull();
        return;
      }
      const body = await res.text();
      expect(body).toContain(want.from);
      expect(body).not.toContain(want.from === 'main' ? 'backup' : 'main');
    }), { ...PARAMS, numRuns: Math.min(RUNS, 100_000) });
  }, TIMEOUT);
});

describe('an amount as the success message shows it, fuzzed', () => {
  it('is never more than what arrived, and short of it by less than one unit of its last shown digit', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), fc.integer({ min: 0, max: 18 }), (v, decimals) => {
      const shown = formatUnits(v, decimals);
      const exact = formatExact(v, decimals);
      if (shown.startsWith('<')) {
        // Too small to show: said as such, never as the smallest visible unit.
        expect(v > 0n && v < 10n ** BigInt(Math.max(0, decimals - 6))).toBe(true);
        return;
      }
      const units = (t: string) => {
        const [w, f = ''] = t.replace(/,/g, '').split('.');
        return BigInt(w!) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
      };
      expect(units(exact)).toBe(v);
      const s = units(shown);
      expect(s).toBeLessThanOrEqual(v);
      expect(v - s).toBeLessThan(10n ** BigInt(Math.max(0, decimals - 6)));
    }), PARAMS);
  }, TIMEOUT);
});
