/**
 * The mainnet simulation matrix: the whole path an agent or a bot takes, on mainnet's real prices,
 * pools and balances, stopped before anything is signed. For each case:
 *
 *   the agent's own quote from Jupiter → the owner's policy → Orientim's agent API (its real code,
 *   run in this process, not orientim.com) → the skill's full check on the exact bytes, which
 *   simulates the final transaction on mainnet state.
 *
 * The wallet of each case is a public wallet that holds the input token (an exchange's, found on
 * chain): no key is used, nothing is signed or sent, no funds move. Amounts run from $1 to $1M;
 * tokens are majors, LSTs, stablecoins, memecoins, Token-2022, Pump.fun tokens on the curve and on
 * PumpSwap, and pairs where neither side is SOL or USDC; tolerances, owner ceilings and limits vary.
 *
 * Each case ends as one of:
 *   PASS      the swap was built, passed every check and executes in simulation
 *   REFUSED   refused before signing, for a reason of Orientim's or the owner's (the code says which)
 *   UNTESTED  a service was busy (429), silent, or the price moved during the check: not a verdict
 *   BUG       anything else: Orientim's own honest answer refused by the skill's check, an internal
 *             error, an expectation not met, the agent and the bot deciding differently
 * The run fails on any BUG. The report goes to the job summary and to $SIM_OUT (report.md, report.json).
 *
 *   RPC_URL=<mainnet RPC> JUPITER_API_KEY=<key> npx vitest run --config tools/sim/vitest.config.ts
 *   SIM_GROUPS=sizes,pairs   only those groups (sizes, pairs, majors, whales, personas, pump, tolerance, rules, parity, modes)
 *   SIM_LIMIT=20             at most this many cases
 *   SIM_JUPITER_INTERVAL_MS  the least time between two Jupiter requests (default 1100: a free key)
 *   SIM_OFFLINE=1            a few cases against the test fakes, to check the matrix itself without a network
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { address, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { ataOf, JUPITER_PROGRAM, WSOL_MINT } from '@orientim/core';
import { jupiterRouteArgs } from '@orientim/verifier';
import { createJupiterClient, heliusPriorityFee, MIN_FEE } from '@orientim/jupiter';
import { createRetryingRpc } from '@orientim/solana';
import { agentPrepare } from '../../apps/web/lib/server/agent/api.ts';
import type { AgentDeps } from '../../apps/web/lib/server/agent/api.ts';
import {
  checkPolicy, FloorError, IntentError, OrientimApiError, PolicyError, prepareChecked, PriceImpactError,
} from '../../skills/orientim-protected-swap/examples/swap.ts';
import type { Checked, Intent, OwnerPolicy } from '../../skills/orientim-protected-swap/examples/swap.ts';
import { runCli } from '../../skills/orientim-protected-swap/src/cli.ts';
import { ORIENTIM_TREASURY } from '../../skills/orientim-protected-swap/lib/orientim-verify.mjs';

const OFFLINE = process.env.SIM_OFFLINE === '1';
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || undefined;
const JUPITER_INTERVAL_MS = Number(process.env.SIM_JUPITER_INTERVAL_MS ?? (JUPITER_API_KEY ? 1_100 : 2_200));
const GROUPS = (process.env.SIM_GROUPS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const LIMIT = Number(process.env.SIM_LIMIT ?? 0) || Infinity;
const OUT = process.env.SIM_OUT ?? join(tmpdir(), 'orientim-sim');
const API_KEY = `ori_sim_${randomBytes(12).toString('hex')}`;
const API_URL = 'http://orientim.sim';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// --- tokens
const T = {
  SOL: WSOL_MINT,
  USDC: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  USDT: address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
  JUP: address('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'),
  BONK: address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'),
  WIF: address('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'),
  RAY: address('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'),
  POPCAT: address('7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr'),
  TRUMP: address('6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN'),
  JitoSOL: address('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'),
  mSOL: address('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'),
  PYUSD: address('2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'),
  bSOL: address('bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1'),
  JTO: address('jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL'),
  PYTH: address('HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3'),
  W: address('85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ'),
  RENDER: address('rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof'),
  HNT: address('hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux'),
  PENGU: address('2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv'),
  FARTCOIN: address('9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump'),
  MEW: address('MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5'),
} as const;
type Sym = keyof typeof T | string;
const symbols = new Map<string, string>(Object.entries(T).map(([s, m]) => [m, s]));
const nameOf = (mint: string) => symbols.get(mint) ?? `${mint.slice(0, 4)}…`;

/** Public exchange wallets, tried first as holders; holders found on chain come after them. */
const KNOWN_HOLDERS = [
  'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm',
  'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5', 'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2',
  'ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
];

// --- cases
type Rule = { label: string; policy?: Omit<OwnerPolicy, 'maxAmountIn'> & { maxAmountIn?: Record<string, string> }; intent?: Partial<Omit<Intent, 'owner'>> };
type Case = {
  group: string; input: Sym; output: Sym; usd: number;
  /** A fraction of what the holder has, instead of `usd` (a Pump.fun token without a price). */
  share?: number;
  slippage?: number | 'auto';
  rule?: Rule;
  /** Outcomes accepted for this case: PASS, or refusal codes. Unset: any honest outcome. */
  expect?: string[];
  /** Also through orientim-verify, as a bot: both must decide alike. */
  bot?: boolean;
  /** Run this many copies of the case at once (a busy agent, several workers). */
  parallel?: number;
  /** An explicit minimum for the agent, as a fraction of Jupiter's quote (1.05 = 5% above it). */
  minOutOfQuote?: number;
  version?: 0 | 1;
  fast?: boolean;
};

function buildCases(pump: { curve: string[]; amm: string[] }): Case[] {
  const cases: Case[] = [];
  // Amounts from $1 to $1M: where the price impact grows, where the route costs more, where it stops.
  for (const [input, output] of [['USDC', 'SOL'], ['SOL', 'USDC'], ['USDC', 'JUP'], ['USDT', 'BONK']] as const) {
    for (const usd of [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000]) cases.push({ group: 'sizes', input, output, usd });
  }
  // Neither side is SOL or USDC: the fee comes from USDT, the input, or in SOL from the wallet.
  for (const [input, output] of [
    ['BONK', 'WIF'], ['WIF', 'JUP'], ['JUP', 'BONK'], ['RAY', 'JUP'], ['POPCAT', 'WIF'], ['JitoSOL', 'mSOL'],
    ['mSOL', 'JUP'], ['PYUSD', 'USDT'], ['USDT', 'BONK'], ['TRUMP', 'JUP'], ['BONK', 'POPCAT'], ['JUP', 'PYUSD'],
  ] as const) {
    for (const usd of [20, 500, 5_000]) cases.push({ group: 'pairs', input, output, usd });
  }
  // Each token against SOL and USDC, both ways.
  for (const token of ['JUP', 'BONK', 'WIF', 'POPCAT', 'TRUMP', 'RAY', 'JitoSOL', 'PYUSD', 'USDT'] as const) {
    for (const usd of [50, 2_000]) {
      cases.push({ group: 'majors', input: 'SOL', output: token, usd }, { group: 'majors', input: token, output: 'USDC', usd });
    }
  }
  // Large swaps against SOL, both ways, token by token: $5k to $200k, where each token's liquidity ends.
  const whaleTokens = ['JUP', 'BONK', 'WIF', 'POPCAT', 'TRUMP', 'RAY', 'JitoSOL', 'mSOL', 'bSOL', 'JTO', 'PYTH', 'W', 'RENDER', 'HNT', 'PENGU', 'FARTCOIN', 'MEW', 'PYUSD', 'USDT'];
  for (const token of whaleTokens) {
    for (const usd of [5_000, 8_000, 20_000, 50_000, 100_000, 200_000]) {
      cases.push({ group: 'whales', input: 'SOL', output: token, usd }, { group: 'whales', input: token, output: 'SOL', usd });
    }
  }
  // Large swaps where neither side is SOL.
  for (const [input, output] of [['BONK', 'WIF'], ['JUP', 'USDT'], ['WIF', 'POPCAT'], ['JitoSOL', 'mSOL'], ['PENGU', 'JUP']] as const) {
    for (const usd of [20_000, 100_000, 200_000]) cases.push({ group: 'whales', input, output, usd });
  }
  // Kinds of users: each owner sets their own rules and tolerance, on the same tokens.
  const personas: { label: string; policy?: Rule['policy']; slippage?: number | 'auto'; intent?: Rule['intent'] }[] = [
    { label: 'careful: ceiling 0.5%, auto', policy: { maxSlippageBps: 50 }, slippage: 'auto' },
    { label: 'meme trader: ceiling 3%, impact 5%, auto', policy: { maxSlippageBps: 300, maxPriceImpactBps: 500 }, slippage: 'auto' },
    { label: 'whale: impact at most 1%, 0.3%', policy: { maxPriceImpactBps: 100 }, slippage: 30 },
    { label: 'bot with defaults' },
    { label: 'tight: floor 1%, ceiling 1%', policy: { maxBelowBps: 100, maxSlippageBps: 100 } },
  ];
  for (const token of ['JUP', 'BONK', 'WIF', 'POPCAT', 'TRUMP', 'JTO', 'PYTH', 'PENGU', 'FARTCOIN', 'RENDER']) {
    for (const p of personas) {
      const rule: Rule = { label: p.label, ...(p.policy ? { policy: p.policy } : {}), ...(p.intent ? { intent: p.intent } : {}) };
      cases.push({ group: 'personas', input: 'SOL', output: token, usd: 5_000, rule, ...(p.slippage !== undefined ? { slippage: p.slippage } : {}) });
      cases.push({ group: 'personas', input: token, output: 'SOL', usd: 50_000, rule, ...(p.slippage !== undefined ? { slippage: p.slippage } : {}) });
    }
  }
  // Pump.fun: tokens still on the bonding curve, and graduated ones trading on PumpSwap.
  for (const mint of pump.curve) {
    cases.push({ group: 'pump', input: 'SOL', output: mint, usd: 5 }, { group: 'pump', input: 'SOL', output: mint, usd: 50 });
    cases.push({ group: 'pump', input: mint, output: 'SOL', usd: 0, share: 0.01 });
  }
  for (const mint of pump.amm) {
    cases.push({ group: 'pump', input: 'SOL', output: mint, usd: 20 }, { group: 'pump', input: 'SOL', output: mint, usd: 500 });
    cases.push({ group: 'pump', input: mint, output: 'USDC', usd: 0, share: 0.01 });
  }
  // The tolerance an agent chooses: none (Orientim's default), "auto" (Jupiter's estimate), or a number.
  const toleranceOn: [Sym, Sym, number][] = [['SOL', 'USDC', 500], ['USDC', 'BONK', 500], ['WIF', 'JUP', 500], ['POPCAT', 'SOL', 300]];
  if (pump.curve[0]) toleranceOn.push(['SOL', pump.curve[0], 20]);
  if (pump.amm[0]) toleranceOn.push(['SOL', pump.amm[0], 50]);
  for (const [input, output, usd] of toleranceOn) {
    for (const slippage of [undefined, 'auto', 10, 50, 100, 300, 1_000] as const) cases.push({ group: 'tolerance', input, output, usd, slippage });
  }
  // The owner's rules, as an unattended agent's owner would set them.
  const r = (label: string, policy: Rule['policy'], intent: Rule['intent'] = {}): Rule => ({ label, policy, intent });
  cases.push(
    { group: 'rules', input: 'SOL', output: 'USDC', usd: 500, slippage: 100, rule: r('ceiling 0.5%, asks 1%', { maxSlippageBps: 50 }), expect: ['slippage-over-limit'] },
    { group: 'rules', input: 'SOL', output: 'USDC', usd: 500, slippage: 'auto', rule: r('ceiling 0.5%, auto', { maxSlippageBps: 50 }), expect: ['PASS'] },
    { group: 'rules', input: 'USDC', output: 'BONK', usd: 500, rule: r('ceiling 1%, default', { maxSlippageBps: 100 }) },
    { group: 'rules', input: 'WIF', output: 'JUP', usd: 500, slippage: 'auto', rule: r('ceiling 1%, auto', { maxSlippageBps: 100 }) },
    { group: 'rules', input: 'USDC', output: 'JUP', usd: 1_000, rule: r('floor at most 1% below', { maxBelowBps: 100 }) },
    { group: 'rules', input: 'USDC', output: 'JUP', usd: 1_000, rule: r('floor 5% asked, owner allows 1%', { maxBelowBps: 100 }, { maxBelowBps: 500 }), expect: ['floor-over-limit'] },
    { group: 'rules', input: 'USDC', output: 'JUP', usd: 100_000, rule: r('price impact at most 0.5%', { maxPriceImpactBps: 50 }) },
    { group: 'rules', input: 'USDC', output: 'JUP', usd: 1_000, rule: r('impact 10% asked, owner allows 3%', { maxPriceImpactBps: 300 }, { maxPriceImpactBps: 1_000 }), expect: ['impact-over-limit'] },
    { group: 'rules', input: 'USDC', output: 'SOL', usd: 1_000, rule: r('per swap $100', { maxAmountIn: { [T.USDC]: '100000000' } }), expect: ['amount-over-limit'] },
    { group: 'rules', input: 'BONK', output: 'SOL', usd: 100, rule: r('BONK not allowed', { maxAmountIn: { [T.USDC]: '100000000' } }), expect: ['mint-not-allowed'] },
    { group: 'rules', input: 'USDC', output: 'SOL', usd: 100, rule: r('minimum of 1 (misled agent)', {}, { minOut: '1' }), expect: ['floor-too-low'] },
    { group: 'rules', input: 'USDC', output: 'WIF', usd: 50_000, rule: r('agent raises impact to 20%', {}, { maxPriceImpactBps: 2_000 }) },
    { group: 'rules', input: 'SOL', output: 'USDC', usd: 200, rule: r('everything set, within', { maxSlippageBps: 300, maxBelowBps: 500, maxPriceImpactBps: 300, maxAmountIn: { [T.SOL]: '100000000000' } }), slippage: 'auto', expect: ['PASS'] },
  );
  for (const mint of pump.curve.slice(0, 2)) {
    cases.push({ group: 'rules', input: 'SOL', output: mint, usd: 20, rule: r('ceiling 1% on a curve token', { maxSlippageBps: 100 }) });
    cases.push({ group: 'rules', input: 'SOL', output: mint, usd: 20, slippage: 'auto', rule: r('ceiling 1%, auto, curve', { maxSlippageBps: 100 }) });
  }
  // The same cases as an agent (the skill) and as a bot (orientim-verify): they must decide alike.
  for (const c of [
    { input: 'USDC', output: 'SOL', usd: 100 }, { input: 'SOL', output: 'BONK', usd: 300 }, { input: 'BONK', output: 'WIF', usd: 200 },
    { input: 'USDC', output: 'JUP', usd: 100_000 }, { input: 'PYUSD', output: 'USDC', usd: 100 }, { input: 'JitoSOL', output: 'mSOL', usd: 1_000 },
    { input: 'SOL', output: 'USDC', usd: 500, slippage: 'auto' as const }, { input: 'SOL', output: 'USDC', usd: 500, slippage: 100, rule: r('ceiling 0.5%', { maxSlippageBps: 50 }) },
    ...(pump.curve[0] ? [{ input: 'SOL', output: pump.curve[0], usd: 20 }] : []),
    ...(pump.amm[0] ? [{ input: 'SOL', output: pump.amm[0], usd: 50, slippage: 'auto' as const }] : []),
  ] as Omit<Case, 'group'>[]) cases.push({ group: 'parity', bot: true, ...c });
  // Hard cases: boundaries, nonsense a misled agent may send, extremes, several at once.
  const RANDOM_MINT = 'Hq7dYVVc2S3mtDuLyYy6oF4rUUqzmVZqQ8dvKq1WgN6A';
  cases.push(
    // Near the smallest swap: the fee has a floor in SOL (about $0.40), so $0.25 is refused and $1 goes.
    { group: 'hard', input: 'USDC', output: 'SOL', usd: 0.25, expect: ['amount-too-small'] },
    { group: 'hard', input: 'USDC', output: 'SOL', usd: 1.05 },
    { group: 'hard', input: 'SOL', output: 'USDC', usd: 0.25, expect: ['amount-too-small'] },
    { group: 'hard', input: 'SOL', output: 'USDC', usd: 1.1 },
    // Nonsense: the same token on both sides, a mint that is no token at all.
    { group: 'hard', input: 'USDC', output: 'USDC', usd: 100, expect: ['any-refusal'] },
    { group: 'hard', input: 'SOL', output: 'SOL', usd: 100, expect: ['any-refusal'] },
    { group: 'hard', input: 'SOL', output: RANDOM_MINT, usd: 100, expect: ['any-refusal'] },
    // A minimum above the market (the agent asks for more than exists), and exactly at it.
    { group: 'hard', input: 'SOL', output: 'USDC', usd: 1_000, minOutOfQuote: 1.05, expect: ['any-refusal'] },
    { group: 'hard', input: 'SOL', output: 'USDC', usd: 1_000, minOutOfQuote: 1.0 },
    { group: 'hard', input: 'USDC', output: 'BONK', usd: 1_000, minOutOfQuote: 0.995 },
    // The floor at the quote itself, set by the owner.
    { group: 'hard', input: 'USDC', output: 'SOL', usd: 500, rule: r('floor at the quote (maxBelowBps 0)', { maxBelowBps: 0 }) },
    // The extremes of tolerance on thin and deep markets.
    { group: 'hard', input: 'USDC', output: 'WIF', usd: 20_000, slippage: 10 },
    // A wide tolerance on a thin route, three times: a failure in the check must repeat to count.
    ...[1, 2, 3].map(n => ({ group: 'hard', input: 'USDC', output: 'WIF', usd: 20_000, slippage: 1_500, rule: r(`wide tolerance, try ${n} of 3`, undefined) }) as Case),
    { group: 'hard', input: 'SOL', output: 'HNT', usd: 10_000, slippage: 'auto', rule: r('thin market, owner allows 20% impact', { maxPriceImpactBps: 2_000 }, { maxPriceImpactBps: 2_000 }) },
    { group: 'hard', input: 'SOL', output: 'W', usd: 50_000, rule: r('owner allows 20% impact', { maxPriceImpactBps: 2_000 }, { maxPriceImpactBps: 2_000 }) },
    // Stablecoin to stablecoin, deep.
    { group: 'hard', input: 'USDC', output: 'USDT', usd: 1_000_000 },
    { group: 'hard', input: 'USDT', output: 'USDC', usd: 500_000 },
    { group: 'hard', input: 'PYUSD', output: 'USDC', usd: 100_000 },
    // Token-2022 and LSTs at size, as a bot too.
    { group: 'hard', input: 'SOL', output: 'JitoSOL', usd: 500_000, bot: true },
    { group: 'hard', input: 'mSOL', output: 'SOL', usd: 200_000, bot: true },
    // v1 and fast routing together, on a memecoin.
    { group: 'hard', input: 'SOL', output: 'BONK', usd: 2_000, version: 1, fast: true, slippage: 'auto' },
    // A busy agent: the same swap ten times at once, and five different swaps at once.
    { group: 'hard', input: 'USDC', output: 'SOL', usd: 250, parallel: 10 },
    { group: 'hard', input: 'SOL', output: 'JUP', usd: 3_000, parallel: 5, slippage: 'auto' },
  );
  if (pump.curve[0]) cases.push({ group: 'hard', input: 'SOL', output: pump.curve[0], usd: 1_000, slippage: 'auto', rule: r('curve token at size, ceiling 5%', { maxSlippageBps: 500 }) });

  // v1 transactions and Jupiter's fast routing, where the deployment offers them.
  cases.push(
    { group: 'modes', input: 'USDC', output: 'SOL', usd: 100, version: 1 },
    { group: 'modes', input: 'SOL', output: 'BONK', usd: 100, version: 1 },
    { group: 'modes', input: 'USDC', output: 'SOL', usd: 100, fast: true },
    { group: 'modes', input: 'WIF', output: 'JUP', usd: 300, fast: true },
  );
  return cases.filter(c => !GROUPS.length || GROUPS.includes(c.group)).slice(0, LIMIT);
}

// --- the world: mainnet (or the test fakes offline), Jupiter throttled, Orientim's API in this process
type World = {
  rpc: Rpc<SolanaRpcApi>;
  fetchImpl: typeof fetch;
  deps: AgentDeps;
  holderOf(mint: string, need: bigint, needLamports: bigint): Promise<{ owner: string; balance: bigint } | null>;
  priceOf(mint: string): Promise<{ usd: number; decimals: number } | null>;
  pumpTokens(): Promise<{ curve: string[]; amm: string[] }>;
};

let nextJupiterAt = 0;
/** Every request to Jupiter, the agent's and Orientim's, spaced as the key allows; a 429 is asked again twice. */
/** The case each request belongs to, so that Jupiter's answers are kept with it even when cases run at once. */
const caseOf = new AsyncLocalStorage<number>();
/** Every answer from Jupiter that was not a success, by case: status, endpoint and body, for the report. */
const jupiterAnswers = new Map<number, string[]>();

async function jupiterFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const at = Math.max(now, nextJupiterAt);
    nextJupiterAt = at + JUPITER_INTERVAL_MS;
    if (at > now) await sleep(at - now);
    const res = await fetch(input, init);
    if (!res.ok) {
      const n = caseOf.getStore() ?? 0;
      const url = new URL(String(input instanceof Request ? input.url : input));
      const body = await res.clone().text().catch(() => '(unreadable)');
      const note = `${res.status} ${url.pathname} slippage=${url.searchParams.get('slippageBps') ?? '-'} amount=${url.searchParams.get('amount') ?? '-'}: ${body.replace(/\s+/g, ' ').slice(0, 300)}`;
      jupiterAnswers.set(n, [...(jupiterAnswers.get(n) ?? []), note]);
      console.log(`    jupiter #${n}: ${note}`);
    }
    if (res.status !== 429 || attempt >= 2) return res;
    await sleep(2_000 * 2 ** attempt);
  }
}

async function mainnet(): Promise<World> {
  const serverRpc = createRetryingRpc(RPC_URL, 8);
  const rpc = createRetryingRpc(RPC_URL, 8) as unknown as Rpc<SolanaRpcApi>;
  const jupiter = createJupiterClient({
    buildUrl: 'https://api.jup.ag/swap/v2/build', tokensUrl: 'https://api.jup.ag/tokens/v2/search',
    labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label', apiKey: JUPITER_API_KEY, fetchImpl: jupiterFetch, timeoutMs: 20_000,
  });
  const deps: AgentDeps = {
    rpc: serverRpc, jupiter, ...(/helius/i.test(RPC_URL) ? { priorityFee: heliusPriorityFee(RPC_URL) } : {}),
    secrets: [randomBytes(32)], keys: new Map([[createHash('sha256').update(API_KEY).digest('hex'), 'sim']]),
    // As production: 0.25% to Orientim's own treasury, HumidiFi excluded, the default network fee cap.
    feeBps: 25n, treasury: address(ORIENTIM_TREASURY), excludeDexes: ['HumidiFi'], maxNetworkFeeLamports: 500_000n,
    disabled: false, v1: true, fastRouting: true, perMinute: 1_000_000, minFee: MIN_FEE,
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('https://api.jup.ag/')) return jupiterFetch(url, init);
    if (String(url).startsWith(`${API_URL}/api/v1/prepare`)) return agentPrepare(new Request(url, init), deps);
    return fetch(url, init);
  }) as unknown as typeof fetch;

  const holders = new Map<string, { owner: string; balance: bigint; lamports: bigint }[]>();
  const programOf = new Map<string, Address>();
  const tokenProgram = async (mint: string) => {
    if (!programOf.has(mint)) programOf.set(mint, (await rpc.getAccountInfo(address(mint), { encoding: 'base64' }).send()).value!.owner as Address);
    return programOf.get(mint)!;
  };
  /** Wallets holding `mint` in their own associated account, with SOL to pay for the swap. */
  async function holdersOf(mint: string) {
    if (holders.has(mint)) return holders.get(mint)!;
    const candidates = new Set<string>(KNOWN_HOLDERS);
    if (mint !== WSOL_MINT) {
      try {
        const largest = await rpc.getTokenLargestAccounts(address(mint)).send();
        const infos = await rpc.getMultipleAccounts(largest.value.slice(0, 20).map(a => a.address), { encoding: 'jsonParsed' }).send();
        for (const info of infos.value) {
          const owner = (info?.data as { parsed?: { info?: { owner?: string } } } | undefined)?.parsed?.info?.owner;
          if (owner) candidates.add(owner);
        }
      } catch { /* the known wallets only */ }
    }
    const program = mint === WSOL_MINT ? null : await tokenProgram(mint);
    const found: { owner: string; balance: bigint; lamports: bigint }[] = [];
    for (const owner of candidates) {
      try {
        const wallet = await rpc.getAccountInfo(address(owner), { encoding: 'base64' }).send();
        // A wallet pays the network fee: a system account, not a program's.
        if (!wallet.value || wallet.value.owner !== '11111111111111111111111111111111') continue;
        const lamports = BigInt(wallet.value.lamports);
        let balance = lamports;
        if (program) {
          const ata = await ataOf(address(owner), address(mint), program);
          const acc = await rpc.getTokenAccountBalance(ata).send().catch(() => null);
          balance = acc ? BigInt(acc.value.amount) : 0n;
        }
        if (balance > 0n) found.push({ owner, balance, lamports });
      } catch { /* not a wallet */ }
    }
    found.sort((a, b) => (b.balance > a.balance ? 1 : -1));
    holders.set(mint, found);
    return found;
  }
  const prices = new Map<string, { usd: number; decimals: number } | null>();
  return {
    rpc, fetchImpl, deps,
    async holderOf(mint, need, needLamports) {
      return (await holdersOf(mint)).find(h => h.balance >= need && h.lamports >= needLamports + (mint === WSOL_MINT ? need : 0n)) ?? null;
    },
    async priceOf(mint) {
      if (!prices.has(mint)) {
        const r = await jupiterFetch(`https://api.jup.ag/tokens/v2/search?query=${mint}`, { headers: JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {} });
        const list = r.ok ? await r.json() as { id: string; usdPrice?: number; decimals: number }[] : [];
        const t = Array.isArray(list) ? list.find(x => x.id === mint) : undefined;
        prices.set(mint, t && typeof t.usdPrice === 'number' && t.usdPrice > 0 ? { usd: t.usdPrice, decimals: t.decimals } : null);
      }
      return prices.get(mint)!;
    },
    async pumpTokens() {
      const list = async (url: string) => {
        const r = await jupiterFetch(url, { headers: JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {} });
        const body = r.ok ? await r.json() as unknown : [];
        return Array.isArray(body) ? body.map(x => (x as { id?: string }).id).filter((id): id is string => typeof id === 'string' && id.endsWith('pump')) : [];
      };
      return {
        curve: (await list('https://api.jup.ag/tokens/v2/recent')).slice(0, 3),
        amm: (await list('https://api.jup.ag/tokens/v2/toptrending/1h?limit=100')).slice(0, 3),
      };
    },
  };
}

/** The test fakes: a funded wallet, an honest market, no network. Checks the matrix itself. */
async function offline(): Promise<World> {
  const { generateKeyPairSigner } = await import('@solana/kit');
  const fakes = await import('../../packages/jupiter/test/fakes.ts');
  const wallet = await generateKeyPairSigner();
  const accounts = new Map<string, import('../../packages/jupiter/test/fakes.ts').Account>([
    [fakes.USDC, fakes.mint(6)], [WSOL_MINT, fakes.mint(9)], [fakes.BONK, fakes.mint(5)],
    [fakes.DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [fakes.POOL, { owner: fakes.DEX, data: new Uint8Array(300) }],
    [await ataOf(address(ORIENTIM_TREASURY), fakes.USDC), fakes.tokenAccount(address(ORIENTIM_TREASURY), fakes.USDC)],
    ...await fakes.fundedAccounts(wallet.address, fakes.USDC),
  ]);
  const rpc = fakes.fakeRpc(accounts, {});
  const jupiter = fakes.fakeJupiter();
  const deps: AgentDeps = {
    rpc, jupiter, secrets: [randomBytes(32)], keys: new Map([[createHash('sha256').update(API_KEY).digest('hex'), 'sim']]),
    feeBps: 25n, treasury: address(ORIENTIM_TREASURY), excludeDexes: [], maxNetworkFeeLamports: 200_000n, disabled: false, v1: false, perMinute: 1_000_000,
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('https://api.jup.ag/')) {
      const q = new URL(url).searchParams;
      const r = await jupiter.build({
        inputMint: address(q.get('inputMint')!), outputMint: address(q.get('outputMint')!), amount: BigInt(q.get('amount')!),
        taker: address(q.get('taker')!), slippageBps: Number(q.get('slippageBps')) || 50, maxAccounts: 64,
      });
      return Response.json({ ...r, priceImpactPct: 0 });
    }
    return agentPrepare(new Request(url, init), deps);
  }) as unknown as typeof fetch;
  const agentRpc = { ...rpc, getBlockHeight: () => ({ send: async () => 850n }) } as unknown as Rpc<SolanaRpcApi>;
  symbols.set(fakes.BONK, 'BONK');
  (T as Record<string, string>).BONK = fakes.BONK;
  return {
    rpc: agentRpc, fetchImpl, deps,
    async holderOf(mint) { return mint === fakes.USDC ? { owner: wallet.address, balance: 1_000_000_000n } : null; },
    async priceOf(mint) { return mint === fakes.USDC ? { usd: 1, decimals: 6 } : mint === WSOL_MINT ? { usd: 150, decimals: 9 } : { usd: 0.00002, decimals: 5 }; },
    async pumpTokens() { return { curve: [], amm: [] }; },
  };
}

// --- one case
type Result = {
  n: number; group: string; pair: string; usd: string; rule: string; asked: string; built: string;
  kind: 'PASS' | 'REFUSED' | 'UNTESTED' | 'BUG'; code: string; detail: string;
  route: string; impact: string; fee: string; floor: string; ms: number; bot?: string;
  /** Jupiter's answers that were not a success during this case. */
  jupiter?: string[];
};

const ABOVE_CEILING = /above the owner's limit of \d+ \(maxSlippageBps\)/;
const UNAVAILABLE = /Jupiter answered (429|5\d\d)|fetch failed|timed out|TimeoutError|AbortError|ECONNRESET|socket hang up|did not answer|could not be read from your RPC|could not be simulated on your RPC/i;

/** An error, as one outcome: an honest refusal, a service that was not there, or something to look at. */
function classify(e: unknown): Pick<Result, 'kind' | 'code' | 'detail'> {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof PolicyError) return { kind: 'REFUSED', code: e.code, detail: message.slice(0, 160) };
  if (e instanceof PriceImpactError) return { kind: 'REFUSED', code: 'price-impact-high', detail: `impact ${(e.impactBps / 100).toFixed(2)}%, limit ${(e.limitBps / 100).toFixed(2)}%` };
  if (e instanceof FloorError) return { kind: 'REFUSED', code: 'floor-too-low', detail: `lowest accepted ${e.lowest}` };
  if (e instanceof IntentError) return { kind: 'BUG', code: 'intent', detail: `the matrix built an intent the skill refuses: ${message.slice(0, 200)}` };
  if (e instanceof OrientimApiError) {
    if (['busy', 'unavailable', 'rate-limited'].includes(e.code)) return { kind: 'UNTESTED', code: e.code, detail: e.serverMessage };
    if (['internal', 'verification-failed', 'route-format', 'wallet-changed-transaction', 'bad-request', 'invalid-ticket', 'unauthorized'].includes(e.code)) {
      return { kind: 'BUG', code: e.code, detail: e.serverMessage };
    }
    const extra = e.code === 'costs-more' ? ` (gap ${String(e.body.gapBps)} bps)` : e.code === 'price-moved' ? ` (new minimum ${String(e.body.newMinOut)})` : '';
    return { kind: 'REFUSED', code: e.code, detail: `${e.serverMessage}${extra}`.slice(0, 200) };
  }
  if (message.startsWith('Not signing: ')) {
    if (ABOVE_CEILING.test(message)) return { kind: 'REFUSED', code: 'route-above-ceiling', detail: message.slice(13, 200) };
    // The price moved between Orientim's build and the check's own simulation (Jupiter's 6001).
    if (/fails in simulation/.test(message) && /6001|"Custom":6001/.test(message)) return { kind: 'UNTESTED', code: 'price-moved-in-check', detail: message.slice(13, 200) };
    if (UNAVAILABLE.test(message)) return { kind: 'UNTESTED', code: 'rpc', detail: message.slice(13, 200) };
    // Orientim's own honest answer, refused by the skill's check: the two disagree.
    return { kind: 'BUG', code: 'check-refused-honest-answer', detail: message.slice(13, 400) };
  }
  // Jupiter still busy after the skill asked it again, or a refusal of its own with its code.
  if (/^Jupiter answered 400 \(busy\)/.test(message)) return { kind: 'UNTESTED', code: 'jupiter-busy', detail: message.slice(0, 200) };
  const jupiterCode = /^Jupiter answered 4\d\d \(([A-Za-z0-9_]+)\)/.exec(message)?.[1];
  if (jupiterCode) return { kind: 'REFUSED', code: `jupiter-${jupiterCode.toLowerCase()}`, detail: message.slice(0, 200) };
  if (UNAVAILABLE.test(message) || /\b429\b/.test(message)) return { kind: 'UNTESTED', code: 'service', detail: message.slice(0, 200) };
  if (/without a price impact/.test(message)) return { kind: 'REFUSED', code: 'impact-unknown', detail: message.slice(0, 160) };
  return { kind: 'BUG', code: 'error', detail: message.slice(0, 400) };
}

/** The tolerance the Jupiter route in the built transaction carries, in bps. */
function builtTolerance(wire: string): number | null {
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(wire, 'base64')).messageBytes) as unknown as {
      staticAccounts: string[]; instructions: { programAddressIndex: number; data?: Uint8Array }[];
    };
    const ix = compiled.instructions.find(i => compiled.staticAccounts[i.programAddressIndex] === JUPITER_PROGRAM);
    return ix?.data ? jupiterRouteArgs(ix.data)?.slippageBps ?? null : null;
  } catch {
    return null;
  }
}

async function runCase(w: World, c: Case, n: number): Promise<Result> {
  const input = (T as Record<string, string>)[c.input] ?? c.input;
  const output = (T as Record<string, string>)[c.output] ?? c.output;
  const base: Result = {
    n, group: c.group, pair: `${nameOf(input)} → ${nameOf(output)}`, usd: c.share ? `${c.share * 100}% of a holder` : `$${c.usd.toLocaleString('en-US')}`,
    rule: c.rule?.label ?? '', asked: c.slippage === undefined ? 'default' : String(c.slippage), built: '',
    kind: 'UNTESTED', code: '', detail: '', route: '', impact: '', fee: '', floor: '', ms: 0,
  };
  const started = Date.now();
  try {
    // The amount, in the input's base units, and a public wallet that holds it.
    const price = await w.priceOf(input);
    let amount: bigint;
    let holder: { owner: string; balance: bigint } | null;
    if (c.share) {
      holder = await w.holderOf(input, 1n, 20_000_000n);
      amount = holder ? BigInt(Math.floor(Number(holder.balance) * c.share)) : 0n;
    } else {
      if (!price) return { ...base, kind: 'UNTESTED', code: 'no-price', detail: 'Jupiter gives no USD price for the input', ms: Date.now() - started };
      amount = BigInt(Math.round((c.usd / price.usd) * 10 ** price.decimals));
      // An exchange's wallet: SOL for the network fee, new accounts' rent and a fee paid in SOL.
      holder = await w.holderOf(input, amount, 1_000_000_000n);
    }
    if (!holder || amount <= 0n) return { ...base, kind: 'UNTESTED', code: 'no-holder', detail: 'no public wallet found holding enough of the input, with SOL for fees', ms: Date.now() - started };
    const owner = holder.owner;
    const policy: OwnerPolicy | undefined = c.rule?.policy
      ? { maxAmountIn: c.rule.policy.maxAmountIn ?? { [input]: '100000000000000000000' }, ...c.rule.policy } as OwnerPolicy
      : undefined;
    let minOut: string | undefined;
    if (c.minOutOfQuote !== undefined) {
      // Jupiter's own quote for the amount, then the minimum the agent asks relative to it.
      const q = await w.fetchImpl(`https://api.jup.ag/swap/v2/build?${new URLSearchParams({
        inputMint: input, outputMint: output, amount: amount.toString(), taker: owner, slippageBps: '50', maxAccounts: '64',
      })}`, { headers: JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {} });
      const out = q.ok ? (await q.json() as { outAmount?: string }).outAmount : undefined;
      if (!out) return { ...base, kind: 'UNTESTED', code: 'no-quote', detail: 'Jupiter gave no quote to set the minimum from', ms: Date.now() - started };
      minOut = BigInt(Math.floor(Number(out) * c.minOutOfQuote)).toString();
    }
    const intent: Omit<Intent, 'owner'> = {
      inputMint: input, outputMint: output, amountIn: amount.toString(), ...(minOut ? { minOut } : {}),
      ...(c.slippage !== undefined ? { slippageBps: c.slippage } : {}),
      ...(c.version ? { version: c.version } : {}), ...(c.fast ? { routingMode: 'fast' as const } : {}),
      ...(c.rule?.intent ?? {}),
    };
    // As protectedSwap does: the owner's per-swap limits first, then prepare and the full check.
    let outcome: Result;
    try {
      if (policy) await checkPolicy(policy, { owner, inputMint: input, amountIn: intent.amountIn });
      const checked: Checked = await prepareChecked({
        apiUrl: API_URL, apiKey: API_KEY, rpc: w.rpc, owner, intent, fetchImpl: w.fetchImpl, jupiterApiKey: JUPITER_API_KEY,
        requestTimeoutMs: 30_000, ...(policy ? { policy } : {}),
      });
      const p = checked.prepared;
      // A v1 message is not read by the v0 decoder here: the answer states it then (the check held it).
      const built = builtTolerance(p.transaction) ?? (typeof p.slippageBps === 'number' ? p.slippageBps : null);
      const quoted = BigInt(p.amounts.quotedOut);
      const floorBps = quoted > 0n ? Number(((quoted - BigInt(p.amounts.minOut)) * 10_000n) / quoted) : 0;
      outcome = {
        ...base, kind: 'PASS', code: 'ok', built: built === null ? '?' : String(built),
        route: Array.isArray((p as { route?: unknown }).route) ? ((p as { route?: string[] }).route ?? []).join(' > ') : '',
        impact: typeof p.amounts.priceImpactPct === 'number' ? `${(p.amounts.priceImpactPct * 100).toFixed(2)}%` : 'unknown',
        fee: `${p.amounts.fee} ${p.amounts.feeMint ? nameOf(p.amounts.feeMint) : ''}`.trim(),
        floor: `${(floorBps / 100).toFixed(2)}% under quote`,
        detail: (checked.notices ?? []).join(' ').slice(0, 160),
      };
      // What a pass must hold: never looser than the owner's ceiling or the tolerance asked.
      const ceiling = policy?.maxSlippageBps;
      if (built !== null && ceiling !== undefined && built > ceiling) outcome = { ...outcome, kind: 'BUG', code: 'above-ceiling', detail: `built at ${built} bps, owner's ceiling ${ceiling}` };
      if (built !== null && typeof c.slippage === 'number' && built > c.slippage) outcome = { ...outcome, kind: 'BUG', code: 'above-asked', detail: `built at ${built} bps, asked ${c.slippage}` };
    } catch (e) {
      outcome = { ...base, ...classify(e) };
    }
    // The same case as a bot: orientim-verify prepare, with the same policy.
    if (c.bot) {
      const deps = {
        rpc: w.rpc, apiUrl: API_URL, apiKey: API_KEY, fetchImpl: w.fetchImpl, jupiterApiKey: JUPITER_API_KEY,
        stateDir: mkdtempSync(join(tmpdir(), 'orientim-sim-bot-')), requestTimeoutMs: 30_000, ...(policy ? { policy } : {}),
      };
      const r = await runCli('prepare', { intent: { owner, id: `sim-${n}`, ...intent } }, deps);
      const out = JSON.parse(JSON.stringify(r.output)) as { error?: { code?: string; message?: string }; problems?: string[] };
      const jupiterCode = out.problems?.map(x => /^Jupiter answered 4\d\d \(([A-Za-z0-9_]+)\)/.exec(x)?.[1]).find(Boolean);
      const bot = r.code === 0 ? 'PASS'
        : out.problems?.some(x => ABOVE_CEILING.test(x)) ? 'route-above-ceiling'
          : jupiterCode && out.error?.code !== 'unavailable' ? `jupiter-${jupiterCode.toLowerCase()}`
            : out.error?.code ?? (out.problems ? `problems: ${out.problems.join('; ').slice(0, 120)}` : `exit ${r.code}`);
      const agent = outcome.kind === 'PASS' ? 'PASS' : outcome.code;
      outcome.bot = bot;
      const eitherUnavailable = outcome.kind === 'UNTESTED' || ['unavailable', 'busy', 'rate-limited'].includes(bot);
      if (!eitherUnavailable && bot !== agent && !(agent === 'price-moved' || bot === 'price-moved')) {
        outcome = { ...outcome, kind: 'BUG', code: 'agent-bot-differ', detail: `agent ${agent}, bot ${bot}` };
      }
    }
    // An expectation the case carries. "any-refusal": any honest refusal, Jupiter's own included;
    // a refusal the case names is honest there, whatever it would mean elsewhere.
    if (c.expect && outcome.kind !== 'UNTESTED') {
      const got = outcome.kind === 'PASS' ? 'PASS' : outcome.code;
      const jupiterRefused = /^Jupiter answered 4\d\d/.test(outcome.detail);
      const accepted = c.expect.includes(got)
        || (c.expect.includes('any-refusal') && (outcome.kind === 'REFUSED' || (outcome.kind === 'BUG' && (jupiterRefused || got === 'bad-request' || got === 'intent'))));
      if (accepted && outcome.kind === 'BUG') outcome = { ...outcome, kind: 'REFUSED' };
      else if (!accepted && outcome.kind !== 'BUG') outcome = { ...outcome, kind: 'BUG', code: 'unexpected', detail: `expected ${c.expect.join(' or ')}, got ${got}: ${outcome.detail}` };
    }
    return { ...outcome, ms: Date.now() - started };
  } catch (e) {
    return { ...base, ...classify(e), ms: Date.now() - started };
  }
}

// --- the report
function report(results: Result[], started: number): string {
  const count = (k: Result['kind']) => results.filter(r => r.kind === k).length;
  const lines: string[] = [];
  lines.push(`# Orientim mainnet simulation matrix`, '');
  lines.push(`${results.length} cases in ${Math.round((Date.now() - started) / 60_000)} min: **${count('PASS')} passed**, ${count('REFUSED')} refused, ${count('UNTESTED')} untested, **${count('BUG')} to look at**.`, '');
  lines.push('Nothing was signed or sent: each swap stops before the wallet signs, after the full check simulated it on mainnet state.', '');
  const groups = [...new Set(results.map(r => r.group))];
  lines.push('| group | cases | passed | refused | untested | to look at |', '|---|---|---|---|---|---|');
  for (const g of groups) {
    const rs = results.filter(r => r.group === g);
    lines.push(`| ${g} | ${rs.length} | ${rs.filter(r => r.kind === 'PASS').length} | ${rs.filter(r => r.kind === 'REFUSED').length} | ${rs.filter(r => r.kind === 'UNTESTED').length} | ${rs.filter(r => r.kind === 'BUG').length} |`);
  }
  const refusals = new Map<string, number>();
  for (const r of results.filter(x => x.kind === 'REFUSED')) refusals.set(r.code, (refusals.get(r.code) ?? 0) + 1);
  if (refusals.size) lines.push('', `Refusals by reason: ${[...refusals].map(([k, v]) => `${k} ${v}`).join(', ')}.`);
  const bugs = results.filter(r => r.kind === 'BUG');
  if (bugs.length) {
    lines.push('', '## To look at', '');
    for (const b of bugs) lines.push(`- #${b.n} ${b.group}: ${b.pair}, ${b.usd}${b.rule ? `, ${b.rule}` : ''}, slippage ${b.asked}: **${b.code}**: ${b.detail.replace(/\|/g, '/')}`);
  }
  const esc = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ');
  lines.push('', '## Every case', '', '| # | group | pair | amount | owner\'s rule | slippage asked | built at (bps) | result | code | route | impact | fee | floor | ms | bot |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    lines.push(`| ${r.n} | ${r.group} | ${esc(r.pair)} | ${esc(r.usd)} | ${esc(r.rule)} | ${r.asked} | ${r.built} | ${r.kind} | ${esc(r.code)} | ${esc(r.route)} | ${r.impact} | ${esc(r.fee)} | ${esc(r.floor)} | ${r.ms} | ${r.bot ?? ''} |`);
  }
  const answered = results.filter(r => r.jupiter?.length);
  if (answered.length) {
    lines.push('', "## Jupiter's answers that were not a success", '');
    for (const r of answered) for (const a of r.jupiter!) lines.push(`- #${r.n} ${esc(r.pair)} ${esc(r.usd)} (${r.kind} ${esc(r.code)}): ${esc(a)}`);
  }
  const details = results.filter(r => r.kind !== 'PASS' && r.detail);
  if (details.length) {
    lines.push('', '## Why each case was not a pass', '');
    for (const r of details) lines.push(`- #${r.n} ${esc(r.pair)} ${esc(r.usd)}: ${r.kind} ${esc(r.code)}: ${esc(r.detail)}`);
  }
  return `${lines.join('\n')}\n`;
}

it('the mainnet simulation matrix', async () => {
  const started = Date.now();
  const w = OFFLINE ? await offline() : await mainnet();
  const pump = OFFLINE ? { curve: [], amm: [] } : await w.pumpTokens().catch(() => ({ curve: [], amm: [] }));
  const cases = OFFLINE
    ? [
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100 },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, slippage: 'auto' as const },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, slippage: 100, rule: { label: 'ceiling 0.5%', policy: { maxSlippageBps: 50 } }, expect: ['slippage-over-limit'] },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, rule: { label: 'per swap $10', policy: { maxAmountIn: { [T.USDC]: '10000000' } } }, expect: ['amount-over-limit'] },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, bot: true },
      { group: 'offline', input: 'SOL', output: 'USDC', usd: 100 },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, parallel: 3 },
      { group: 'offline', input: 'USDC', output: 'USDC', usd: 100, expect: ['any-refusal'] },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, minOutOfQuote: 1.05, expect: ['any-refusal'] },
    ] as Case[]
    : buildCases(pump);
  console.log(`${cases.length} cases${pump.curve.length || pump.amm.length ? `; Pump.fun curve ${pump.curve.map(nameOf).join(', ')}; PumpSwap ${pump.amm.map(nameOf).join(', ')}` : ''}`);
  const results: Result[] = [];
  let n = 0;
  const say = (r: Result) => console.log(`${String(r.n).padStart(3)} ${r.kind.padEnd(8)} ${r.group.padEnd(9)} ${r.pair} ${r.usd} ${r.rule} slippage ${r.asked}${r.built ? ` built ${r.built}` : ''}: ${r.code} ${r.route} ${r.detail.slice(0, 120)}`);
  const withAnswers = (r: Result) => (jupiterAnswers.has(r.n) ? { ...r, jupiter: jupiterAnswers.get(r.n) } : r);
  for (const c of cases) {
    // Copies of one case at once: each its own number, all started together.
    const copies = Array.from({ length: c.parallel ?? 1 }, () => ++n);
    const rs = await Promise.all(copies.map(k => caseOf.run(k, () => runCase(w, c, k))));
    for (const r of rs) {
      const kept = withAnswers(c.parallel ? { ...r, group: `${r.group} (×${c.parallel})` } : r);
      results.push(kept);
      say(kept);
    }
  }
  const md = report(results, started);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'report.md'), md);
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(results, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' });
  console.log(`\nReport: ${join(OUT, 'report.md')}`);
  const bugs = results.filter(r => r.kind === 'BUG');
  expect(bugs.map(b => `#${b.n} ${b.pair} ${b.usd}: ${b.code}: ${b.detail}`)).toEqual([]);
  // A run that could test little (a wrong key, a busy RPC) is not a pass either.
  const tested = results.filter(r => r.kind !== 'UNTESTED').length;
  expect(tested, `only ${tested} of ${results.length} cases could be tested: see UNTESTED in the report`).toBeGreaterThanOrEqual(Math.ceil(results.length / 2));
}, 4 * 60 * 60_000);
