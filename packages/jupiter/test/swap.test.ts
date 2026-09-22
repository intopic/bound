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
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '@bound/core';
import { compileIfFits, isMinimumOutputCheckInstruction, strictMinimumOutput } from '../src/swap.ts';

describe('the strict on-chain minimum model', () => {
  const quote = { outAmount: '1000000', otherAmountThreshold: '1' };

  it('never lets a weak router threshold lower Bound\'s slippage floor', () => {
    expect(strictMinimumOutput(quote, 50)).toBe(995_000n);
  });

  it('keeps a stricter minimum already accepted by the user', () => {
    expect(strictMinimumOutput(quote, 50, 999_000n)).toBe(999_000n);
  });

  for (const programAddress of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    it(`recognizes the on-chain self-transfer under ${programAddress}`, () => {
      expect(isMinimumOutputCheckInstruction({
        programAddress,
        data: new Uint8Array([12]),
        accounts: [{ address: 'output' }, { address: 'mint' }, { address: 'output' }],
      })).toBe(true);
    });
  }

  it('does not mistake an ordinary transfer for the minimum check', () => {
    expect(isMinimumOutputCheckInstruction({
      programAddress: TOKEN_PROGRAM,
      data: new Uint8Array([12]),
      accounts: [{ address: 'source' }, { address: 'mint' }, { address: 'destination' }],
    })).toBe(false);
  });
});

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
