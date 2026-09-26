/**
 * The plugin, fuzzed: whole-token amounts by the million, and the tool a model calls, with any
 * tolerance, amount and token a model may send, against Orientim's real API handlers and a fake chain.
 * The tool never throws. It swaps once exactly when the input is valid and the tolerance is within the
 * owner's limit; otherwise it says why, and nothing is sent.
 *
 * `npm run test:fuzz` in this folder (vitest --mode fuzz): 1,000,000 amounts and 10,000 tool calls;
 * ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set a shard.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { address } from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { Keypair } from '@solana/web3.js';
import { KeypairWallet, SolanaAgentKit } from 'solana-agent-kit';
import { ataOf, WSOL_MINT } from '@orientim/core';
import { BONK, DEX, fakeJupiter, fakeRpc, fundedAccounts, mint, POOL, tokenAccount, USDC } from '../../../packages/jupiter/test/fakes.ts';
import type { Account } from '../../../packages/jupiter/test/fakes.ts';
import { agentFinalize, agentPrepare } from '../../../apps/web/lib/server/agent/api.ts';
import type { AgentDeps } from '../../../apps/web/lib/server/agent/api.ts';
import { ORIENTIM_TREASURY } from '../../../skills/orientim-protected-swap/lib/orientim-verify.mjs';
import { createOrientimPlugin, fromBaseUnits, SOL_MINT, toBaseUnits } from '../src/index.ts';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 1_000_000 : 3_000));
const TOOL_RUNS = Number(process.env.ORIENTIM_FUZZ_TOOL_RUNS ?? (MODE === 'fuzz' ? 10_000 : 30));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const withSeed = (numRuns: number) => ({ numRuns, ...(SEED !== undefined ? { seed: SEED } : {}) });

const KEY = 'ori_plugin_fuzz_key_000000000001';
const TREASURY = address(ORIENTIM_TREASURY);

/** Base units from a decimal string, exactly, as a fraction: value × 10^scale. */
const exact = (text: string) => {
  const [whole, frac = ''] = text.split('.');
  return { units: BigInt(whole + frac), scale: frac.length };
};

describe('whole tokens and base units, fuzzed', () => {
  const decimal = fc.tuple(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.option(fc.stringMatching(/^\d{1,14}$/), { nil: undefined }))
    .map(([w, f]) => (f === undefined ? w.toString() : `${w}.${f}`));

  it('rounds what is paid down and a minimum up, never by more than one base unit', () => {
    fc.assert(fc.property(decimal, fc.integer({ min: 0, max: 12 }), (text, decimals) => {
      const { units, scale } = exact(text);
      // The amount in base units, times 10^scale, to compare without rounding.
      const scaled = units * 10n ** BigInt(decimals);
      const unit = 10n ** BigInt(scale);
      let down: bigint | null = null;
      let up: bigint | null = null;
      try { down = toBaseUnits(text, decimals, 'down'); } catch { down = null; }
      try { up = toBaseUnits(text, decimals, 'up'); } catch { up = null; }
      if (down !== null) {
        expect(down * unit <= scaled && scaled < (down + 1n) * unit).toBe(true);
      } else {
        // Refused only when nothing is left: below the token's smallest unit, or zero.
        expect(scaled < unit).toBe(true);
      }
      if (up !== null) {
        expect(up * unit >= scaled && (up - 1n) * unit < scaled).toBe(true);
        if (down !== null) expect(up - down <= 1n).toBe(true);
      } else {
        expect(units).toBe(0n);
      }
    }), withSeed(RUNS));
  }, 60_000 + RUNS / 4);

  it('reads back every amount it writes', () => {
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 10n ** 20n }), fc.integer({ min: 0, max: 12 }), (units, decimals) => {
      const text = fromBaseUnits(units, decimals);
      expect(toBaseUnits(text, decimals)).toBe(units);
      expect(toBaseUnits(text, decimals, 'up')).toBe(units);
    }), withSeed(RUNS));
  }, 60_000 + RUNS / 4);
});

describe('the tool a model calls, fuzzed', () => {
  async function agent() {
    const kp = Keypair.generate();
    const owner = kp.publicKey.toBase58();
    const accounts = new Map<string, Account>([
      [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
      [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
      [POOL, { owner: DEX, data: new Uint8Array(300) }],
      [await ataOf(TREASURY, USDC), tokenAccount(TREASURY, USDC)],
      ...await fundedAccounts(address(owner), USDC),
    ]);
    const sent: string[] = [];
    const rpc = fakeRpc(accounts, { sent });
    const deps: AgentDeps = {
      rpc, jupiter: fakeJupiter(), secrets: [new Uint8Array(32).fill(3)],
      keys: new Map([[createHash('sha256').update(KEY).digest('hex'), 'fuzz']]),
      feeBps: 30n, treasury: TREASURY, excludeDexes: [], maxNetworkFeeLamports: 200_000n, disabled: false, v1: false, perMinute: 1_000_000,
    };
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://api.jup.ag/')) {
        const q = new URL(url).searchParams;
        return Response.json(await fakeJupiter().build({
          inputMint: address(q.get('inputMint')!), outputMint: address(q.get('outputMint')!), amount: BigInt(q.get('amount')!),
          taker: address(q.get('taker')!), slippageBps: Number(q.get('slippageBps')), maxAccounts: Number(q.get('maxAccounts')),
        }));
      }
      const req = new Request(url, init);
      return url.endsWith('/api/v1/prepare') ? agentPrepare(req, deps) : agentFinalize(req, deps);
    }) as typeof fetch;
    const agentRpc = {
      ...rpc, getSignatureStatuses: () => ({ send: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }) }),
    } as unknown as Rpc<SolanaRpcApi>;
    const plugin = createOrientimPlugin({ apiUrl: 'http://orientim.test', rpc: agentRpc, fetchImpl, pollMs: 1, acceptInMemoryState: true });
    const a = new SolanaAgentKit(new KeypairWallet(kp, 'http://127.0.0.1:1'), 'http://127.0.0.1:1', { OTHER_API_KEYS: { ORIENTIM_API_KEY: KEY } }).use(plugin);
    return { a, sent };
  }

  it('never throws, swaps once exactly for a valid input within the limit, and sends nothing otherwise', async () => {
    const tolerance = fc.oneof(fc.constant(undefined), fc.constant(null), fc.integer({ min: -50, max: 3_000 }), fc.double({ min: -10, max: 3_000, noNaN: true }));
    const amount = fc.oneof(fc.double({ min: -5, max: 1_000, noNaN: true }), fc.constantFrom(0, 1e-7, 0.000001, 1, 25.5), fc.constant(Number.NaN));
    const output = fc.constantFrom<string>(SOL_MINT, SOL_MINT, SOL_MINT, USDC, 'not-a-mint', '11111111111111111111111111111111');
    await fc.assert(fc.asyncProperty(tolerance, amount, output, async (slippageBps, inputAmount, outputMint) => {
      const { a, sent } = await agent();
      const input: Record<string, unknown> = { outputMint, inputMint: USDC, inputAmount };
      if (slippageBps !== undefined) input.slippageBps = slippageBps;
      const r = await a.actions[0].handler(a, input);
      expect(['success', 'error']).toContain(r.status);
      expect(typeof r.message).toBe('string');
      let units = 0n;
      try { units = toBaseUnits(inputAmount, 6); } catch { units = 0n; }
      const tolerable = slippageBps === undefined || slippageBps === null || (Number.isInteger(slippageBps) && slippageBps >= 10 && slippageBps <= 500);
      const invalid = !tolerable || !Number.isFinite(inputAmount) || inputAmount <= 0 || units === 0n || outputMint !== SOL_MINT;
      // From 0.01 USDC a swap always carries its fee; below, Orientim may refuse it as too small.
      const valid = !invalid && units >= 10_000n;
      if (invalid) expect(r.status).toBe('error');
      if (valid) expect(r.status).toBe('success');
      // Whatever it said, it sent exactly what it said it did.
      expect(new Set(sent).size).toBe(r.status === 'success' ? 1 : 0);
    }), withSeed(TOOL_RUNS));
  }, 60_000 + TOOL_RUNS * 600);
});
