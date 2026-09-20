import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayer,
  setTransactionMessageHeapSize,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLoadedAccountsDataSizeLimit,
  setTransactionMessagePriorityFeeLamports,
} from '@solana/kit';
import type { Address, Blockhash, Instruction, KeyPairSigner, Transaction } from '@solana/kit';
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import {
  ataOf, buildPolicy, JUPITER_PROGRAM, protectedInstructions, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT,
} from '@bound/core';
import type { AccountState, ChainSnapshot, IntermediateAta, Policy, TxVersion } from '@bound/core';

export const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const BONK = address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
export const JUP = address('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');
/** A token W holds that is never part of the swap. */
export const WIF = address('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm');
const LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');
const DEX = address('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

export const DECIMALS: Record<string, number> = {
  So11111111111111111111111111111111111111112: 9,
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 5,
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 6,
};

export const LIFETIME = {
  blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' as Blockhash,
  lastValidBlockHeight: 1_000_000n,
};

export const randomAddress = async () => (await generateKeyPairSigner()).address;

export const CONFIG = (treasury: Address | null) => ({
  feeBps: 50n,
  treasury,
  maxNetworkFeeLamports: 200_000n,
  jupiterProgram: JUPITER_PROGRAM,
});

const tokenAccountData = (owner: Address, mint: Address) => {
  const data = new Uint8Array(165);
  data.set(getAddressEncoder().encode(mint), 0);
  data.set(getAddressEncoder().encode(owner), 32);
  return data;
};

export type Scenario = {
  W: Address;
  E: KeyPairSigner;
  treasury: Address | null;
  policy: Policy;
  swapIx: Instruction;
  pools: Address[];
  intermediates: IntermediateAta[];
  lookupTable: Address;
  lookupTables: Record<string, Address[]>;
  snapshot: ChainSnapshot;
  /** A token account of W that is not part of the swap (WIF). */
  wOther: Address;
  /** Token balance W_out already holds before the swap (variants B and C). */
  wOutBalance: bigint;
};

/** A realistic protected swap with a fake Jupiter instruction touching `poolCount` pool accounts. */
export async function scenario(opts: {
  input?: Address;
  output?: Address;
  fee?: boolean;
  feeAccountExists?: boolean;
  intermediates?: number;
  poolCount?: number;
  owner?: KeyPairSigner;
  minOut?: bigint;
  wOutBalance?: bigint;
  /** Token program of each mint; classic SPL unless a test asks for Token-2022. */
  inputProgram?: Address;
  outputProgram?: Address;
  /** Extension types written into a Token-2022 mint, as [type, payload length] pairs. */
  inputExtensions?: [number, number][];
  outputExtensions?: [number, number][];
} = {}): Promise<Scenario> {
  const W = opts.owner?.address ?? (await randomAddress());
  const E = await generateKeyPairSigner();
  const treasury = opts.fee === false ? null : await randomAddress();
  const input = opts.input ?? USDC;
  const output = opts.output ?? WSOL_MINT;
  const inputProgram = input === WSOL_MINT ? TOKEN_PROGRAM : opts.inputProgram ?? TOKEN_PROGRAM;
  const outputProgram = output === WSOL_MINT ? TOKEN_PROGRAM : opts.outputProgram ?? TOKEN_PROGRAM;
  const policy = await buildPolicy({
    intent: { owner: W, inputMint: input, outputMint: output, amountIn: input === WSOL_MINT ? 900_000_000n : 100_000_000n },
    ephemeral: E.address,
    inputDecimals: DECIMALS[input],
    outputDecimals: DECIMALS[output],
    inputTokenProgram: inputProgram,
    outputTokenProgram: outputProgram,
    // A mint that taxes its transfers needs the withheld amount harvested before the close.
    inputTransferFee: inputProgram === TOKEN_2022_PROGRAM && (opts.inputExtensions ?? []).some(([type]) => type === 1),
    minOut: opts.minOut ?? 1_000_000n,
    config: CONFIG(treasury),
    feeAccountExists: opts.feeAccountExists ?? true,
  });

  const intermediates: IntermediateAta[] = [];
  const hopMints = [JUP, BONK];
  // A hop may be one of the swap's own mints, and a taxing mint is harvested wherever it lands.
  const taxes = (mint: Address) =>
    (mint === input && inputProgram === TOKEN_2022_PROGRAM && (opts.inputExtensions ?? []).some(([t]) => t === 1)) ||
    (mint === output && outputProgram === TOKEN_2022_PROGRAM && (opts.outputExtensions ?? []).some(([t]) => t === 1));
  for (let i = 0; i < (opts.intermediates ?? 0); i++) {
    const mint = hopMints[i];
    // A hop belongs to the program that owns its mint, which for one of the swap's own mints may
    // be Token-2022.
    const tokenProgram = mint === input ? inputProgram : mint === output ? outputProgram : TOKEN_PROGRAM;
    intermediates.push({ ata: await ataOf(E.address, mint, tokenProgram), mint, tokenProgram, transferFee: taxes(mint) });
  }

  const pools = await Promise.all(Array.from({ length: opts.poolCount ?? 12 }, randomAddress));
  const a = policy.accounts;
  const destination = policy.variant === 'A' ? a.eOut! : a.wOut!;
  const swapIx: Instruction = {
    programAddress: JUPITER_PROGRAM,
    accounts: [
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: E.address, role: AccountRole.READONLY_SIGNER },
      { address: a.eIn, role: AccountRole.WRITABLE },
      ...intermediates.map(x => ({ address: x.ata, role: AccountRole.WRITABLE })),
      { address: destination, role: AccountRole.WRITABLE },
      { address: input, role: AccountRole.READONLY },
      { address: output, role: AccountRole.READONLY },
      { address: DEX, role: AccountRole.READONLY },
      ...pools.map(p => ({ address: p, role: AccountRole.WRITABLE })),
    ],
    data: new Uint8Array([229, 23, 203, 151, 122, 227, 173, 42, 1, 2, 3, 4]),
  };

  const lookupTable = await randomAddress();
  const lookupTables = { [lookupTable]: [...pools, DEX, TOKEN_PROGRAM, input, output] };

  const wOther = await ataOf(W, WIF);
  const accounts = new Map<string, AccountState | null>();
  const mintState = (program: Address, decimals = 0, extensions: [number, number][] = []): AccountState => {
    // A Token-2022 mint is padded to the size of a token account, then an account-type byte, then
    // the extensions: [type u16][length u16][payload].
    const size = program === TOKEN_2022_PROGRAM
      ? 166 + extensions.reduce((n, [, length]) => n + 4 + length, 0)
      : 82;
    const data = new Uint8Array(size);
    data[44] = decimals; // the verifier reads decimals from the mint (audit C-01)
    if (program === TOKEN_2022_PROGRAM) {
      data[165] = 1; // AccountType::Mint
      const view = new DataView(data.buffer);
      let at = 166;
      for (const [type, length] of extensions) {
        view.setUint16(at, type, true);
        view.setUint16(at + 2, length, true);
        at += 4 + length;
      }
    }
    return { owner: program, lamports: 1_066_800n, data };
  };
  accounts.set(input, mintState(inputProgram, DECIMALS[input], opts.inputExtensions ?? [[18, 64]]));
  accounts.set(output, mintState(outputProgram, DECIMALS[output], opts.outputExtensions ?? [[18, 64]]));
  // A hop mint may also be the output mint; the swap's own mints win.
  for (const m of hopMints) if (!accounts.has(m)) accounts.set(m, mintState(TOKEN_PROGRAM, DECIMALS[m]));
  for (const p of pools) accounts.set(p, { owner: DEX, lamports: 5_000_000n, data: new Uint8Array(300) });
  accounts.set(DEX, { owner: LOADER, lamports: 1n, data: new Uint8Array(36) });
  accounts.set(TOKEN_PROGRAM, { owner: LOADER, lamports: 1n, data: new Uint8Array(36) });
  accounts.set(TOKEN_2022_PROGRAM, { owner: LOADER, lamports: 1n, data: new Uint8Array(36) });
  for (const x of [E.address, a.eIn, a.eOut, ...intermediates.map(i => i.ata)]) if (x) accounts.set(x, null);
  if (a.wIn) accounts.set(a.wIn, { owner: inputProgram, lamports: 2_039_280n, data: tokenAccountData(W, input) });
  const wOutBalance = opts.wOutBalance ?? 0n;
  if (a.wOut) {
    const data = tokenAccountData(W, output);
    new DataView(data.buffer).setBigUint64(64, wOutBalance, true);
    accounts.set(a.wOut, { owner: outputProgram, lamports: 2_039_280n, data });
  }
  accounts.set(wOther, { owner: TOKEN_PROGRAM, lamports: 2_039_280n, data: tokenAccountData(W, WIF) });

  return {
    W, E, treasury, policy, swapIx, pools, intermediates, lookupTable, lookupTables,
    snapshot: { accounts, lookupTables }, wOther, wOutBalance,
  };
}

export const cuIxs = (units = 400_000, microLamports = 50_000n) => [
  getSetComputeUnitLimitInstruction({ units }),
  getSetComputeUnitPriceInstruction({ microLamports }),
];

/**
 * Compiles an arbitrary instruction list the way an attacker (or a buggy compiler) could.
 * For v0 the caller includes the ComputeBudget instructions it wants.
 */
export function compileRaw(
  feePayer: Address,
  ixs: Instruction[],
  version: TxVersion,
  lookupTables?: Record<string, Address[]>,
  v1Budget: { units?: number; priorityFeeLamports?: bigint } = {},
): Transaction {
  if (version === 1) {
    return compileTransaction(pipe(
      createTransactionMessage({ version: 1 }),
      m => setTransactionMessageFeePayer(feePayer, m),
      m => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
      m => setTransactionMessageComputeUnitLimit(v1Budget.units ?? 400_000, m),
      m => setTransactionMessagePriorityFeeLamports(v1Budget.priorityFeeLamports ?? 20_000n, m),
      m => setTransactionMessageLoadedAccountsDataSizeLimit(64 * 1024 * 1024, m),
      m => appendTransactionMessageInstructions(ixs, m),
    ));
  }
  const base = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
    m => appendTransactionMessageInstructions(ixs, m),
  );
  return compileTransaction(lookupTables ? compressTransactionMessageUsingAddressLookupTables(base, lookupTables as never) : base);
}

/** The honest instruction list for a scenario (what the compiler produces). */
export const honest = (s: Scenario) =>
  protectedInstructions({
    policy: s.policy, swapInstruction: s.swapIx, intermediates: s.intermediates, outputBalanceBefore: s.wOutBalance,
  });

/** A v1 transaction whose config also carries a heap size, which Bound never sets (B-07). */
export function compileRawV1WithHeap(feePayer: Address, ixs: Instruction[]): Transaction {
  return compileTransaction(pipe(
    createTransactionMessage({ version: 1 }),
    m => setTransactionMessageFeePayer(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
    m => setTransactionMessageComputeUnitLimit(400_000, m),
    m => setTransactionMessagePriorityFeeLamports(20_000n, m),
    m => setTransactionMessageLoadedAccountsDataSizeLimit(64 * 1024 * 1024, m),
    m => setTransactionMessageHeapSize(64 * 1024, m),
    m => appendTransactionMessageInstructions(ixs, m),
  ));
}
