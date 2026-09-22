import { findAssociatedTokenPda } from '@solana-program/token';
import type { Address } from '@solana/kit';
import {
  BPS_DENOMINATOR, MAX_TAKER_RENT_LAMPORTS, TOKEN_2022_PROGRAM, TOKEN_ACCOUNT_SIZE, TOKEN_PROGRAM, WSOL_MINT,
} from './constants.ts';
import type { BoundConfig, Intent, Policy, Variant } from './types.ts';

/** Token amount of a classic SPL token account (offset 64), or 0 for a missing account. */
export function tokenAmountOf(data: Uint8Array | null | undefined): bigint {
  if (!data || data.length < 72) return 0n;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

/**
 * The size of a new associated token account for this mint, as the token program allocates it, so
 * the rent shown before signing is the rent that will be charged. A classic account is 165 bytes.
 * A Token-2022 one adds an account-type byte, the ImmutableOwner marker the ATA program always
 * sets, and one account-side extension for each mint extension that needs one: a transfer fee
 * withholds into the account (8 bytes), a transfer hook marks it (1), a non-transferable or
 * pausable mint flags it (0). Checked against mainnet in T12: PYUSD and USDG 187, CASH 175.
 */
export function tokenAccountSizeFor(program: Address, mintData: Uint8Array | null | undefined): number {
  if (program !== TOKEN_2022_PROGRAM) return TOKEN_ACCOUNT_SIZE;
  const ACCOUNT_SIDE: Record<number, number> = { 1: 8, 9: 0, 14: 1, 26: 0 };
  let size = TOKEN_ACCOUNT_SIZE + 1 + 4; // account type, then ImmutableOwner's empty entry
  if (mintData && mintData.length > TOKEN_ACCOUNT_SIZE && mintData[TOKEN_ACCOUNT_SIZE] === 1) {
    const view = new DataView(mintData.buffer, mintData.byteOffset, mintData.byteLength);
    for (let at = TOKEN_ACCOUNT_SIZE + 1; at + 4 <= mintData.length; ) {
      const type = view.getUint16(at, true);
      if (type === 0) break;
      if (ACCOUNT_SIDE[type] !== undefined) size += 4 + ACCOUNT_SIDE[type];
      at += 4 + view.getUint16(at + 2, true);
    }
  }
  // The token program never lets an account be the size of a multisig, which is 355 bytes; it
  // pads such an account by the width of one extension type.
  return size === 355 ? size + 2 : size;
}

export async function ataOf(owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM): Promise<Address> {
  const [pda] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
  return pda;
}

export function variantOf(inputMint: Address, outputMint: Address): Variant {
  if (outputMint === WSOL_MINT) return 'A';
  if (inputMint === WSOL_MINT) return 'B';
  return 'C';
}

export function feeFor(amountIn: bigint, config: Pick<BoundConfig, 'feeBps' | 'treasury'>): bigint {
  return config.treasury ? (amountIn * config.feeBps) / BPS_DENOMINATOR : 0n;
}

export class PolicyError extends Error {}

/** The policy with the minimum output of the chosen route (audit B-04). */
export function withMinOut(policy: Policy, minOut: bigint): Policy {
  if (minOut <= 0n) throw new PolicyError('The route guarantees no minimum output');
  return { ...policy, minOut };
}

/** The policy with the rent the chosen route needs E to pay; see `Policy.takerRent`. */
export function withTakerRent(policy: Policy, takerRent: bigint): Policy {
  if (takerRent < 0n || takerRent > MAX_TAKER_RENT_LAMPORTS) throw new PolicyError('Route rent outside the allowed range');
  return { ...policy, takerRent };
}

/** Turns an intent into the exact policy the compiler builds and the verifier enforces (plan, section 1). */
export async function buildPolicy(args: {
  intent: Intent;
  ephemeral: Address;
  inputDecimals: number;
  outputDecimals: number;
  config: BoundConfig;
  /** The token program that owns each mint, as read from the chain. Classic SPL by default. */
  inputTokenProgram?: Address;
  outputTokenProgram?: Address;
  /** Whether the input mint charges a Token-2022 transfer fee, as read from the chain. */
  inputTransferFee?: boolean;
  /**
   * Whether ATA(treasury, inputMint) already exists on chain. When it does not, the swap is
   * fee-free: Bound never makes the user pay rent for Bound's own account (audit B-09).
   */
  feeAccountExists: boolean;
  /** Minimum output Bound enforces; usually set later from the chosen route (see `withMinOut`). */
  minOut?: bigint;
}): Promise<Policy> {
  const { intent, ephemeral, config } = args;
  if (intent.inputMint === intent.outputMint) throw new PolicyError('Input and output token are the same');
  if (intent.amountIn <= 0n) throw new PolicyError('Amount must be above zero');
  if (ephemeral === intent.owner) throw new PolicyError('The temporary key must differ from the wallet');

  const variant = variantOf(intent.inputMint, intent.outputMint);
  // Wrapped SOL is always a classic token, whatever the caller was told.
  const inProgram = intent.inputMint === WSOL_MINT ? TOKEN_PROGRAM : args.inputTokenProgram ?? TOKEN_PROGRAM;
  const outProgram = intent.outputMint === WSOL_MINT ? TOKEN_PROGRAM : args.outputTokenProgram ?? TOKEN_PROGRAM;
  // Variant B pays the fee in SOL to the treasury wallet itself, which needs no token account.
  const treasury = variant === 'B' || args.feeAccountExists ? config.treasury : null;
  const fee = feeFor(intent.amountIn, { feeBps: config.feeBps, treasury });
  const swapAmount = intent.amountIn - fee;
  if (swapAmount <= 0n) throw new PolicyError('Amount is too small to cover the fee');

  const feeDestination =
    fee === 0n ? null : variant === 'B' ? treasury : await ataOf(treasury!, intent.inputMint, inProgram);

  return {
    owner: intent.owner,
    ephemeral,
    inputMint: intent.inputMint,
    outputMint: intent.outputMint,
    inputTokenProgram: inProgram,
    outputTokenProgram: outProgram,
    inputTransferFee: args.inputTransferFee ?? false,
    inputDecimals: args.inputDecimals,
    outputDecimals: args.outputDecimals,
    minOut: args.minOut ?? 0n,
    takerRent: 0n,
    amountIn: intent.amountIn,
    feeBps: config.feeBps,
    fee,
    swapAmount,
    treasury,
    maxNetworkFeeLamports: config.maxNetworkFeeLamports,
    jupiterProgram: config.jupiterProgram,
    variant,
    accounts: {
      eIn: await ataOf(ephemeral, intent.inputMint, inProgram),
      eOut: variant === 'A' ? await ataOf(ephemeral, WSOL_MINT) : null,
      wIn: variant === 'B' ? null : await ataOf(intent.owner, intent.inputMint, inProgram),
      wOut: variant === 'A' ? null : await ataOf(intent.owner, intent.outputMint, outProgram),
      feeDestination,
    },
  };
}
