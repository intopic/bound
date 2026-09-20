import type { Address } from '@solana/kit';

export type TxVersion = 0 | 1;

/** A: SPL -> SOL, B: SOL -> SPL, C: SPL -> SPL (plan, section 5). */
export type Variant = 'A' | 'B' | 'C';

/** What the user asked for: "swap `amountIn` of `inputMint` for `outputMint`". */
export type Intent = {
  owner: Address;
  inputMint: Address;
  outputMint: Address;
  /** q, in base units of the input token. The Bound fee is taken inside it (D10). */
  amountIn: bigint;
};

export type BoundConfig = {
  /** 50n = 0.5%. */
  feeBps: bigint;
  /** Fee recipient wallet. When null the fee is 0 (test mode). */
  treasury: Address | null;
  /** F_max: upper bound for base + priority fee paid by W. */
  maxNetworkFeeLamports: bigint;
  jupiterProgram: Address;
};

export type PolicyAccounts = {
  /** ATA(E, inputMint): the only account the swap may spend from. */
  eIn: Address;
  /** ATA(E, WSOL) when the output is SOL (variant A). */
  eOut: Address | null;
  /** ATA(W, inputMint) when the input is SPL. */
  wIn: Address | null;
  /** ATA(W, outputMint) when the output is SPL. */
  wOut: Address | null;
  /** ATA(treasury, inputMint) for SPL input, the treasury wallet for SOL input; null when fee = 0. */
  feeDestination: Address | null;
};

export type Policy = {
  owner: Address;
  ephemeral: Address;
  inputMint: Address;
  outputMint: Address;
  /**
   * Which token program owns each mint: the classic one or Token-2022. Taken from the chain, never
   * from a token list, and re-derived by the verifier from the same snapshot.
   */
  inputTokenProgram: Address;
  outputTokenProgram: Address;
  /**
   * Whether the input mint charges a transfer fee. Such a fee is withheld in the receiving
   * account, and an account with withheld fees cannot be closed, so the cleanup harvests them to
   * the mint first. Read from the chain and re-derived by the verifier.
   */
  inputTransferFee: boolean;
  inputDecimals: number;
  outputDecimals: number;
  /**
   * The minimum output Bound itself enforces after the swap (audit B-04), in base units of the
   * output token. Set from the chosen route's quoted floor; 0 until a route is chosen, and the
   * verifier rejects 0.
   */
  minOut: bigint;
  amountIn: bigint;
  feeBps: bigint;
  fee: bigint;
  swapAmount: bigint;
  /** Null in test mode, and when the treasury has no account for the input token (audit B-09). */
  treasury: Address | null;
  maxNetworkFeeLamports: bigint;
  jupiterProgram: Address;
  variant: Variant;
  accounts: PolicyAccounts;
};

/** A token account owned by E that the route uses as an intermediate hop (D14). */
export type IntermediateAta = { ata: Address; mint: Address; tokenProgram: Address };

export type AccountState = { owner: Address; lamports: bigint; data: Uint8Array };

/**
 * Everything the verifier needs from the chain, fetched beforehand so that `verify` itself makes
 * no network calls. A missing or null entry means the account does not exist.
 */
export type ChainSnapshot = {
  accounts: ReadonlyMap<string, AccountState | null>;
  /** v0 only: lookup table contents as read from the RPC (never from Jupiter). */
  lookupTables: Readonly<Record<string, readonly Address[]>>;
};

export type RuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7';
export type Violation = { rule: RuleId; detail: string };
export type Verdict = { ok: boolean; violations: Violation[] };
