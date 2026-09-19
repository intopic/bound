import { describe, expect, it } from 'vitest';
import { AccountRole, generateKeyPairSigner } from '@solana/kit';
import type { Address, Instruction } from '@solana/kit';
import {
  AuthorityType, getApproveInstruction, getCloseAccountInstruction, getSetAuthorityInstruction,
} from '@solana-program/token';
import { getAssignInstruction, getTransferSolInstruction } from '@solana-program/system';
import { createNoopSigner } from '@solana/kit';
import { compileProtectedSwap, JUPITER_PROGRAM, TOKEN_2022_PROGRAM, WSOL_MINT } from '@bound/core';
import type { RuleId, TxVersion } from '@bound/core';
import { verify } from '../src/index.ts';
import { BONK, compileRaw, cuIxs, honest, LIFETIME, randomAddress, scenario, USDC } from './fixtures.ts';
import type { Scenario } from './fixtures.ts';

const rules = (v: { violations: { rule: RuleId }[] }) => [...new Set(v.violations.map(x => x.rule))];

async function compileHonest(s: Scenario, version: TxVersion) {
  return compileProtectedSwap({
    policy: s.policy, swapInstruction: s.swapIx, intermediates: s.intermediates, version, lifetime: LIFETIME,
    computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n, priorityFeeLamports: 20_000n,
    lookupTables: version === 0 ? s.lookupTables : undefined, outputBalanceBefore: s.wOutBalance,
  }).transaction;
}

/** Compile a mutated instruction list with the same shape the honest compiler uses. */
const mutated = (s: Scenario, ixs: Instruction[], version: TxVersion = 0, alt = version === 0) =>
  compileRaw(s.W, version === 0 ? [...cuIxs(), ...ixs] : ixs, version, alt ? s.lookupTables : undefined);

const swapIndex = (ixs: Instruction[]) => ixs.findIndex(ix => ix.programAddress === JUPITER_PROGRAM);

const withSwapAccounts = (s: Scenario, extra: { address: Address; role: AccountRole }[]) => {
  const ixs = honest(s);
  const i = swapIndex(ixs);
  ixs[i] = { ...ixs[i], accounts: [...(ixs[i].accounts ?? []), ...extra] };
  return ixs;
};

describe('honest protected swaps are accepted', () => {
  const cases: [string, Parameters<typeof scenario>[0]][] = [
    ['A: USDC → SOL', {}],
    ['B: SOL → USDC', { input: WSOL_MINT, output: USDC }],
    ['C: USDC → BONK', { input: USDC, output: BONK }],
    ['no fee (test mode)', { fee: false }],
    ['no fee account: fee waived', { feeAccountExists: false }],
    ['two intermediate accounts', { input: USDC, output: BONK, intermediates: 2 }],
  ];
  for (const [name, opts] of cases) {
    for (const version of [0, 1] as const) {
      it(`${name}, v${version}`, async () => {
        const s = await scenario(opts);
        const verdict = await verify(await compileHonest(s, version), s.policy, s.snapshot);
        expect(verdict.violations).toEqual([]);
        expect(verdict.ok).toBe(true);
      });
    }
  }
});

describe('T2: mutation catalogue (plan, section 9)', () => {
  it('M1: W in the swap instruction → R1', async () => {
    const s = await scenario();
    const v = await verify(mutated(s, withSwapAccounts(s, [{ address: s.W, role: AccountRole.WRITABLE }])), s.policy, s.snapshot);
    expect(rules(v)).toContain('R1');
  });

  it("M2: W's input token account hidden in an ALT → R1", async () => {
    const s = await scenario();
    s.lookupTables[s.lookupTable].push(s.policy.accounts.wIn!);
    const tx = mutated(s, withSwapAccounts(s, [{ address: s.policy.accounts.wIn!, role: AccountRole.READONLY }]));
    const v = await verify(tx, s.policy, s.snapshot);
    expect(rules(v)).toContain('R1');
  });

  it("M3: W's input token account passed directly → R1", async () => {
    const s = await scenario();
    const tx = mutated(s, withSwapAccounts(s, [{ address: s.policy.accounts.wIn!, role: AccountRole.WRITABLE }]), 1);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R1');
  });

  it("M4: another of W's token accounts (WIF) via an ALT → R1", async () => {
    const s = await scenario();
    s.lookupTables[s.lookupTable].push(s.wOther);
    const tx = mutated(s, withSwapAccounts(s, [{ address: s.wOther, role: AccountRole.WRITABLE }]));
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R1');
  });

  it('M5: an added Approve → R2', async () => {
    const s = await scenario();
    const ixs = honest(s);
    ixs.splice(1, 0, getApproveInstruction({ source: s.policy.accounts.wIn!, delegate: s.E.address, owner: createNoopSigner(s.W), amount: 10n ** 12n }));
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it("M6: SetAuthority on one of W's accounts → R2", async () => {
    const s = await scenario();
    const attacker = await randomAddress();
    const ixs = honest(s);
    ixs.push(getSetAuthorityInstruction({ owned: s.wOther, owner: createNoopSigner(s.W), authorityType: AuthorityType.AccountOwner, newAuthority: attacker }));
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('M7: CloseAccount to the attacker → R2', async () => {
    const s = await scenario();
    const attacker = await randomAddress();
    const ixs = honest(s).map(ix =>
      ix.data?.[0] === 9 && ix.accounts?.[0].address === s.policy.accounts.eIn
        ? getCloseAccountInstruction({ account: s.policy.accounts.eIn, destination: attacker, owner: createNoopSigner(s.E.address) })
        : ix,
    );
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('M8: the input transfer is q − f + 1 → R2', async () => {
    const s = await scenario();
    const evil = { ...s.policy, swapAmount: s.policy.swapAmount + 1n };
    const tx = compileProtectedSwap({
      policy: evil, swapInstruction: s.swapIx, intermediates: [], version: 0, lifetime: LIFETIME,
      computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n, lookupTables: s.lookupTables,
    }).transaction;
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R2');
  });

  it('M9: a program other than Jupiter as the swap → R2', async () => {
    const s = await scenario();
    const ixs = honest(s);
    const i = swapIndex(ixs);
    ixs[i] = { ...ixs[i], programAddress: await randomAddress() };
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('M10: two untrusted instructions → R2', async () => {
    const s = await scenario();
    const ixs = honest(s);
    ixs.splice(swapIndex(ixs), 0, s.swapIx);
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('M11: E already exists on chain with a balance → R3', async () => {
    const s = await scenario();
    (s.snapshot.accounts as Map<string, unknown>).set(s.E.address, { owner: s.W, lamports: 5_000_000n, data: new Uint8Array() });
    expect(rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot))).toContain('R3');
  });

  it('M12: an extreme compute unit price → R4', async () => {
    const s = await scenario();
    const tx = compileRaw(s.W, [...cuIxs(1_400_000, 10_000_000n), ...honest(s)], 0, s.lookupTables);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R4');
  });

  it('M13: missing compute unit limit (v0) → R4', async () => {
    const s = await scenario();
    const tx = compileRaw(s.W, [cuIxs()[1], ...honest(s)], 0, s.lookupTables);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R4');
  });

  it('M14a: the E_in close is missing → R5', async () => {
    const s = await scenario();
    const ixs = honest(s).filter(ix => !(ix.data?.[0] === 9 && ix.accounts?.[0].address === s.policy.accounts.eIn));
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R5');
  });

  it('M14b: a v0 transaction over 1232 bytes → R5', async () => {
    const s = await scenario({ poolCount: 40 });
    const tx = mutated(s, honest(s), 0, false);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R5');
  });

  it('M15a: a third signer → R6', async () => {
    const s = await scenario();
    const tx = mutated(s, withSwapAccounts(s, [{ address: await randomAddress(), role: AccountRole.READONLY_SIGNER }]));
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R6');
  });

  it('M15b: someone else pays the fee → R6', async () => {
    const s = await scenario();
    const tx = compileRaw(await randomAddress(), [...cuIxs(), ...honest(s)], 0, s.lookupTables);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R6');
  });

  it('M16: a Token-2022 input mint → R7', async () => {
    const s = await scenario();
    (s.snapshot.accounts as Map<string, unknown>).set(USDC, { owner: TOKEN_2022_PROGRAM, lamports: 1n, data: new Uint8Array(82) });
    expect(rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot))).toContain('R7');
  });
});

describe('more attacks', () => {
  it('a SOL transfer from W to the attacker → R2', async () => {
    const s = await scenario();
    const ixs = honest(s);
    ixs.splice(2, 0, getTransferSolInstruction({ source: createNoopSigner(s.W), destination: await randomAddress(), amount: 1n }));
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('System Assign of W → R2', async () => {
    const s = await scenario();
    const ixs = honest(s);
    ixs.push(getAssignInstruction({ account: createNoopSigner(s.W), programAddress: await randomAddress() }));
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('a ComputeBudget instruction inside a v1 transaction → R4', async () => {
    const s = await scenario();
    const tx = compileRaw(s.W, [cuIxs()[0], ...honest(s)], 1);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R4');
  });

  it('an intermediate account that is created but never closed → R5', async () => {
    const s = await scenario({ input: USDC, output: BONK, intermediates: 1 });
    const mid = s.intermediates[0].ata;
    const ixs = honest(s).filter(ix => !(ix.data?.[0] === 9 && ix.accounts?.[0].address === mid));
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R5');
  });

  it('a swap placed before the input transfer → R2', async () => {
    const s = await scenario();
    const ixs = honest(s);
    const [swap] = ixs.splice(swapIndex(ixs), 1);
    ixs.unshift(swap);
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('an ALT the verifier cannot resolve → R1', async () => {
    const s = await scenario();
    const tx = await compileHonest(s, 0);
    const v = await verify(tx, s.policy, { ...s.snapshot, lookupTables: {} });
    expect(rules(v)).toContain('R1');
  });

  it('a policy whose fee does not match the config → R2', async () => {
    const s = await scenario();
    const tx = await compileHonest(s, 0);
    const v = await verify(tx, { ...s.policy, fee: s.policy.fee - 1n, swapAmount: s.policy.swapAmount + 1n }, s.snapshot);
    expect(rules(v)).toContain('R2');
  });

  it('the fee transfer redirected to another account → R2', async () => {
    const s = await scenario();
    const evil = { ...s.policy, accounts: { ...s.policy.accounts, feeDestination: await randomAddress() } };
    const tx = compileProtectedSwap({
      policy: evil, swapInstruction: s.swapIx, intermediates: [], version: 1, lifetime: LIFETIME,
      computeUnitLimit: 400_000, priorityFeeLamports: 20_000n,
    }).transaction;
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R2');
  });

  it('a signer other than E owning a temporary account', async () => {
    const s = await scenario();
    const other = await generateKeyPairSigner();
    const ixs = honest(s).map(ix =>
      ix.data?.[0] === 9 && ix.accounts?.[0].address === s.policy.accounts.eIn
        ? getCloseAccountInstruction({ account: s.policy.accounts.eIn, destination: s.W, owner: createNoopSigner(other.address) })
        : ix,
    );
    const v = await verify(mutated(s, ixs), s.policy, s.snapshot);
    expect(v.ok).toBe(false);
    expect(rules(v)).toEqual(expect.arrayContaining(['R2', 'R6']));
  });
});
