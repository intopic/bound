import { findAssociatedTokenPda } from '@solana-program/token';
import type { Address } from '@solana/kit';
import { BPS_DENOMINATOR, TOKEN_PROGRAM, WSOL_MINT } from './constants.ts';
import type { BoundConfig, Intent, Policy, Variant } from './types.ts';

/** Token amount of a classic SPL token account (offset 64), or 0 for a missing account. */
export function tokenAmountOf(data: Uint8Array | null | undefined): bigint {
  if (!data || data.length < 72) return 0n;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
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
    inputDecimals: args.inputDecimals,
    outputDecimals: args.outputDecimals,
    minOut: args.minOut ?? 0n,
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
