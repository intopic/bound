import { isAddress, address } from '@solana/kit';
import type { Address } from '@solana/kit';

/**
 * Fee settings fixed at build time (audit B-01). They are compiled into the bundle, so with a
 * reproducible build they are pinned, and the server has no live channel to change them.
 * The verifier additionally caps the fee at MAX_FEE_BPS whatever these say.
 */
const rawTreasury = process.env.NEXT_PUBLIC_BOUND_TREASURY?.trim() ?? '';
export const TREASURY: Address | null = rawTreasury && isAddress(rawTreasury) ? address(rawTreasury) : null;
export const FEE_BPS: bigint = BigInt(process.env.NEXT_PUBLIC_BOUND_FEE_BPS ?? '50');
/** v1 transactions only when a build says so, until one has landed on mainnet (review BR-12). */
export const V1_ENABLED = process.env.NEXT_PUBLIC_BOUND_ENABLE_V1 === '1';
