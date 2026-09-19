/**
 * The certificate (idea 35): issued only for a transaction that passed every rule, bound to its
 * exact bytes, and stating what the user approved.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { compileProtectedSwap, JUPITER_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from '@bound/core';
import type { TxVersion } from '@bound/core';
import { certificateJson, certify, VERIFIER_VERSION } from '../src/index.ts';
import { BONK, compileRaw, cuIxs, honest, LIFETIME, randomAddress, scenario, USDC } from './fixtures.ts';
import type { Scenario } from './fixtures.ts';
import { getTransferCheckedInstruction } from '@solana-program/token';
import { createNoopSigner } from '@solana/kit';

const compileHonest = (s: Scenario, version: TxVersion) =>
  compileProtectedSwap({
    policy: s.policy, swapInstruction: s.swapIx, intermediates: s.intermediates, version, lifetime: LIFETIME,
    computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n, priorityFeeLamports: 20_000n,
    lookupTables: version === 0 ? s.lookupTables : undefined, outputBalanceBefore: s.wOutBalance,
  }).transaction;

describe('certificate', () => {
  for (const [name, opts] of [['USDC → SOL', {}], ['USDC → BONK', { input: USDC, output: BONK }]] as const) {
    for (const version of [0, 1] as const) {
      it(`${name}, v${version}: states what the user approved, bound to the exact bytes`, async () => {
        const s = await scenario(opts);
        const tx = compileHonest(s, version);
        const result = await certify(tx, s.policy, s.snapshot);
        if (!result.ok) throw new Error(JSON.stringify(result.violations));
        const c = result.certificate;
        expect(c.verifierVersion).toBe(VERIFIER_VERSION);
        expect(c.transactionVersion).toBe(version);
        expect(c.messageSha256).toBe(createHash('sha256').update(Uint8Array.from(tx.messageBytes)).digest('hex'));
        expect(c.input.totalDebit).toBe(s.policy.amountIn);
        expect(c.input.swapAmount + c.input.boundFee).toBe(c.input.totalDebit);
        expect(c.output.minimumOutput).toBe(s.policy.minOut);
        expect(c.signers).toEqual([s.W, s.E.address]);
        expect(c.programs).toContain(JUPITER_PROGRAM);
        expect(c.programs).toContain(TOKEN_PROGRAM);
        expect(c.otherAssetDebit).toBe(0);
        expect(c.persistentPermissions).toBe(0);
        expect(JSON.parse(certificateJson(c)).input.totalDebit).toBe(s.policy.amountIn.toString());
      });
    }
  }

  it('is never issued for a transaction that fails a rule', async () => {
    const s = await scenario();
    const stray = getTransferCheckedInstruction({
      source: s.policy.accounts.wIn!, mint: USDC, destination: await randomAddress(), authority: createNoopSigner(s.W),
      amount: 1n, decimals: 6,
    });
    const tx = compileRaw(s.W, [...cuIxs(), ...honest(s), stray], 0, s.lookupTables);
    const result = await certify(tx, s.policy, s.snapshot);
    expect(result.ok).toBe(false);
    expect('certificate' in result).toBe(false);
  });

  it('a SOL output names WSOL as the output mint', async () => {
    const s = await scenario();
    const result = await certify(compileHonest(s, 1), s.policy, s.snapshot);
    expect(result.ok && result.certificate.output.mint).toBe(WSOL_MINT);
  });
});
