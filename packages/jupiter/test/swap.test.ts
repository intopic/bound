/**
 * Route selection: a route whose accounts, together with Bound's own, exceed Solana's 64-account
 * limit must count as "does not fit" (try a smaller maxAccounts), not crash the pipeline. Seen on
 * mainnet with USDC → HNT on 19 September 2026.
 */
import { describe, expect, it } from 'vitest';
import {
  AccountRole, appendTransactionMessageInstruction, compileTransaction, createNoopSigner, createTransactionMessage,
  generateKeyPairSigner, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import type { Address, Blockhash } from '@solana/kit';
import { compileIfFits } from '../src/swap.ts';

async function transactionWith(accountCount: number) {
  const payer = createNoopSigner((await generateKeyPairSigner()).address);
  const accounts = await Promise.all(
    Array.from({ length: accountCount }, async () => ({ address: (await generateKeyPairSigner()).address as Address, role: AccountRole.WRITABLE })),
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(payer, m),
    m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 1n }, m),
    m => appendTransactionMessageInstruction({ programAddress: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' as Address, accounts, data: new Uint8Array([1]) }, m),
  );
  return () => compileTransaction(message);
}

describe('route selection', () => {
  it('a route over the 64-account limit does not fit', async () => {
    expect(compileIfFits(await transactionWith(70))).toBeNull();
  });

  it('a route within the limit compiles', async () => {
    expect(compileIfFits(await transactionWith(40))).not.toBeNull();
  });

  it('any other compile error still surfaces', () => {
    expect(() => compileIfFits(() => { throw new Error('boom'); })).toThrow('boom');
  });
});
