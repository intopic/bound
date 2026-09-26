/**
 * T6: the external swap program is malicious code, not just a malicious instruction list.
 *
 * T1 (tests/integration/mainnet.ts) replaces Jupiter's instruction with attacker instructions and
 * simulates them. That covers a hostile route, but not a hostile *program*: a swap program is free
 * to make cross-program invocations of its own, with any account metas it likes. This test deploys
 * such a program (tests/cpi/attacker) into a real Solana VM and lets it run.
 *
 * Orientim gives it exactly what the design allows — the temporary account E_in, the one-time key E
 * and, for token outputs, the wallet's output account W_out — and the runtime, not Orientim, decides
 * the rest. Every case asserts the same invariant: nothing beyond the approved amount moves, no
 * permission survives the transaction, and a swap that does not deliver the minimum reverts whole.
 *
 *   node tests/cpi/run.ts
 *
 * Needs tests/cpi/attacker/target/deploy/orientim_attacker.so (cargo build-sbf) and Linux or macOS:
 * litesvm ships no Windows binary. CI (.github/workflows/cpi.yml) does both.
 */
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  generateKeyPairSigner, getAddressEncoder, getCompiledTransactionMessageDecoder, getProgramDerivedAddress,
  lamports, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, signTransaction,
} from '@solana/kit';
import type { Address, Instruction, KeyPairSigner, Transaction } from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
  getCreateAssociatedTokenIdempotentInstruction, getInitializeMint2Instruction, getMintToInstruction,
} from '@solana-program/token';
import { LiteSVM } from 'litesvm';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  ataOf, buildPolicy, compileProtectedSwap, MINT_SIZE, SYSTEM_PROGRAM, tokenAmountOf, TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM, withTakerRent, WSOL_MINT,
} from '@orientim/core';
import type { AccountState, ChainSnapshot, Policy } from '@orientim/core';
import { verify } from '@orientim/verifier';

const SO = 'tests/cpi/attacker/target/deploy/orientim_attacker.so';
const OUT_DIR = 'tests/cpi/results';
const SOL = 1_000_000_000n;

// The swap under test: 100 IN (6 decimals) for at least 10 OUT (9 decimals), Orientim fee 0.5%.
const AMOUNT_IN = 100_000_000n;
const FEE_BPS = 50n;
const FEE = (AMOUNT_IN * FEE_BPS) / 10_000n;
const SWAP_AMOUNT = AMOUNT_IN - FEE;
const MIN_OUT = 10_000_000_000n;
const MIN_OUT_SOL = SOL;
const IN_DECIMALS = 6;
const OUT_DECIMALS = 9;
const MAX_NETWORK_FEE = 20_000n; // two signatures at 5000 lamports, with room to spare

if (!existsSync(SO)) {
  console.error(`Missing ${SO}. Build it first:\n  (in tests/cpi/attacker) cargo build-sbf`);
  process.exit(2);
}

const log = (...a: unknown[]) => console.log(...a);
const encoder = getAddressEncoder();

// ---------------------------------------------------------------- instruction data

const u64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
/** SPL Token Transfer: [source, destination, authority]. */
const transfer = (amount: bigint) => Uint8Array.from([3, ...u64(amount)]);
/** SPL Token TransferChecked: [source, mint, destination, authority, ...multisig signers]. */
const transferChecked = (amount: bigint, decimals: number) => Uint8Array.from([12, ...u64(amount), decimals]);
/** SPL Token Approve: [source, delegate, owner]. */
const approve = (amount: bigint) => Uint8Array.from([4, ...u64(amount)]);
/** SPL Token SetAuthority: [account, current authority]. Type 2 = AccountOwner, 3 = CloseAccount. */
const setAuthority = (type: number, newAuthority: Address) =>
  Uint8Array.from([6, type, 1, ...encoder.encode(newAuthority)]);
/** SPL Token CloseAccount: [account, destination, owner]. */
const CLOSE_ACCOUNT = Uint8Array.from([9]);
/** System Transfer: [from, to]. */
const transferSol = (amount: bigint) => Uint8Array.from([2, 0, 0, 0, ...u64(amount)]);

// ---------------------------------------------------------------- what the attacker will attempt

/** An account of the external instruction, by index, or any address at all, by value. */
type Key = number | Address;
type Meta = { key: Key; w?: boolean; s?: boolean };
/** One cross-program invocation the malicious swap program will attempt. */
type Inner = { program: Key; signed?: boolean; metas: Meta[]; data: Uint8Array };

function encodeKey(k: Key, out: number[]) {
  if (typeof k === 'number') out.push(k);
  else out.push(0xff, ...encoder.encode(k));
}

function attackerData(inners: Inner[]): Uint8Array {
  const out: number[] = [inners.length];
  for (const inner of inners) {
    encodeKey(inner.program, out);
    out.push(inner.signed ? 1 : 0, inner.metas.length);
    for (const m of inner.metas) {
      encodeKey(m.key, out);
      out.push((m.w ? 1 : 0) | (m.s ? 2 : 0));
    }
    out.push(inner.data.length & 0xff, (inner.data.length >> 8) & 0xff, ...inner.data);
  }
  return Uint8Array.from(out);
}

/** Index of an account in the external instruction (see `externalInstruction`). */
const IX = { token: 0, system: 1, E: 2, eIn: 3, output: 4, attackerIn: 5, pool: 6, poolAuthority: 7 } as const;

/** E_in → the attacker's own account, authority E: the one move Orientim's design allows. */
const takeFrom = (amount: bigint): Inner => ({
  program: IX.token,
  metas: [{ key: IX.eIn, w: true }, { key: IX.attackerIn, w: true }, { key: IX.E, s: true }],
  data: transfer(amount),
});
/** Delivers from the attacker's own pool, signed by the pool's program-derived authority. */
const deliver = (amount: bigint): Inner => ({
  program: IX.token, signed: true,
  metas: [{ key: IX.pool, w: true }, { key: IX.output, w: true }, { key: IX.poolAuthority, s: true }],
  data: transfer(amount),
});

// ---------------------------------------------------------------- the world

type World = {
  svm: LiteSVM;
  attackerProgram: Address;
  tokenProgram: Address;
  payer: KeyPairSigner;
  W: KeyPairSigner;
  E: KeyPairSigner;
  attacker: Address;
  vaultAuthority: Address;
  mintIn: Address;
  mintOut: Address;
  mintOther: Address;
  wIn: Address;
  wOut: Address;
  wOther: Address;
  eIn: Address;
  eOut: Address;
  attackerIn: Address;
  vaultOut: Address;
  vaultWsol: Address;
  treasury: Address;
  treasuryIn: Address;
  /** The issuer multisig, when the case sets one (see `IssuerDelegate`). */
  multisig: Address | null;
};

const accountOf = (svm: LiteSVM, a: Address): AccountState | null => {
  const account = svm.getAccount(a);
  if (!account || !account.exists) return null;
  return { owner: account.programAddress, lamports: BigInt(account.lamports), data: Uint8Array.from(account.data) };
};
const tokensOf = (svm: LiteSVM, a: Address) => tokenAmountOf(accountOf(svm, a)?.data);
const solOf = (svm: LiteSVM, a: Address) => BigInt(svm.getBalance(a) ?? 0n);
const lifetimeOf = (svm: LiteSVM) => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 10_000n });

async function sign(svm: LiteSVM, ixs: Instruction[], payer: KeyPairSigner, extra: KeyPairSigner[] = []) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(payer.address, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetimeOf(svm), m),
    m => appendTransactionMessageInstructions(ixs, m),
  );
  return signTransaction([payer.keyPair, ...extra.map(s => s.keyPair)], compileTransaction(message));
}

/** A transaction's result, whichever way litesvm reports it. */
type Outcome = { ok: boolean; error: string; index: number | null; logs: string[] };

function send(svm: LiteSVM, tx: Transaction): Outcome {
  const result = svm.sendTransaction(tx) as {
    err?: () => unknown; meta?: () => { logs: () => string[] }; logs?: () => string[];
  };
  if (typeof result.err !== 'function') return { ok: true, error: '', index: null, logs: result.logs?.() ?? [] };
  const err = result.err() as { index?: number } | string;
  const index = typeof err === 'object' && err !== null && err.index !== undefined ? Number(err.index) : null;
  const logs = result.meta?.().logs() ?? [];
  const blamed = [...logs].reverse().find(l => /failed|error|insufficient|privilege|unauthorized|missing/i.test(l));
  return { ok: false, error: (blamed ?? String(err)).slice(0, 160), index, logs };
}

function sendOrThrow(svm: LiteSVM, tx: Transaction, what: string) {
  const r = send(svm, tx);
  if (!r.ok) throw new Error(`${what} failed: ${r.error}\n${r.logs.join('\n')}`);
}

/**
 * Who holds the permanent delegate of the swap's two Token-2022 mints, when one is set: an ordinary
 * key (the attacker's own wallet, which never signs the swap), an address the attacker's program can
 * sign for itself (its pool authority), or a Token multisig at an ordinary address whose one signer
 * is that program address: R7 sees an ordinary key, and the program can still act as the delegate
 * (final audit, item 4).
 */
type IssuerDelegate = 'key' | 'program' | 'multisig';
/** A Token multisig account: m, n, initialized, then eleven signer slots. */
const MULTISIG_SIZE = 355n;

/** InitializePermanentDelegate (Token-2022 instruction 35); it must run before the mint is initialized. */
const initializePermanentDelegate = (mint: Address, delegate: Address): Instruction => ({
  programAddress: TOKEN_2022_PROGRAM,
  accounts: [{ address: mint, role: AccountRole.WRITABLE }],
  data: Uint8Array.from([35, ...encoder.encode(delegate)]),
});
/** A mint with one 32-byte extension: padded to an account's size, a type byte, then the entry. */
const MINT_WITH_DELEGATE_SIZE = 165 + 1 + 4 + 32;

/** A fresh chain with the wallet, the attacker's pool and three tokens. */
async function setup(tokenProgram: Address = TOKEN_PROGRAM, issuer?: IssuerDelegate): Promise<World> {
  const svm = new LiteSVM().withNativeMints();
  const program = await generateKeyPairSigner(); // only its address matters: the program id
  svm.addProgramFromFile(program.address, SO);

  const [payer, W, E, attackerWallet, treasuryWallet, mintInKey, mintOutKey, mintOtherKey] = await Promise.all(
    Array.from({ length: 8 }, () => generateKeyPairSigner()),
  );
  svm.airdrop(payer.address, lamports(1000n * SOL));
  svm.airdrop(W.address, lamports(10n * SOL));
  svm.airdrop(attackerWallet.address, lamports(100n * SOL));
  // E is deliberately left non-existent: rule R3 requires it.

  const [vaultAuthority] = await getProgramDerivedAddress({
    programAddress: program.address,
    seeds: [new TextEncoder().encode('attacker')],
  });

  // A multisig whose single signer is the attacker program's own address (InitializeMultisig2).
  const multisig = issuer === 'multisig' ? await generateKeyPairSigner() : null;
  if (multisig) {
    sendOrThrow(svm, await sign(svm, [
      getCreateAccountInstruction({
        payer, newAccount: multisig, lamports: lamports(svm.minimumBalanceForRentExemption(MULTISIG_SIZE)),
        space: MULTISIG_SIZE, programAddress: tokenProgram,
      }),
      {
        programAddress: tokenProgram,
        accounts: [{ address: multisig.address, role: AccountRole.WRITABLE }, { address: vaultAuthority, role: AccountRole.READONLY }],
        data: Uint8Array.from([19, 1]),
      },
    ], payer, [multisig]), 'creating the issuer multisig');
  }
  const delegate = issuer === 'key' ? attackerWallet.address : issuer === 'program' ? vaultAuthority : multisig?.address ?? null;
  const mints: [KeyPairSigner, number, boolean][] = [
    [mintInKey, IN_DECIMALS, !!delegate], [mintOutKey, OUT_DECIMALS, !!delegate], [mintOtherKey, 6, false],
  ];
  sendOrThrow(svm, await sign(svm, mints.flatMap(([mint, decimals, withDelegate]) => {
    const space = withDelegate ? MINT_WITH_DELEGATE_SIZE : MINT_SIZE;
    return [
      getCreateAccountInstruction({
        payer, newAccount: mint, lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(space))),
        space: BigInt(space), programAddress: tokenProgram,
      }),
      ...(withDelegate ? [initializePermanentDelegate(mint.address, delegate!)] : []),
      getInitializeMint2Instruction(
        { mint: mint.address, decimals, mintAuthority: payer.address, freezeAuthority: null },
        { programAddress: tokenProgram },
      ),
    ];
  }), payer, mints.map(([m]) => m)), 'creating the mints');

  const mintIn = mintInKey.address, mintOut = mintOutKey.address, mintOther = mintOtherKey.address;
  const world: World = {
    svm, attackerProgram: program.address, tokenProgram, payer, W, E,
    attacker: attackerWallet.address, vaultAuthority, mintIn, mintOut, mintOther,
    wIn: await ataOf(W.address, mintIn, tokenProgram),
    wOut: await ataOf(W.address, mintOut, tokenProgram),
    wOther: await ataOf(W.address, mintOther, tokenProgram),
    eIn: await ataOf(E.address, mintIn, tokenProgram),
    eOut: await ataOf(E.address, WSOL_MINT),
    attackerIn: await ataOf(attackerWallet.address, mintIn, tokenProgram),
    vaultOut: await ataOf(vaultAuthority, mintOut, tokenProgram),
    vaultWsol: await ataOf(vaultAuthority, WSOL_MINT),
    treasury: treasuryWallet.address,
    treasuryIn: await ataOf(treasuryWallet.address, mintIn, tokenProgram),
    multisig: multisig?.address ?? null,
  };

  const ata = (owner: Address, mint: Address, account: Address, programAddress: Address = tokenProgram) =>
    getCreateAssociatedTokenIdempotentInstruction({ payer, ata: account, owner, mint, tokenProgram: programAddress });
  sendOrThrow(svm, await sign(svm, [
    ata(W.address, mintIn, world.wIn),
    ata(W.address, mintOut, world.wOut),
    ata(W.address, mintOther, world.wOther),
    ata(world.attacker, mintIn, world.attackerIn),
    ata(vaultAuthority, mintOut, world.vaultOut),
    ata(vaultAuthority, WSOL_MINT, world.vaultWsol, TOKEN_PROGRAM),
    ata(world.treasury, mintIn, world.treasuryIn),
  ], payer), 'creating the token accounts');

  sendOrThrow(svm, await sign(svm, [
    getMintToInstruction({ mint: mintIn, token: world.wIn, mintAuthority: payer, amount: 1000n * 1_000_000n }, { programAddress: tokenProgram }),
    getMintToInstruction({ mint: mintOut, token: world.wOut, mintAuthority: payer, amount: 500n * SOL }, { programAddress: tokenProgram }),
    getMintToInstruction({ mint: mintOther, token: world.wOther, mintAuthority: payer, amount: 777n * 1_000_000n }, { programAddress: tokenProgram }),
    getMintToInstruction({ mint: mintOut, token: world.vaultOut, mintAuthority: payer, amount: 1_000_000n * SOL }, { programAddress: tokenProgram }),
  ], payer), 'minting');

  // The attacker's wrapped-SOL pool: lamports plus SyncNative, the way any wrapper funds one.
  sendOrThrow(svm, await sign(svm, [
    getTransferSolInstruction({ source: attackerWallet, destination: world.vaultWsol, amount: 50n * SOL }),
    { programAddress: TOKEN_PROGRAM, accounts: [{ address: world.vaultWsol, role: AccountRole.WRITABLE }], data: Uint8Array.from([17]) },
  ], attackerWallet), 'funding the wrapped-SOL pool');

  return world;
}

// ---------------------------------------------------------------- the protected transaction

type Variant = 'C' | 'A';

/**
 * The external instruction exactly as Orientim hands it over: the attacker's program, and only the
 * accounts the design allows it to see. `extra` is for the case where the route also demands an
 * account it must never get.
 */
function externalInstruction(w: World, variant: Variant, inners: Inner[], extra: Address[] = [], takerPays = false): Instruction {
  return {
    programAddress: w.attackerProgram,
    accounts: [
      { address: w.tokenProgram, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      // A route that makes the taker pay rent (PumpSwap) needs E writable, as Jupiter lists it then.
      { address: w.E.address, role: takerPays ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER },
      { address: w.eIn, role: AccountRole.WRITABLE },
      { address: variant === 'A' ? w.eOut : w.wOut, role: AccountRole.WRITABLE },
      { address: w.attackerIn, role: AccountRole.WRITABLE },
      { address: variant === 'A' ? w.vaultWsol : w.vaultOut, role: AccountRole.WRITABLE },
      { address: w.vaultAuthority, role: AccountRole.READONLY },
      { address: w.mintIn, role: AccountRole.READONLY },
      { address: variant === 'A' ? WSOL_MINT : w.mintOut, role: AccountRole.READONLY },
      ...extra.map(address => ({ address, role: AccountRole.WRITABLE })),
    ],
    data: attackerData(inners),
  };
}

async function protectedSwap(w: World, variant: Variant, inners: Inner[], extra: Address[] = [], takerRent = 0n) {
  const built = await buildPolicy({
    intent: { owner: w.W.address, inputMint: w.mintIn, outputMint: variant === 'A' ? WSOL_MINT : w.mintOut, amountIn: AMOUNT_IN },
    ephemeral: w.E.address,
    inputDecimals: IN_DECIMALS,
    outputDecimals: OUT_DECIMALS,
    inputTokenProgram: w.tokenProgram,
    outputTokenProgram: variant === 'A' ? TOKEN_PROGRAM : w.tokenProgram,
    minOut: variant === 'A' ? MIN_OUT_SOL : MIN_OUT,
    config: { feeBps: FEE_BPS, treasury: w.treasury, maxNetworkFeeLamports: 200_000n, jupiterProgram: w.attackerProgram },
    feeAccountExists: true,
    // T6 measures the fee in the input token's account, which is what it isolates; the treasury
    // wallet is not funded in this VM, so a fee on a SOL output is covered by the unit tests instead.
    treasuryWalletReady: false,
  });
  const policy = withTakerRent(built, takerRent);
  if (policy.swapAmount !== SWAP_AMOUNT) throw new Error(`swap amount ${policy.swapAmount}, expected ${SWAP_AMOUNT}`);
  const swapInstruction = externalInstruction(w, variant, inners, extra, takerRent > 0n);
  const outputBalanceBefore = policy.accounts.wOut ? tokensOf(w.svm, policy.accounts.wOut) : 0n;
  const { transaction } = compileProtectedSwap({
    policy, swapInstruction, intermediates: [], version: 0, lifetime: lifetimeOf(w.svm),
    computeUnitLimit: 400_000, microLamportsPerComputeUnit: 0n, outputBalanceBefore,
  });
  const addresses = [
    w.W.address, w.E.address, w.mintIn, w.mintOut, WSOL_MINT, policy.accounts.eIn, policy.accounts.feeDestination!,
    ...(policy.accounts.eOut ? [policy.accounts.eOut] : []),
    ...(policy.accounts.wIn ? [policy.accounts.wIn] : []),
    ...(policy.accounts.wOut ? [policy.accounts.wOut] : []),
    ...swapInstruction.accounts!.map(a => a.address),
  ];
  const snapshot: ChainSnapshot = { accounts: new Map(addresses.map(a => [a, accountOf(w.svm, a)])), lookupTables: {} };
  // Where the untrusted instruction sits, so the report can say what stopped an attack.
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes) as unknown as {
    staticAccounts: Address[];
    instructions: readonly { programAddressIndex: number }[];
  };
  const swapIndex = compiled.instructions.findIndex(
    i => compiled.staticAccounts[i.programAddressIndex] === w.attackerProgram,
  );
  return { policy, transaction, swapIndex, verdict: await verify(transaction, policy, snapshot) };
}

// ---------------------------------------------------------------- what must never change

type Balances = { wIn: bigint; wOut: bigint; wOther: bigint; wSol: bigint; attackerIn: bigint; treasury: bigint };

const balancesOf = (w: World): Balances => ({
  wIn: tokensOf(w.svm, w.wIn),
  wOut: tokensOf(w.svm, w.wOut),
  wOther: tokensOf(w.svm, w.wOther),
  wSol: solOf(w.svm, w.W.address),
  attackerIn: tokensOf(w.svm, w.attackerIn),
  treasury: tokensOf(w.svm, w.treasuryIn),
});

/** Orientim's promise, checked against the chain after every case. */
function invariants(w: World, policy: Policy, before: Balances, after: Balances, succeeded: boolean): string[] {
  const bad: string[] = [];
  const same = (what: string, a: bigint, b: bigint) => {
    if (a !== b) bad.push(`${what} changed by ${b - a}`);
  };
  const variantA = policy.outputMint === WSOL_MINT;
  same("the wallet's other token", before.wOther, after.wOther);

  if (!succeeded) {
    same("the wallet's input", before.wIn, after.wIn);
    same("the wallet's output", before.wOut, after.wOut);
    same("the attacker's account", before.attackerIn, after.attackerIn);
    same("Orientim's fee account", before.treasury, after.treasury);
    if (before.wSol - after.wSol > MAX_NETWORK_FEE) bad.push(`the wallet lost ${before.wSol - after.wSol} lamports`);
    return bad;
  }

  if (before.wIn - after.wIn !== AMOUNT_IN) bad.push(`the wallet paid ${before.wIn - after.wIn}, approved ${AMOUNT_IN}`);
  if (after.treasury - before.treasury !== policy.fee) bad.push(`the fee was ${after.treasury - before.treasury}, expected ${policy.fee}`);
  if (after.attackerIn - before.attackerIn > policy.swapAmount) {
    bad.push(`the attacker took ${after.attackerIn - before.attackerIn}, above the approved ${policy.swapAmount}`);
  }
  if (variantA) {
    if (after.wSol - before.wSol < MIN_OUT_SOL - MAX_NETWORK_FEE - policy.takerRent) bad.push(`the wallet received ${after.wSol - before.wSol} lamports, below the minimum`);
    same("the wallet's token output account", before.wOut, after.wOut);
  } else {
    if (after.wOut - before.wOut < MIN_OUT) bad.push(`the wallet received ${after.wOut - before.wOut}, below the minimum ${MIN_OUT}`);
    // The rent Orientim sends E for the route's account is the one SOL the route may take besides the
    // network fee; it is stated in the certificate before the wallet signs.
    if (before.wSol - after.wSol > MAX_NETWORK_FEE + policy.takerRent) {
      bad.push(`the wallet lost ${before.wSol - after.wSol} lamports beyond the network fee and the stated route rent`);
    }
  }
  // No temporary account and no permission may outlive the transaction.
  for (const [what, a] of [['E_in', policy.accounts.eIn], ['E_out', policy.accounts.eOut], ['E', w.E.address]] as const) {
    if (a && accountOf(w.svm, a)) bad.push(`${what} still exists after the swap`);
  }
  const out = accountOf(w.svm, w.wOut);
  if (out && out.data.length >= 76 && new DataView(out.data.buffer, out.data.byteOffset, out.data.byteLength).getUint32(72, true) === 1) {
    bad.push('a delegate is set on the output account after the swap');
  }
  return bad;
}

// ---------------------------------------------------------------- the cases

type Case = {
  name: string;
  variant: Variant;
  /** Classic SPL by default; selected cases run the same hostile CPI through Token-2022. */
  tokenProgram?: Address;
  /** A permanent delegate on both swap mints (Token-2022 only); see `IssuerDelegate`. */
  issuer?: IssuerDelegate;
  /** Rent Orientim sends E for an account the route opens in E's name (PumpSwap). */
  takerRent?: bigint;
  /** What the malicious program attempts, in order. */
  inners: (w: World) => Inner[];
  /** Accounts the route demands on top of what Orientim allows. */
  extra?: (w: World) => Address[];
  expect: 'succeeds' | 'reverts' | 'refused before signing';
  /** What the case proves, for the report. */
  proves: string;
};

const CASES: Case[] = [
  {
    name: 'takes the approved amount and delivers the minimum',
    variant: 'C', expect: 'succeeds',
    proves: 'an honest-looking route works: exactly the approved amount leaves, the minimum arrives',
    inners: () => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT)],
  },
  {
    name: 'takes the approved amount and delivers nothing',
    variant: 'C', expect: 'reverts',
    proves: "Orientim's minimum-output check undoes the theft",
    inners: () => [takeFrom(SWAP_AMOUNT)],
  },
  {
    name: 'delivers one unit less than the minimum',
    variant: 'C', expect: 'reverts',
    proves: 'the minimum is exact, not approximate',
    inners: () => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT - 1n)],
  },
  {
    name: 'tries to take more than the approved amount',
    variant: 'C', expect: 'reverts',
    proves: 'the temporary account holds the approved amount and nothing more',
    inners: () => [takeFrom(SWAP_AMOUNT + 1n)],
  },
  {
    name: "tries to spend the wallet's input account",
    variant: 'C', expect: 'reverts',
    proves: 'the rest of the balance of the same token is out of reach',
    inners: w => [{
      program: IX.token,
      metas: [{ key: w.wIn, w: true }, { key: IX.attackerIn, w: true }, { key: w.W.address, s: true }],
      data: transfer(1_000_000n),
    }],
  },
  {
    name: "tries to spend the wallet's other token",
    variant: 'C', expect: 'reverts',
    proves: 'tokens that have nothing to do with the swap are out of reach',
    inners: w => [{
      program: IX.token,
      metas: [{ key: w.wOther, w: true }, { key: IX.attackerIn, w: true }, { key: w.W.address, s: true }],
      data: transfer(1n),
    }],
  },
  {
    name: "tries to take the wallet's SOL",
    variant: 'C', expect: 'reverts',
    proves: 'the wallet is never handed over, so its SOL cannot move',
    inners: w => [{
      program: IX.system,
      metas: [{ key: w.W.address, w: true, s: true }, { key: w.attacker, w: true }],
      data: transferSol(SOL),
    }],
  },
  {
    name: "tries to take the wallet's SOL while forging a signature",
    variant: 'C', expect: 'reverts',
    proves: 'a program cannot sign for a wallet with a key of its own',
    inners: w => [{
      program: IX.system, signed: true,
      metas: [{ key: w.W.address, w: true, s: true }, { key: w.attacker, w: true }],
      data: transferSol(SOL),
    }],
  },
  {
    name: 'tries to take the balance already in the output account',
    variant: 'C', expect: 'reverts',
    proves: 'the output account is handed over to receive, not to be spent',
    inners: w => [{
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: IX.pool, w: true }, { key: w.W.address, s: true }],
      data: transfer(1n),
    }],
  },
  {
    name: 'tries to leave a delegate on the output account',
    variant: 'C', expect: 'reverts',
    proves: 'no spending permission can be left behind for later',
    inners: w => [{
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: IX.poolAuthority }, { key: w.W.address, s: true }],
      data: approve(2n ** 63n),
    }],
  },
  {
    name: 'tries to take ownership of the output account',
    variant: 'C', expect: 'reverts',
    proves: "ownership of the wallet's account cannot be reassigned",
    inners: w => [{
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: w.W.address, s: true }],
      data: setAuthority(2, w.attacker),
    }],
  },
  {
    name: 'tries to close the output account to the attacker',
    variant: 'C', expect: 'reverts',
    proves: "the rent inside the wallet's account cannot be taken either",
    inners: w => [{
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: w.attacker, w: true }, { key: w.W.address, s: true }],
      data: CLOSE_ACCOUNT,
    }],
  },
  {
    name: 'leaves a delegate on the temporary account, then delivers',
    variant: 'C', expect: 'succeeds',
    proves: 'a permission on the temporary account dies with it: cleanup closes the account',
    inners: () => [
      { program: IX.token, metas: [{ key: IX.eIn, w: true }, { key: IX.poolAuthority }, { key: IX.E, s: true }], data: approve(2n ** 63n) },
      takeFrom(SWAP_AMOUNT), deliver(MIN_OUT),
    ],
  },
  {
    name: "the route demands the wallet's input account",
    variant: 'C', expect: 'refused before signing',
    proves: 'rule R1 stops such a route before the wallet is ever asked to sign',
    extra: w => [w.wIn],
    inners: () => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT)],
  },
  {
    // Orientim's cleanup closes E_in unconditionally. A route that destroys it first would, if the
    // swap still counted as a success, keep the rent W paid to open it. It does not: the close
    // fails on an account that no longer exists, and that takes the whole transaction with it.
    name: 'destroys the temporary input account after emptying it',
    variant: 'C', expect: 'reverts',
    proves: 'a route cannot complete around a temporary account it destroyed: cleanup fails and everything is undone',
    inners: w => [
      takeFrom(SWAP_AMOUNT),
      {
        program: IX.token,
        metas: [{ key: IX.eIn, w: true }, { key: IX.attackerIn, w: true }, { key: IX.E, s: true }],
        data: CLOSE_ACCOUNT,
      },
      deliver(MIN_OUT),
    ],
  },
  {
    // To re-create E_in and hide the theft, the attacker needs a payer that signs and holds
    // lamports. The only lamports within reach are E_in's own rent, and the only key it can sign
    // for is its program-derived authority — which Orientim handed over read-only. A cross-program
    // call cannot widen that.
    name: 'sends the temporary account\'s rent to a key it can sign for',
    variant: 'C', expect: 'reverts',
    proves: 'an account handed over read-only stays read-only inside the program\'s own inner call, so the rent cannot be moved somewhere the attacker could spend it',
    inners: () => [
      takeFrom(SWAP_AMOUNT),
      {
        program: IX.token,
        metas: [{ key: IX.eIn, w: true }, { key: IX.poolAuthority, w: true }, { key: IX.E, s: true }],
        data: CLOSE_ACCOUNT,
      },
      deliver(MIN_OUT),
    ],
  },
  {
    name: 'SPL → SOL: takes the approved amount and delivers the minimum',
    variant: 'A', expect: 'succeeds',
    proves: 'the wrapped-SOL variant works and closes both temporary accounts',
    inners: () => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT_SOL)],
  },
  {
    name: 'SPL → SOL: delivers nothing',
    variant: 'A', expect: 'reverts',
    proves: 'the minimum is checked on the temporary output account too',
    inners: () => [takeFrom(SWAP_AMOUNT)],
  },
  {
    name: 'SPL → SOL: closes the temporary output account to the attacker',
    variant: 'A', expect: 'reverts',
    proves: 'taking the temporary account itself still fails the minimum check',
    inners: w => [takeFrom(SWAP_AMOUNT), {
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: w.attacker, w: true }, { key: IX.E, s: true }],
      data: CLOSE_ACCOUNT,
    }],
  },
  {
    name: 'Token-2022: takes the approved amount and delivers the minimum',
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, expect: 'succeeds',
    proves: 'the protected path itself works with real Token-2022 program CPIs',
    inners: () => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT)],
  },
  {
    name: 'Token-2022: takes the approved amount and delivers nothing',
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, expect: 'reverts',
    proves: 'the minimum-output check rolls back a Token-2022 theft too',
    inners: () => [takeFrom(SWAP_AMOUNT)],
  },
  {
    name: "Token-2022: tries to spend the wallet's remaining input balance",
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, expect: 'reverts',
    proves: 'the Token-2022 input balance beyond the approved amount is out of reach',
    inners: w => [{
      program: IX.token,
      metas: [{ key: w.wIn, w: true }, { key: IX.attackerIn, w: true }, { key: w.W.address, s: true }],
      data: transfer(1_000_000n),
    }],
  },
  {
    name: "Token-2022: tries to spend the wallet's unrelated token",
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, expect: 'reverts',
    proves: 'an unrelated Token-2022 balance is out of reach',
    inners: w => [{
      program: IX.token,
      metas: [{ key: w.wOther, w: true }, { key: IX.attackerIn, w: true }, { key: w.W.address, s: true }],
      data: transfer(1n),
    }],
  },
  {
    name: "Token-2022: tries to take the wallet's SOL",
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, expect: 'reverts',
    proves: 'using Token-2022 in the route does not expose the wallet or its SOL',
    inners: w => [{
      program: IX.system,
      metas: [{ key: w.W.address, w: true, s: true }, { key: w.attacker, w: true }],
      data: transferSol(SOL),
    }],
  },
  {
    name: 'Token-2022: tries to spend the balance already in the output account',
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, expect: 'reverts',
    proves: 'the Token-2022 output account can receive but cannot be spent by the route',
    inners: w => [{
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: IX.pool, w: true }, { key: w.W.address, s: true }],
      data: transfer(1n),
    }],
  },
  {
    name: 'Token-2022: tries to leave a delegate on the output account',
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, expect: 'reverts',
    proves: 'a Token-2022 spending permission cannot be left behind',
    inners: w => [{
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: IX.poolAuthority }, { key: w.W.address, s: true }],
      data: approve(2n ** 63n),
    }],
  },
  {
    name: 'Token-2022: tries to take ownership of the output account',
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, expect: 'reverts',
    proves: "ownership of the wallet's Token-2022 account cannot be reassigned",
    inners: w => [{
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: w.W.address, s: true }],
      data: setAuthority(2, w.attacker),
    }],
  },
  {
    // PYUSD's shape: the issuer's delegate is an ordinary key. The swap itself must still work.
    name: 'issuer delegate is an ordinary key: takes the approved amount and delivers the minimum',
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, issuer: 'key', expect: 'succeeds',
    proves: 'a token whose issuer can move it anywhere still swaps through the protected path',
    inners: () => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT)],
  },
  {
    // The attacker is the issuer here, and uses its delegate power on the wallet's output account.
    // The key is an ordinary one, so it can act only as a signer, and it never signs the swap.
    name: "issuer delegate is an ordinary key: the attacker holds it and tries to take the wallet's output balance",
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, issuer: 'key', expect: 'reverts',
    proves: 'an issuer key that is not a signer of the transaction cannot act inside it, even when the route belongs to the issuer and hands the key along',
    // The route even passes the issuer's key along, so the only thing missing is its signature.
    extra: w => [w.attacker],
    inners: w => [{
      program: IX.token,
      metas: [{ key: IX.output, w: true }, { key: IX.pool, w: true }, { key: w.attacker, s: true }],
      data: transfer(1n),
    }],
  },
  {
    // The delegate R7 lets through as an ordinary address is a multisig the route's program signs
    // for: it can move tokens out of the wallet's output account inside the swap. What stops it is
    // Orientim's minimum-output check, which counts that account's balance after the swap.
    name: "issuer delegate is a multisig the route's program signs for: takes from the wallet's output balance and delivers the minimum",
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, issuer: 'multisig', expect: 'reverts',
    proves: 'a delegate hidden behind an ordinary-looking multisig can act inside the swap, and the minimum-output check reverts the whole transaction when it takes from what the wallet held',
    extra: w => [w.multisig!],
    inners: w => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT), {
      program: IX.token, signed: true,
      metas: [{ key: IX.output, w: true }, { key: 9 }, { key: IX.pool, w: true }, { key: w.multisig! }, { key: IX.poolAuthority, s: true }],
      data: transferChecked(1n, OUT_DECIMALS),
    }],
  },
  {
    // The bound SECURITY.md states: such a delegate can keep only what arrived above the minimum.
    name: 'issuer delegate is a multisig the route signs for: takes back only what it delivered above the minimum',
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, issuer: 'multisig', expect: 'succeeds',
    proves: "the most such a delegate can take is the surplus above the minimum: the wallet still nets the minimum, and nothing it held before",
    extra: w => [w.multisig!],
    inners: w => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT + 5n), {
      program: IX.token, signed: true,
      metas: [{ key: IX.output, w: true }, { key: 9 }, { key: IX.pool, w: true }, { key: w.multisig! }, { key: IX.poolAuthority, s: true }],
      data: transferChecked(5n, OUT_DECIMALS),
    }],
  },
  {
    // The xStocks' shape: the delegate is an address a program can sign for. If that program is
    // the route, it could sign as the issuer inside the swap, so Orientim refuses before signing.
    name: "issuer delegate is the route program's own address",
    variant: 'C', tokenProgram: TOKEN_2022_PROGRAM, issuer: 'program', expect: 'refused before signing',
    proves: 'a delegate a program can sign for is refused (R7) before the wallet is ever asked',
    inners: () => [takeFrom(SWAP_AMOUNT), deliver(MIN_OUT)],
  },
  {
    // PumpSwap charges each new buyer an account's rent, so Orientim sends E exactly that. A hostile
    // route may pocket it instead: that is the most it can take on top of the approved amount.
    name: 'route rent: takes the rent Orientim sent the temporary key, and the approved amount',
    variant: 'C', takerRent: 1_346_200n, expect: 'succeeds',
    proves: "the SOL a route can reach is the stated rent and nothing more; the wallet's own SOL stays out of reach",
    extra: w => [w.attacker],
    inners: w => [
      { program: IX.system, metas: [{ key: IX.E, w: true, s: true }, { key: w.attacker, w: true }], data: transferSol(1_346_200n) },
      takeFrom(SWAP_AMOUNT), deliver(MIN_OUT),
    ],
  },
  {
    name: 'route rent: tries to take one lamport more than the rent',
    variant: 'C', takerRent: 1_346_200n, expect: 'reverts',
    proves: 'the temporary key holds exactly the rent, so there is nothing more to take',
    extra: w => [w.attacker],
    inners: w => [
      { program: IX.system, metas: [{ key: IX.E, w: true, s: true }, { key: w.attacker, w: true }], data: transferSol(1_346_201n) },
      takeFrom(SWAP_AMOUNT), deliver(MIN_OUT),
    ],
  },
];

// ---------------------------------------------------------------- run

type Row = { name: string; proves: string; expected: string; outcome: string; verifier: string; broken: string[]; pass: boolean };

const rows: Row[] = [];
for (const c of CASES) {
  const w = await setup(c.tokenProgram ?? TOKEN_PROGRAM, c.issuer);
  const { policy, transaction, swapIndex, verdict } = await protectedSwap(w, c.variant, c.inners(w), c.extra?.(w) ?? [], c.takerRent ?? 0n);
  const verifier = verdict.ok ? 'e pranoi' : `e refuzoi (${[...new Set(verdict.violations.map(v => v.rule))].join(', ')})`;

  if (c.expect === 'refused before signing') {
    const pass = !verdict.ok;
    rows.push({ name: c.name, proves: c.proves, expected: 'refuzohet para nënshkrimit', outcome: verifier, verifier, broken: [], pass });
    log(`${pass ? 'OK  ' : 'FAIL'} ${c.name}: verifier ${verifier}`);
    continue;
  }

  const before = balancesOf(w);
  const result = send(w.svm, await signTransaction([w.W.keyPair, w.E.keyPair], transaction));
  const after = balancesOf(w);
  const broken = invariants(w, policy, before, after, result.ok);
  const where = result.index === null ? '' : result.index === swapIndex ? ', te sulmi' : `, te instruction-i ${result.index} (sulmi te ${swapIndex})`;
  const pass = result.ok === (c.expect === 'succeeds') && broken.length === 0 && verdict.ok;
  rows.push({
    name: c.name, proves: c.proves,
    expected: c.expect === 'succeeds' ? 'kalon' : 'anulohet',
    outcome: result.ok ? 'kaloi' : `u anulua${where}: ${result.error}`,
    verifier, broken, pass,
  });
  log(`${pass ? 'OK  ' : 'FAIL'} ${c.name}: ${rows.at(-1)!.outcome}${broken.length ? ` — SHKELJE: ${broken.join('; ')}` : ''}`);
}

mkdirSync(OUT_DIR, { recursive: true });
const failed = rows.filter(r => !r.pass).length;
writeFileSync(`${OUT_DIR}/cpi.md`, [
  '# T6 — kur programi i jashtëm është kod keqdashës',
  '',
  `${rows.length - failed}/${rows.length} raste kaluan. Programi sulmues: \`tests/cpi/attacker\`, i ngarkuar në një makinë virtuale Solana.`,
  '',
  '| Rasti | Pritej | Ndodhi | Verifier-i | Shkelje | Çfarë provon |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows.map(r => `| ${r.name} | ${r.expected} | ${r.outcome} | ${r.verifier} | ${r.broken.join('; ') || '—'} | ${r.proves} |`),
  '',
].join('\n'));
log(`\nT6 ${rows.length - failed}/${rows.length}  →  ${OUT_DIR}/cpi.md`);
process.exit(failed ? 1 : 0);
