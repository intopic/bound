import { describe, expect, it } from 'vitest';
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  generateKeyPairSigner, getTransactionEncoder, pipe, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import type { Address, Instruction } from '@solana/kit';
import { diagnoseWalletReturn, reportText } from '../lib/client/diagnose';

const LIFETIME = {
  blockhash: '11111111111111111111111111111111' as never,
  lastValidBlockHeight: 10_000n,
};

const ix = (program: Address, account: Address, data: number[]): Instruction => ({
  programAddress: program,
  accounts: [{ address: account, role: AccountRole.READONLY }],
  data: new Uint8Array(data),
});

const wire = (feePayer: Address, instructions: Instruction[]) =>
  new Uint8Array(getTransactionEncoder().encode(compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
    m => appendTransactionMessageInstructions(instructions, m),
  ))));

const addresses = async (n: number) =>
  (await Promise.all(Array.from({ length: n }, () => generateKeyPairSigner()))).map(s => s.address);

describe('what a wallet did to the transaction it signed', () => {
  it('reports an untouched message as identical, with nothing added', async () => {
    const [W, program, target] = await addresses(3);
    const bytes = wire(W, [ix(program, target, [1, 2, 3])]);
    const d = diagnoseWalletReturn(bytes, bytes);
    expect(d.identical).toBe(true);
    expect(d.placement).toBe('none');
    expect(d.findings).toEqual([]);
    expect(d.newAccounts).toEqual([]);
  });

  it('names an appended guard as a suffix and describes it', async () => {
    const [W, program, target, guard] = await addresses(4);
    const ours = [ix(program, target, [1, 2, 3]), ix(program, target, [9])];
    const d = diagnoseWalletReturn(wire(W, ours), wire(W, [...ours, ix(guard, target, [10, 0, 5])]));

    expect(d.identical).toBe(false);
    expect(d.placement).toBe('suffix');
    expect(d.addedBefore).toEqual([]);
    expect(d.addedAfter).toHaveLength(1);
    expect(d.addedAfter[0].program).toBe(guard);
    expect(d.addedAfter[0].discriminator).toBe(10);
    expect(d.addedAfter[0].accounts.map(a => a.address)).toEqual([target]);
    expect(d.newAccounts).toEqual([guard]);
    expect(d.newSigners).toEqual([]);
    expect(d.changedFeePayer).toBe(false);
    expect(d.changedBlockhash).toBe(false);
  });

  it('separates an instruction added before ours from one appended after', async () => {
    const [W, program, target, guard] = await addresses(4);
    const ours = [ix(program, target, [1, 2, 3])];
    const d = diagnoseWalletReturn(
      wire(W, ours),
      wire(W, [ix(guard, target, [0]), ...ours, ix(guard, target, [4])]),
    );
    expect(d.placement).toBe('both');
    expect(d.addedBefore.map(x => x.discriminator)).toEqual([0]);
    expect(d.addedAfter.map(x => x.discriminator)).toEqual([4]);
    expect(d.findings.some(f => f.includes('BEFORE'))).toBe(true);
  });

  it('refuses to call it an addition when our own instructions came back changed', async () => {
    const [W, program, target, other] = await addresses(4);
    const d = diagnoseWalletReturn(
      wire(W, [ix(program, target, [1, 2, 3])]),
      wire(W, [ix(program, other, [1, 2, 3])]),
    );
    expect(d.placement).toBe('not-aligned');
    expect(d.changedPositions).toEqual([0]);
    expect(d.addedAfter).toEqual([]);
    expect(d.findings.some(f => f.includes('did not come back intact'))).toBe(true);
  });

  it('notices a new signer and a changed fee payer', async () => {
    const [W, other, program, target] = await addresses(4);
    const d = diagnoseWalletReturn(
      wire(W, [ix(program, target, [1])]),
      wire(other, [ix(program, target, [1])]),
    );
    expect(d.changedFeePayer).toBe(true);
    expect(d.newSigners).toEqual([other]);
    expect(d.findings.some(f => f.includes('fee payer'))).toBe(true);
  });

  it('writes a report that carries the added instruction and its accounts', async () => {
    const [W, program, target, guard] = await addresses(4);
    const ours = [ix(program, target, [1])];
    const d = diagnoseWalletReturn(wire(W, ours), wire(W, [...ours, ix(guard, target, [10, 0, 5])]));
    const text = reportText('Phantom 25.9.0', d);
    expect(text).toContain('Phantom 25.9.0');
    expect(text).toContain(guard);
    expect(text).toContain('selector 10');
    expect(text).toContain(target);
  });
});
