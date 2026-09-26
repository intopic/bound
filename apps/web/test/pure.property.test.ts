/**
 * The small functions every channel leans on, fuzzed by the million:
 * - the page's slippage setting: what a person types, and what is kept and for how long;
 * - the API key's message and seal: any change refuses it;
 * - what arrived, and how it is said against the quote.
 *
 * `npm run test:fuzz` runs 500,000 cases per property; ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set a shard.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { generateKeyPairSigner } from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { isChoice, loadSlippage, parsePercent, percentText, saveSlippage, WARN_ABOVE_BPS } from '../lib/client/slippage.ts';
import type { SlippageChoice } from '../lib/client/slippage.ts';
import { fillAgainstQuote } from '../lib/client/received.ts';
import { issueKey, newChallenge, openKey } from '../lib/server/agent/keys.ts';
import { isApiKeyMessage, receivedFor } from '../../../skills/orientim-protected-swap/examples/swap.ts';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 500_000 : 2_000));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const TIMEOUT = 60_000 + RUNS * 2;

const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

describe('the slippage a person may choose', () => {
  it('reads back every tolerance it can show, and nothing outside 0.1% to 15%', () => {
    fc.assert(fc.property(fc.integer({ min: -100, max: 20_000 }), bps => {
      const read = parsePercent(percentText(bps));
      expect(read).toBe(bps >= 10 && bps <= 1_500 ? bps : null);
    }), PARAMS);
  }, TIMEOUT);

  it('turns any text into a valid choice or nothing, never into something else', () => {
    fc.assert(fc.property(fc.string({ maxLength: 12 }), text => {
      const read = parsePercent(text);
      expect(read === null || isChoice(read)).toBe(true);
    }), PARAMS);
  }, TIMEOUT);

  it('keeps the last choice; one above 5% only for the visit, then the last lasting one', () => {
    const choice = fc.oneof(fc.constant<SlippageChoice>('auto'), fc.integer({ min: 10, max: 1_500 }));
    fc.assert(fc.property(fc.array(choice, { minLength: 1, maxLength: 6 }), choices => {
      const local = store();
      const session = store();
      for (const c of choices) saveSlippage(c, { local, session });
      const last = choices[choices.length - 1];
      expect(loadSlippage({ local, session })).toBe(last);
      const lasting = [...choices].reverse().find(c => c === 'auto' || c <= WARN_ABOVE_BPS) ?? 'auto';
      expect(loadSlippage({ local, session: store() })).toBe(lasting);
    }), PARAMS);
  }, TIMEOUT);
});

describe('the API key', () => {
  it("refuses any change to the first four lines of Orientim's key message", async () => {
    const W = (await generateKeyPairSigner()).address;
    const { message } = await newChallenge(new Uint8Array(32).fill(1), { domain: 'orientim.com', uri: 'https://orientim.com/docs#access', wallet: W, now: 1_790_000_000 });
    expect(isApiKeyMessage(message, 'https://orientim.com', W)).toBe(true);
    const head = message.split('\n').slice(0, 4).join('\n').length;
    fc.assert(fc.property(fc.nat({ max: head - 1 }), fc.string({ minLength: 1, maxLength: 3 }), fc.constantFrom('replace', 'insert', 'delete'), (at, text, how) => {
      const changed = how === 'replace' ? message.slice(0, at) + text + message.slice(at + 1)
        : how === 'insert' ? message.slice(0, at) + text + message.slice(at)
          : message.slice(0, at) + message.slice(at + 1);
      if (changed === message) return;
      expect(isApiKeyMessage(changed, 'https://orientim.com', W)).toBe(false);
    }), PARAMS);
  }, TIMEOUT);

  it('opens a key only as Orientim sealed it: any changed character closes it', async () => {
    const W = (await generateKeyPairSigner()).address;
    const secret = new Uint8Array(32).fill(7);
    const { key } = await issueKey(secret, W, 1_790_000_000);
    expect(await openKey([secret], key, 1_790_000_001)).toEqual({ id: `w:${W}`, wallet: W });
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.';
    await fc.assert(fc.asyncProperty(fc.nat({ max: key.length - 1 }), fc.nat({ max: alphabet.length - 1 }), async (at, pick) => {
      const changed = key.slice(0, at) + alphabet[pick] + key.slice(at + 1);
      if (changed === key) return;
      expect(await openKey([secret], changed, 1_790_000_001)).toBeNull();
    }), { ...PARAMS, numRuns: Math.max(1, Math.floor(RUNS / 5)) });
  }, TIMEOUT);
});

describe('what arrived', () => {
  it('says a fill against the quote only when it is better, or well below and within the tolerance', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), fc.bigInt({ min: 1n, max: 10n ** 18n }), fc.constantFrom('', '1%', '10%'), (received, expected, tolerance) => {
      const said = fillAgainstQuote(received, expected, tolerance);
      const bps = Number(((received - expected) * 10_000n) / expected);
      if (bps >= 5) expect(said).toMatch(/ better than quoted\.$/);
      else if (bps <= -100 && tolerance) expect(said).toBe(`Filled ${(Math.abs(bps) / 100).toFixed(Math.abs(bps) < 100 ? 2 : 1)}% below the quote, within your ${tolerance} tolerance.`);
      else expect(said).toBe('');
    }), PARAMS);
  }, TIMEOUT);

  it('reads a token received as what the wallet gained, from any balances before and after', async () => {
    const W = (await generateKeyPairSigner()).address;
    const mintOut = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    await fc.assert(fc.asyncProperty(fc.option(fc.bigInt({ min: 0n, max: 10n ** 15n }), { nil: undefined }), fc.bigInt({ min: 0n, max: 10n ** 15n }), async (before, gained) => {
      const after = (before ?? 0n) + gained;
      const meta = {
        fee: 5_000, preBalances: [], postBalances: [],
        preTokenBalances: before === undefined ? [] : [{ accountIndex: 2, mint: mintOut, owner: W, uiTokenAmount: { amount: before.toString() } }],
        postTokenBalances: [{ accountIndex: 2, mint: mintOut, owner: W, uiTokenAmount: { amount: after.toString() } }],
      };
      const rpc = { getTransaction: () => ({ send: async () => ({ meta }) }) } as unknown as Rpc<SolanaRpcApi>;
      const got = await receivedFor(rpc, 'sig', { wallet: W, certificate: { output: { mint: mintOut } } as never, costs: { networkFeeLamports: '0', outputAccountRentLamports: '0', routeRentLamports: '0', routeRefundLamports: '0' } });
      expect(got).toBe(gained);
    }), { ...PARAMS, numRuns: Math.max(1, Math.floor(RUNS / 5)) });
  }, TIMEOUT);
});
