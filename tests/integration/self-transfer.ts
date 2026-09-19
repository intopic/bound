/**
 * Confirms the mechanism behind the B-04 fix on mainnet state (simulation only, nothing sent):
 * a self-TransferChecked is a no-op when the balance covers the amount and fails with
 * InsufficientFunds (custom error 1) when it does not.
 *
 *   node tests/integration/self-transfer.ts
 */
import {
  address, appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createSolanaRpc,
  createTransactionMessage, getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { findAssociatedTokenPda, getTransferCheckedInstruction } from '@solana-program/token';

const rpc = createSolanaRpc(process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com');
const W = address('GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE'); // public exchange wallet
const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const [ata] = await findAssociatedTokenPda({ owner: W, mint: USDC, tokenProgram: TOKEN });
const { value: bal } = await rpc.getTokenAccountBalance(ata, { commitment: 'confirmed' }).send();
const balance = BigInt(bal.amount);
const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();

async function selfTransfer(amount: bigint) {
  const tx = compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(W, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    m => appendTransactionMessageInstructions([
      getTransferCheckedInstruction({ source: ata, mint: USDC, destination: ata, authority: createNoopSigner(W), amount, decimals: 6 }),
    ], m),
  ));
  const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(tx), {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
    accounts: { addresses: [ata], encoding: 'base64' },
  }).send();
  const after = value.accounts?.[0] ? Buffer.from(value.accounts[0].data[0], 'base64').readBigUInt64LE(64) : null;
  return { err: value.err, after, logs: (value.logs ?? []).filter(l => /Error|error|failed/.test(l)) };
}

console.log(`USDC balance: ${balance}`);
const cases: [string, bigint, boolean][] = [
  ['amount well below the balance', balance / 2n, true],
  ['amount equal to a balance-sized floor minus 1 USDC', balance - 1_000_000n, true],
  ['amount above the balance by 1 000 USDC', balance + 1_000_000_000n, false],
  ['absurd amount', 10n ** 18n, false],
];
let ok = true;
for (const [name, amount, shouldPass] of cases) {
  const r = await selfTransfer(amount);
  const passed = r.err === null;
  const unchanged = r.after === null || r.after >= balance - 5_000_000_000n; // exchange wallet may move a little
  const good = passed === shouldPass && (!passed || unchanged);
  ok &&= good;
  console.log(`${good ? 'OK ' : 'FAIL'} ${name}: ${passed ? 'succeeded' : `failed ${JSON.stringify(r.err, (_, v) => (typeof v === "bigint" ? Number(v) : v))}`}${r.logs.length ? ` — ${r.logs.join(' | ')}` : ''}`);
}
process.exit(ok ? 0 : 1);
