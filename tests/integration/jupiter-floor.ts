/**
 * Jupiter's own floor, on mainnet state (review FA-03).
 *
 * The verifier reads Jupiter's route arguments (in amount, quoted out amount, tolerance) because
 * Jupiter's program stops a swap whose instruction delivers less than the quote less the tolerance,
 * and that check does not depend on what the destination account held before. This proves the second
 * half: a plain Jupiter swap into a destination that already holds far more than the whole quote is
 * simulated with the honest arguments and with the quote raised a thousandfold. If Jupiter measured
 * the account's balance, both would pass; it must stop the second with 6001 (SlippageToleranceExceeded).
 *
 * Also checks that /swap/v2/build still answers with an instruction the verifier can read, and that
 * its arguments equal the JSON. Nothing is signed or sent.
 *
 *   node tests/integration/jupiter-floor.ts
 */
import {
  address, appendTransactionMessageInstructions, compileTransaction, compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage, getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import type { Address, Instruction } from '@solana/kit';
import { ataOf } from '@bound/core';
import { createRetryingRpc } from '@bound/solana';
import { createJupiterClient, toKitInstruction } from '@bound/jupiter';
import { jupiterRouteArgs } from '@bound/verifier';

const RPC = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDT = address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
// A public exchange wallet that holds USDC, used as the taker; nothing is signed.
const TAKER = address('GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE');
const AMOUNT = 10_000_000n; // 10 USDC

const rpc = createRetryingRpc(RPC);
const jupiter = createJupiterClient({
  buildUrl: 'https://api.jup.ag/swap/v2/build',
  tokensUrl: 'https://api.jup.ag/tokens/v2/search',
  labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label',
  apiKey: process.env.JUPITER_API_KEY,
  minIntervalMs: 2_100,
});

const results: [string, boolean, string][] = [];
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? Number(x) : x));
const check = (name: string, ok: boolean, detail = '') => {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// A destination that already holds far more than a thousand times the quote: the USDT account of
// a large exchange wallet (the public RPC refuses getTokenLargestAccounts). DESTINATION overrides.
const EXCHANGES = [
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', 'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5',
  'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS',
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2', '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm',
].map(a => address(a));
const candidates = process.env.DESTINATION
  ? [address(process.env.DESTINATION)]
  : await Promise.all(EXCHANGES.map(owner => ataOf(owner, USDT)));
const balances = await Promise.all(candidates.map(a =>
  rpc.getTokenAccountBalance(a).send().then(r => BigInt(r.value.amount)).catch(() => 0n)));
const best = balances.indexOf(balances.reduce((m, b) => (b > m ? b : m), 0n));
const destination = candidates[best] as Address;
const held = balances[best];

const r = await jupiter.build({
  inputMint: USDC, outputMint: USDT, amount: AMOUNT, taker: TAKER, slippageBps: 50, maxAccounts: 64,
  destinationTokenAccount: destination,
});
const swap = toKitInstruction(r.swapInstruction);
const args = jupiterRouteArgs(swap.data ?? new Uint8Array());
check('/swap/v2/build answers with an instruction the verifier can read', !!args, `route ${r.routePlan.map(p => p.swapInfo.label).join(' > ')}`);
check(
  'its arguments equal the JSON answer',
  !!args && args.inAmount === BigInt(r.inAmount) && args.quotedOutAmount === BigInt(r.outAmount) && args.slippageBps === 50
    && args.platformFeeBps === 0 && args.positiveSlippageBps === 0,
  args ? `in ${args.inAmount}, quoted ${args.quotedOutAmount}, ${args.slippageBps} bps` : 'unreadable',
);

async function simulate(data: Uint8Array) {
  const { value: lifetime } = await rpc.getLatestBlockhash().send();
  const ixs: Instruction[] = [
    ...r.computeBudgetInstructions.map(toKitInstruction),
    ...r.setupInstructions.map(toKitInstruction),
    { ...swap, data },
    ...(r.cleanupInstruction ? [toKitInstruction(r.cleanupInstruction)] : []),
  ];
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(TAKER, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    m => appendTransactionMessageInstructions(ixs, m),
  );
  const compressed = r.addressesByLookupTableAddress
    ? compressTransactionMessageUsingAddressLookupTables(message, r.addressesByLookupTableAddress as never)
    : message;
  const wire = getBase64EncodedWireTransaction(compileTransaction(compressed));
  const { value } = await rpc
    .simulateTransaction(wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' })
    .send();
  return { err: value.err, logs: value.logs ?? [] };
}

const honest = await simulate(swap.data as Uint8Array);
check('the honest route executes', honest.err === null, json(honest.err));

if (args) {
  const inflated = Uint8Array.from(swap.data as Uint8Array);
  const base = inflated[0] === 0xbb ? 8 : 9;
  new DataView(inflated.buffer).setBigUint64(base + 8, args.quotedOutAmount * 1000n, true);
  const raised = await simulate(inflated);
  const stopped = json(raised.err ?? null).includes('6001') || raised.logs.some(l => l.includes('0x1771'));
  check(
    'with the quote raised a thousandfold, Jupiter stops it (6001) although the destination holds far more',
    stopped && held > args.quotedOutAmount * 1000n,
    `destination holds ${held}, the raised threshold is about ${(args.quotedOutAmount * 1000n * 9950n) / 10_000n}; ${json(raised.err)}`,
  );
}

const failed = results.filter(x => !x[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exitCode = failed ? 1 : 0;
