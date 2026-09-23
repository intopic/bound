/**
 * Research for review FA-05: can the account Pump.fun opens for every buyer be closed inside the
 * same transaction, so its rent (about 0.0013 SOL) goes back to the user instead of staying under
 * the one-time key E?
 *
 * Builds a real protected buy through the bonding curve (the pipeline, unchanged), then appends
 *   close_user_volume_accumulator  (Pump's IDL: user = E signs; the account is PDA["user_volume_accumulator", E])
 *   a System transfer of what the close returned, from E back to the wallet
 * and simulates it on mainnet state. Reports whether it executes, what E ends with, and the size.
 * Nothing is signed or sent. This is not wired into Bound: it answers whether it could be.
 *
 *   node tests/integration/pump-accumulator.ts [--tokens 3]
 */
import {
  address, appendTransactionMessageInstruction, compileTransaction, compressTransactionMessageUsingAddressLookupTables,
  decompileTransactionMessage, fetchAddressesForLookupTables, getAddressEncoder, getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder, getProgramDerivedAddress, getTransactionSize, AccountRole,
} from '@solana/kit';
import type { Address, Instruction } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { createNoopSigner } from '@solana/kit';
import { JUPITER_PROGRAM, PUMP_CURVE_PROGRAM, WSOL_MINT } from '@bound/core';
import { createEphemeral, createRetryingRpc, fetchMints } from '@bound/solana';
import { createJupiterClient, DEFAULT_SETTINGS, prepareProtectedSwap } from '@bound/jupiter';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const WANTED = Number(arg('tokens', '3'));
const rpc = createRetryingRpc(process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com', 8);
const jupiter = createJupiterClient({
  buildUrl: 'https://api.jup.ag/swap/v2/build',
  tokensUrl: 'https://lite-api.jup.ag/tokens/v2/search',
  labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label',
  apiKey: process.env.JUPITER_API_KEY,
  minIntervalMs: 1100,
});
const BUYER = address('GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE');
const settings = { ...DEFAULT_SETTINGS, treasury: null, jupiterProgram: JUPITER_PROGRAM };
const CLOSE_ACCUMULATOR = new Uint8Array([249, 69, 164, 218, 150, 103, 84, 138]);
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? Number(x) : x));

const seed = (s: string) => new TextEncoder().encode(s);
const [eventAuthority] = await getProgramDerivedAddress({ programAddress: PUMP_CURVE_PROGRAM, seeds: [seed('__event_authority')] });

type Listed = { id: string; symbol: string };
const list = async (url: string) => fetch(url).then(r => r.json() as Promise<Listed[]>).catch(() => [] as Listed[]);
const listed = [...await list('https://lite-api.jup.ag/tokens/v2/recent'), ...await list('https://lite-api.jup.ag/tokens/v2/toptrending/1h?limit=100')];
const candidates = listed.filter((t, i) => t.id.endsWith('pump') && listed.findIndex(x => x.id === t.id) === i);

async function simulate(ixs: Instruction[], base: ReturnType<typeof decompileTransactionMessage>, tables: Record<string, Address[]>, watch: Address[]) {
  let message = base;
  for (const ix of ixs) message = appendTransactionMessageInstruction(ix, message as never) as never;
  const tx = compileTransaction(compressTransactionMessageUsingAddressLookupTables(message as never, tables as never) as never);
  const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(tx), {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
    accounts: { addresses: watch, encoding: 'base64' },
  }).send();
  const logs = (value.logs ?? []).filter(l => /rror|failed|insufficient/.test(l)).slice(-3).join(' | ');
  return { ok: value.err === null, err: value.err ? `${json(value.err)} ${logs}` : '', size: getTransactionSize(tx), after: value.accounts ?? [] };
}

let done = 0;
for (const t of candidates) {
  if (done >= WANTED) break;
  const mint = address(t.id);
  const info = (await fetchMints(rpc, [mint])).get(mint);
  if (!info?.exists) continue;
  let prepared;
  try {
    prepared = await prepareProtectedSwap({ rpc, jupiter, settings }, {
      owner: BUYER, ephemeral: await createEphemeral(), inputMint: WSOL_MINT, outputMint: mint, amountIn: 20_000_000n,
      inputDecimals: 9, outputDecimals: info.decimals, version: 1, acceptedCostBps: 5_000n,
    });
  } catch {
    continue;
  }
  if (!prepared.quote.route.includes('Pump.fun')) continue;
  done++;
  const E = prepared.policy.ephemeral;
  const [accumulator] = await getProgramDerivedAddress({
    programAddress: PUMP_CURVE_PROGRAM, seeds: [seed('user_volume_accumulator'), getAddressEncoder().encode(E)],
  });
  const compiled = getCompiledTransactionMessageDecoder().decode(prepared.transaction.messageBytes) as unknown as {
    addressTableLookups?: { lookupTableAddress: Address }[];
  };
  const tables = await fetchAddressesForLookupTables((compiled.addressTableLookups ?? []).map(l => l.lookupTableAddress), rpc as never) as Record<string, Address[]>;
  const base = decompileTransactionMessage(compiled as never, { addressesByLookupTableAddress: tables as never });

  const close: Instruction = {
    programAddress: PUMP_CURVE_PROGRAM,
    accounts: [
      { address: E, role: AccountRole.WRITABLE_SIGNER },
      { address: accumulator, role: AccountRole.WRITABLE },
      { address: eventAuthority, role: AccountRole.READONLY },
      { address: PUMP_CURVE_PROGRAM, role: AccountRole.READONLY },
    ],
    data: CLOSE_ACCUMULATOR,
  };
  const plain = await simulate([], base, tables, [E, accumulator]);
  const closed = await simulate([close], base, tables, [E, accumulator]);
  const back = BigInt(closed.after[0]?.lamports ?? 0);
  const returned = back > 0n
    ? await simulate([close, getTransferSolInstruction({ source: createNoopSigner(E), destination: BUYER, amount: back })], base, tables, [E, accumulator])
    : null;
  console.log(`${t.symbol.padEnd(10)} route ${prepared.quote.route.join(' > ')}, route rent ${prepared.policy.takerRent}`);
  console.log(`  as built:          ${plain.ok ? 'executes' : `fails ${plain.err}`}; accumulator after: ${plain.after[1] ? `${plain.after[1].lamports} lamports` : 'none'}; ${plain.size} bytes`);
  console.log(`  + close:           ${closed.ok ? 'executes' : `fails ${closed.err}`}; E after: ${back} lamports; accumulator after: ${closed.after[1] && BigInt(closed.after[1].lamports) > 0n ? 'still there' : 'gone'}; ${closed.size} bytes`);
  if (returned) console.log(`  + close + return:  ${returned.ok ? 'executes' : `fails ${returned.err}`}; E after: ${returned.after[0]?.lamports ?? 0} lamports; ${returned.size} bytes (v1: no lookup tables; limit 4096)`);
}
if (!done) console.log('No bonding-curve route found among the listed tokens; try again later.');
