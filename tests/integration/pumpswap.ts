/**
 * T13: PumpSwap, the market Pump.fun tokens move to once they leave the bonding curve.
 *
 * PumpSwap opens an account for every buyer and makes the buyer pay its rent. In a Bound swap the
 * buyer is the one-time key E, which holds nothing on purpose, so every PumpSwap route used to fail
 * and the market was excluded. Bound now measures that rent in simulation and sends E exactly it.
 * This runs the real pipeline on mainnet state and checks what matters:
 *
 *   - the route goes through PumpSwap and is built, verified and certified;
 *   - the rent sent to E is above zero and under the ceiling;
 *   - the final transaction executes, at least the minimum arrives, and E ends with nothing — no SOL
 *     left under a key that is about to be discarded.
 *
 * Buys from SOL use a public wallet as fee payer; sells use a real holder of the token, found by
 * listing the token program's accounts for that mint. When none is found the sell is reported as
 * skipped, not as passed. Nothing is signed or sent.
 *
 *   node tests/integration/pumpswap.ts [--tokens 5]
 */
import { address, getAddressDecoder, getBase64EncodedWireTransaction } from '@solana/kit';
import type { Address } from '@solana/kit';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ataOf, JUPITER_PROGRAM, MAX_TAKER_RENT_LAMPORTS, SYSTEM_PROGRAM, tokenAmountOf, WSOL_MINT } from '@bound/core';
import { createEphemeral, createRetryingRpc, fetchAccounts, fetchMints } from '@bound/solana';
import { BoundError, createJupiterClient, DEFAULT_SETTINGS, prepareProtectedSwap } from '@bound/jupiter';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const WANTED = Number(arg('tokens', '5'));
const RPC_URL = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const rpc = createRetryingRpc(RPC_URL, 8);
const jupiter = createJupiterClient({
  buildUrl: 'https://api.jup.ag/swap/v2/build',
  tokensUrl: 'https://lite-api.jup.ag/tokens/v2/search',
  labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label',
  apiKey: process.env.JUPITER_API_KEY,
  minIntervalMs: 1100,
});
const log = (...a: unknown[]) => console.log(...a);
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? Number(x) : x));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const BUYER = address('GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE');
const settings = { ...DEFAULT_SETTINGS, treasury: null, jupiterProgram: JUPITER_PROGRAM };

type Row = { token: string; name: string; ok: boolean | null; detail: string };
const rows: Row[] = [];
const check = (token: string, name: string, ok: boolean | null, detail = '') => {
  rows.push({ token, name, ok, detail });
  log(`${ok === null ? 'SKIP' : ok ? 'OK  ' : 'FAIL'} ${token.padEnd(10)} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Execute the final transaction in simulation and read the accounts that must end empty or full. */
async function execute(transaction: Parameters<typeof getBase64EncodedWireTransaction>[0], watch: Address[]) {
  const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
    accounts: { addresses: watch, encoding: 'base64' },
  }).send();
  const after = (value.accounts ?? []).map(a => (a ? {
    lamports: BigInt(a.lamports), data: Uint8Array.from(Buffer.from(a.data[0], 'base64')),
  } : null));
  const failure = value.err
    ? `${json(value.err)} — ${(value.logs ?? []).filter(l => /Error|error|failed|insufficient/.test(l)).slice(-2).join(' | ')}`
    : '';
  return { ok: value.err === null, failure, after };
}
/** A closed account comes back from a simulation as an empty entry with no lamports. */
const gone = (a: { lamports: bigint; data: Uint8Array } | null) => a === null || (a.lamports === 0n && a.data.length === 0);

/**
 * A plain wallet that holds this token in its associated account. `getTokenLargestAccounts` is
 * rate-limited to nothing on the public RPC, but the token program's own accounts can be listed by
 * mint, reading only owner and amount.
 */
async function holderOf(mint: Address, program: Address): Promise<{ owner: Address; balance: bigint } | null> {
  const res = await fetch(RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getProgramAccounts',
      params: [program, { encoding: 'base64', dataSlice: { offset: 32, length: 40 }, filters: [{ memcmp: { offset: 0, bytes: mint } }] }],
    }),
  }).then(r => r.json() as Promise<{ result?: { pubkey: string; account: { data: [string, string] } }[] }>).catch(() => null);
  const decoder = getAddressDecoder();
  const rows = (res?.result ?? []).map(r => {
    const d = Uint8Array.from(Buffer.from(r.account.data[0], 'base64'));
    return { account: address(r.pubkey), owner: decoder.decode(d.subarray(0, 32)), balance: new DataView(d.buffer, d.byteOffset).getBigUint64(32, true) };
  }).sort((a, b) => (a.balance > b.balance ? -1 : 1)).slice(0, 40);
  const wallets = await fetchAccounts(rpc, rows.map(r => r.owner));
  for (const r of rows) {
    const wallet = wallets.get(r.owner);
    if (!wallet || wallet.owner !== SYSTEM_PROGRAM || wallet.lamports < 50_000_000n || r.balance === 0n) continue;
    if ((await ataOf(r.owner, mint, program)) !== r.account) continue;
    return { owner: r.owner, balance: r.balance };
  }
  return null;
}

type Listed = { id: string; symbol: string; liquidity?: number };
const trending = await (await fetch('https://lite-api.jup.ag/tokens/v2/toptrending/1h?limit=100')).json() as Listed[];
const candidates = trending.filter(t => t.id.endsWith('pump') && (t.liquidity ?? 0) > 5_000);
log(`${candidates.length} Pump.fun tokens trending with over $5k liquidity; looking for ${WANTED} that route through PumpSwap\n`);

let found = 0;
for (const t of candidates) {
  if (found >= WANTED) break;
  const mint = address(t.id);
  const info = (await fetchMints(rpc, [mint])).get(mint);
  if (!info) continue;
  let prepared;
  try {
    prepared = await prepareProtectedSwap({ rpc, jupiter, settings }, {
      owner: BUYER, ephemeral: await createEphemeral(), inputMint: WSOL_MINT, outputMint: mint, amountIn: 20_000_000n,
      inputDecimals: 9, outputDecimals: info.decimals, version: 0, acceptedCostBps: 5_000n,
    });
  } catch (e) {
    log(`     ${t.symbol.padEnd(10)} not built: ${e instanceof BoundError ? e.code : 'error'} ${(e as Error).message.slice(0, 80)}`);
    continue;
  }
  const route = prepared.quote.route.join(' → ');
  if (!route.includes('Pump.fun Amm')) { log(`     ${t.symbol.padEnd(10)} routes elsewhere (${route})`); continue; }
  found++;
  const rent = prepared.policy.takerRent;
  check(t.symbol, 'buy: built, verified and certified through PumpSwap', true, `${route}, ${prepared.size} bajt`);
  check(t.symbol, "buy: the rent sent to the temporary key is the market's, under the ceiling",
    rent > 0n && rent <= MAX_TAKER_RENT_LAMPORTS && prepared.oneTimeCosts.routeRent === rent && prepared.certificate.routeRentLamports === rent,
    `${rent} lamports`);
  const E = prepared.policy.ephemeral;
  const wOut = prepared.policy.accounts.wOut!;
  const before = tokenAmountOf((await fetchAccounts(rpc, [wOut])).get(wOut)?.data);
  let run = await execute(prepared.transaction, [E, prepared.policy.accounts.eIn, wOut]);
  if (!run.ok && run.failure.includes('0x1771')) {
    // Jupiter's 6001, slippage exceeded: the price moved between building and executing, and the
    // minimum reverted the swap as it should. Build once more on the current price.
    log(`     ${t.symbol.padEnd(10)} the price moved past the tolerance; building again`);
    prepared = await prepareProtectedSwap({ rpc, jupiter, settings }, {
      owner: BUYER, ephemeral: await createEphemeral(), inputMint: WSOL_MINT, outputMint: mint, amountIn: 20_000_000n,
      inputDecimals: 9, outputDecimals: info.decimals, version: 0, acceptedCostBps: 5_000n,
    });
    run = await execute(prepared.transaction, [prepared.policy.ephemeral, prepared.policy.accounts.eIn, wOut]);
  }
  check(t.symbol, 'buy: the final transaction executes', run.ok, run.failure);
  if (run.ok) {
    check(t.symbol, 'buy: the temporary key ends with nothing', gone(run.after[0]), run.after[0] ? `${run.after[0].lamports} lamports left` : '');
    check(t.symbol, 'buy: the temporary account is gone', gone(run.after[1]));
    const arrived = run.after[2] ? tokenAmountOf(run.after[2].data) - before : 0n;
    check(t.symbol, 'buy: at least the minimum arrived', arrived >= prepared.policy.minOut, `arritën ${arrived}, minimumi ${prepared.policy.minOut}`);
  }

  // ------------------------------------------------------------ the same token sold back for SOL
  await sleep(2_000);
  const holder = await holderOf(mint, info.program as Address);
  if (!holder) { check(t.symbol, 'sell: needs a holder the public RPC would name', null, 'mbajtësi nuk u gjet'); continue; }
  try {
    const sell = await prepareProtectedSwap({ rpc, jupiter, settings }, {
      owner: holder.owner, ephemeral: await createEphemeral(), inputMint: mint, outputMint: WSOL_MINT,
      amountIn: holder.balance / 100n, inputDecimals: info.decimals, outputDecimals: 9, version: 0, acceptedCostBps: 5_000n,
    });
    const sellRoute = sell.quote.route.join(' → ');
    check(t.symbol, 'sell: built, verified and certified', true, `${sellRoute}, rent ${sell.policy.takerRent}`);
    const done = await execute(sell.transaction, [sell.policy.ephemeral, sell.policy.accounts.eIn, sell.policy.accounts.eOut!]);
    check(t.symbol, 'sell: the final transaction executes', done.ok, done.failure);
    if (done.ok) check(t.symbol, 'sell: the key and both temporary accounts end empty', done.after.every(gone));
  } catch (e) {
    check(t.symbol, 'sell: built, verified and certified', false, `${e instanceof BoundError ? e.code : 'error'}: ${(e as Error).message.slice(0, 200)}`);
  }
}

mkdirSync('tests/integration/results', { recursive: true });
const failed = rows.filter(r => r.ok === false).length;
const skipped = rows.filter(r => r.ok === null).length;
const passed = rows.length - failed - skipped;
writeFileSync('tests/integration/results/pumpswap.md', [
  '# T13 — PumpSwap',
  '',
  `${passed}/${rows.length - skipped} kontrolle kaluan${skipped ? `, ${skipped} u anashkaluan` : ''}, në ${found} tokenë që kalojnë nëpër PumpSwap. Asgjë nuk u nënshkrua e nuk u dërgua.`,
  '',
  '| Tokeni | Kontrolli | Rezultati | Detaji |',
  '| --- | --- | --- | --- |',
  ...rows.map(r => `| ${r.token} | ${r.name} | ${r.ok === null ? 'anashkaluar' : r.ok ? 'kaloi' : 'DËSHTOI'} | ${r.detail || '—'} |`),
  '',
].join('\n'));
log(`\nT13 ${passed}/${rows.length - skipped}${skipped ? ` (${skipped} skipped)` : ''} on ${found} PumpSwap tokens  →  tests/integration/results/pumpswap.md`);
process.exit(failed || found === 0 ? 1 : 0);
