/**
 * The upstream canary (research audit F-07). Jupiter, Pump.fun and the token programs are redeployed
 * every few days: on 23 September 2026 Pump's curve program was hours old and Jupiter's two days.
 * Bound's verifier refuses a Jupiter instruction it cannot read, so a format change stops every swap;
 * this finds it before a user does.
 *
 * It builds three protected swaps on mainnet state exactly as the page does (USDC → SOL, SOL → USDC,
 * and a buy on a Pump.fun bonding curve, which exercises the market's account being closed), then
 * executes each final transaction in simulation. Nothing is signed or sent.
 *
 *   node tools/canary.ts          RPC_URL and JUPITER_API_KEY are used when set
 *
 * Exit 1 when a swap cannot be built or executed for a reason that is not load: Jupiter's format
 * changed, a rule no longer holds, a major pair has no route, or the final transaction fails.
 * A busy or silent service, or a price that keeps moving, only warns.
 */
import { address, getAddressDecoder, getBase64EncodedWireTransaction } from '@solana/kit';
import type { Address } from '@solana/kit';
import { JUPITER_PROGRAM, WSOL_MINT } from '@bound/core';
import { createEphemeral, createRetryingRpc, fetchMints } from '@bound/solana';
import { BoundError, createJupiterClient, DEFAULT_SETTINGS, prepareProtectedSwap } from '@bound/jupiter';
import type { PreparedSwap } from '@bound/jupiter';

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const rpc = createRetryingRpc(RPC_URL, 8);
const jupiter = createJupiterClient({
  buildUrl: 'https://api.jup.ag/swap/v2/build',
  tokensUrl: 'https://lite-api.jup.ag/tokens/v2/search',
  labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label',
  apiKey: process.env.JUPITER_API_KEY || undefined,
  minIntervalMs: process.env.JUPITER_API_KEY ? 300 : 2_100,
});
const settings = { ...DEFAULT_SETTINGS, treasury: null, jupiterProgram: JUPITER_PROGRAM };
// A public exchange wallet holding SOL and USDC: simulation only, nothing is signed.
const OWNER = address('GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE');
const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const PROGRAMS: [string, Address][] = [
  ['Jupiter', JUPITER_PROGRAM],
  ['Pump.fun curve', address('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')],
  ['PumpSwap', address('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')],
  ['Token-2022', address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')],
];

type Verdict = 'ok' | 'warn' | 'fail';
const verdicts: Verdict[] = [];
const report = (v: Verdict, name: string, detail: string) => {
  verdicts.push(v);
  console.log(`${v === 'ok' ? 'OK  ' : v === 'warn' ? 'WARN' : 'FAIL'} ${name} — ${detail}`);
};

/** Load and moving prices say nothing about Bound or Jupiter's format; everything else does. */
const LOAD = new Set(['busy', 'unavailable', 'price-moved', 'costs-more']);

async function executes(prepared: PreparedSwap): Promise<{ ok: boolean; error: string }> {
  const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(prepared.transaction), {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
  }).send();
  return { ok: value.err === null, error: JSON.stringify(value.err, (_, x) => (typeof x === 'bigint' ? x.toString() : x)) };
}

/** Builds and executes one swap, once more if the price moved in between. */
async function swap(name: string, inputMint: Address, outputMint: Address, amountIn: bigint, want?: string): Promise<'done' | 'elsewhere' | 'failed'> {
  const mints = await fetchMints(rpc, [inputMint, outputMint]);
  for (let round = 0; round < 2; round++) {
    let prepared: PreparedSwap;
    try {
      prepared = await prepareProtectedSwap({ rpc, jupiter, settings }, {
        owner: OWNER, ephemeral: await createEphemeral(), inputMint, outputMint, amountIn,
        inputDecimals: mints.get(inputMint)!.decimals, outputDecimals: mints.get(outputMint)!.decimals, version: 0, acceptedCostBps: 5_000n,
      });
    } catch (e) {
      const code = e instanceof BoundError ? e.code : 'error';
      if (want && code === 'no-route') return 'elsewhere';
      if (LOAD.has(code) && round === 0) continue;
      report(LOAD.has(code) || code === 'error' ? 'warn' : 'fail', name, `not built: ${code}: ${(e as Error).message.slice(0, 200)}`);
      return 'failed';
    }
    const route = prepared.quote.route.join(' > ');
    if (want && !prepared.quote.route.includes(want)) return 'elsewhere';
    const run = await executes(prepared);
    if (!run.ok && /6001|"Custom":1\b/.test(run.error) && round === 0) continue; // the price moved: once more
    const refund = prepared.policy.routeRefund > 0n ? `, the market's account closed and ${prepared.policy.routeRefund} lamports returned` : '';
    report(run.ok ? 'ok' : 'fail', name, run.ok ? `built, verified and executed: ${route}${refund}` : `the final transaction fails: ${run.error}`);
    return run.ok ? 'done' : 'failed';
  }
  report('warn', name, 'the price kept moving past the tolerance');
  return 'failed';
}

// When each program was last deployed: a recent date is where to look first if something fails.
const [slot, perf] = await Promise.all([
  rpc.getSlot({ commitment: 'confirmed' }).send(),
  rpc.getRecentPerformanceSamples(10).send(),
]);
const msPerSlot = (1000 * perf.reduce((s, p) => s + p.samplePeriodSecs, 0)) / Math.max(1, perf.reduce((s, p) => s + Number(p.numSlots), 0));
console.log(`Slots: ${msPerSlot.toFixed(0)} ms; a transaction lives 150 blocks, about ${Math.round((150 * msPerSlot) / 1000)} s.`);
for (const [name, program] of PROGRAMS) {
  const account = await rpc.getAccountInfo(program, { encoding: 'base64' }).send();
  const data = Buffer.from(account.value!.data[0], 'base64');
  if (data.readUInt32LE(0) !== 2) continue;
  const programData = getAddressDecoder().decode(data.subarray(4, 36));
  const header = await rpc.getAccountInfo(programData, { encoding: 'base64', dataSlice: { offset: 4, length: 8 } }).send();
  const deployed = Buffer.from(header.value!.data[0], 'base64').readBigUInt64LE(0);
  console.log(`${name}: last deployed ${((Number(slot - deployed) * msPerSlot) / 86_400_000).toFixed(1)} days ago (slot ${deployed})`);
}
console.log('');

await swap('USDC → SOL', USDC, WSOL_MINT, 10_000_000n);
await swap('SOL → USDC', WSOL_MINT, USDC, 50_000_000n);

// A Pump.fun token still on its bonding curve: the newest are listed separately.
type Listed = { id: string; symbol: string };
const recent = await fetch('https://lite-api.jup.ag/tokens/v2/recent').then(r => r.json() as Promise<Listed[]>).catch(() => [] as Listed[]);
let curve: 'done' | 'elsewhere' | 'failed' = 'elsewhere';
for (const t of recent.filter(x => x.id.endsWith('pump')).slice(0, 8)) {
  curve = await swap(`SOL → ${t.symbol} (Pump.fun curve)`, WSOL_MINT, address(t.id), 20_000_000n, 'Pump.fun');
  if (curve !== 'elsewhere') break;
}
if (curve === 'elsewhere') report('warn', 'Pump.fun curve', 'no recent token routed through a bonding curve');

const failed = verdicts.filter(v => v === 'fail').length;
console.log(`\n${verdicts.filter(v => v === 'ok').length} ok, ${verdicts.filter(v => v === 'warn').length} warnings, ${failed} failures.`);
process.exitCode = failed ? 1 : 0;
