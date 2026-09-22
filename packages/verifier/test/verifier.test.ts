import { describe, expect, it } from 'vitest';
import { AccountRole, address, generateKeyPairSigner, getAddressEncoder } from '@solana/kit';
import type { Address, Instruction } from '@solana/kit';
import {
  AuthorityType, getApproveInstruction, getCloseAccountInstruction, getSetAuthorityInstruction,
} from '@solana-program/token';
import { getAssignInstruction, getTransferSolInstruction } from '@solana-program/system';
import { createNoopSigner } from '@solana/kit';
import { compileProtectedSwap, JUPITER_PROGRAM, protectedInstructions, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from '@bound/core';
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

  it('M16: the mint belongs to another token program than the policy says → R2', async () => {
    const s = await scenario();
    (s.snapshot.accounts as Map<string, unknown>).set(USDC, { owner: TOKEN_2022_PROGRAM, lamports: 1n, data: new Uint8Array(82) });
    expect(rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot))).toContain('R2');
  });
});

/**
 * Token-2022 (phase 3). A mint is swappable only with extensions that cannot touch the swap; the
 * addresses, the transfers and the closes must all use the program the mint really belongs to.
 */
describe('Token-2022', () => {
  const t22 = (extensions: [number, number][]) => scenario({
    input: USDC, output: BONK, inputProgram: TOKEN_2022_PROGRAM, outputProgram: TOKEN_PROGRAM,
    inputExtensions: extensions,
  });

  it('an honest swap of a Token-2022 token with metadata only passes every rule', async () => {
    const s = await t22([[18, 64], [19, 120]]);
    const verdict = await verify(await compileHonest(s, 0), s.policy, s.snapshot);
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('a declared transfer hook with no program set runs no code, so it is accepted', async () => {
    const s = await t22([[18, 64], [14, 64]]);
    expect((await verify(await compileHonest(s, 0), s.policy, s.snapshot)).ok).toBe(true);
  });

  it('a transfer hook with a real program → R7', async () => {
    const s = await t22([[14, 64]]);
    const mint = s.snapshot.accounts.get(USDC)!;
    mint.data[166 + 4 + 32] = 7; // a non-zero program id
    expect(rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot))).toContain('R7');
  });

  // The delegates the real tokens use, read from mainnet on 2026-09-22: PYUSD and USDG share an
  // ordinary key; the xStocks use a program-derived address.
  const PYUSD_DELEGATE = Uint8Array.from(getAddressEncoder().encode(address('2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk')));
  const XSTOCKS_DELEGATE = Uint8Array.from(getAddressEncoder().encode(address('5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq')));
  const withDelegate = async (delegate: Uint8Array) => {
    const s = await t22([[12, 32]]);
    s.snapshot.accounts.get(USDC)!.data.set(delegate, 166 + 4);
    return s;
  };

  it('a permanent delegate that is an ordinary key can act only by signing, so it is accepted', async () => {
    const s = await withDelegate(PYUSD_DELEGATE);
    expect((await verify(await compileHonest(s, 0), s.policy, s.snapshot)).violations).toEqual([]);
  });

  it('a permanent delegate that a program can sign for → R7', async () => {
    const s = await withDelegate(XSTOCKS_DELEGATE);
    expect(rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot))).toContain('R7');
  });

  it('new accounts that start initialized change nothing, so the default-state extension is accepted', async () => {
    const s = await t22([[6, 1]]);
    s.snapshot.accounts.get(USDC)!.data[166 + 4] = 1; // AccountState::Initialized
    expect((await verify(await compileHonest(s, 0), s.policy, s.snapshot)).violations).toEqual([]);
  });

  it('the fee on confidential transfers never touches a public one, so it is accepted', async () => {
    const s = await t22([[4, 65], [16, 129]]);
    expect((await verify(await compileHonest(s, 0), s.policy, s.snapshot)).violations).toEqual([]);
  });

  it('PYUSD\'s own set of extensions passes every rule', async () => {
    const s = await t22([[3, 32], [12, 32], [1, 108], [4, 65], [16, 129], [14, 64], [18, 64], [19, 174]]);
    const mint = s.snapshot.accounts.get(USDC)!.data;
    mint.set(PYUSD_DELEGATE, 166 + 4 + 32 + 4); // after MintCloseAuthority
    expect((await verify(await compileHonest(s, 0), s.policy, s.snapshot)).violations).toEqual([]);
  });

  it.each([
    ['accounts frozen by default', 6, 1, 2],
    ['a default state that is not a state at all', 6, 1, 0],
  ])('%s → R7', async (_name, type, length, state) => {
    const s = await t22([[type, length]]);
    s.snapshot.accounts.get(USDC)!.data[166 + 4] = state;
    expect(rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot))).toContain('R7');
  });

  it.each([
    ['a default-state extension of the wrong size', 6, 2],
    ['a permanent-delegate extension of the wrong size', 12, 31],
    ['a confidential-fee extension of the wrong size', 16, 128],
    ['an interest-bearing mint', 10, 52],
    ['a scaled UI amount', 25, 24],
    ['a pausable mint', 26, 33],
    ['an extension nobody has read yet', 250, 8],
  ])('%s → R7', async (_name, type, length) => {
    const s = await t22([[18, 64], [type, length]]);
    expect(rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot))).toContain('R7');
  });

  it('the output side works the same way', async () => {
    const s = await scenario({
      input: USDC, output: BONK, outputProgram: TOKEN_2022_PROGRAM, outputExtensions: [[18, 64]],
    });
    expect((await verify(await compileHonest(s, 0), s.policy, s.snapshot)).ok).toBe(true);
  });

  it('a token that taxes its transfers is accepted, with the withheld fees harvested before the close', async () => {
    const s = await t22([[18, 64], [1, 108]]);
    expect(s.policy.inputTransferFee).toBe(true);
    const verdict = await verify(await compileHonest(s, 0), s.policy, s.snapshot);
    expect(verdict.violations).toEqual([]);
  });

  it('without the harvest, the temporary account could not be closed → R5', async () => {
    const s = await t22([[18, 64], [1, 108]]);
    const ixs = honest(s).filter(ix => !(ix.data?.[0] === 26)); // drop HarvestWithheldTokensToMint
    const tx = compileRaw(s.W, [...cuIxs(), ...ixs], 0, s.lookupTables);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R5');
  });

  it('harvesting after the close is refused → R5', async () => {
    const s = await t22([[18, 64], [1, 108]]);
    const ixs = honest(s);
    const at = ixs.findIndex(ix => ix.data?.[0] === 26);
    ixs.splice(at + 2, 0, ...ixs.splice(at, 1)); // move the harvest past the close
    const tx = compileRaw(s.W, [...cuIxs(), ...ixs], 0, s.lookupTables);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R5');
  });

  it('a policy that hides the transfer fee → R2', async () => {
    const s = await t22([[18, 64], [1, 108]]);
    const lying = { ...s.policy, inputTransferFee: false };
    expect(rules(await verify(await compileHonest(s, 0), lying, s.snapshot))).toContain('R2');
  });

  it('an extension whose declared length disagrees with the program layout → R7', async () => {
    const s = await t22([[18, 64], [14, 32]]); // a transfer hook is 64 bytes, never 32
    expect(rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot))).toContain('R7');
  });

  it('bytes left over after the last extension → R7', async () => {
    const s = await t22([[18, 64]]);
    const mint = s.snapshot.accounts.get(USDC)!;
    const padded = { ...mint, data: new Uint8Array(mint.data.length + 3) };
    padded.data.set(mint.data);
    (s.snapshot.accounts as Map<string, unknown>).set(USDC, padded);
    expect(rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot))).toContain('R7');
  });

  it('a Token-2022 swap compiled with the classic program is refused', async () => {
    const s = await t22([[18, 64]]);
    // The policy is honest, but the transaction is built as if the mint were a classic token.
    const classic = { ...s.policy, inputTokenProgram: TOKEN_PROGRAM };
    const tx = compileRaw(s.W, [...cuIxs(), ...protectedInstructions({
      policy: classic, swapInstruction: s.swapIx, intermediates: s.intermediates, outputBalanceBefore: s.wOutBalance,
    })], 0, s.lookupTables);
    expect((await verify(tx, s.policy, s.snapshot)).ok).toBe(false);
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
