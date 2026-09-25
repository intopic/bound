import { address } from '@solana/kit';
import type { Address } from '@solana/kit';
import { feeBpsSetting, treasurySetting } from '../settings';

/**
 * Fee settings fixed at build time (audit B-01). They are compiled into the bundle, so with a
 * reproducible build they are pinned, and the server has no live channel to change them.
 * The verifier additionally caps the fee at MAX_FEE_BPS whatever these say.
 */
// Read the way the build checked them (next.config.ts refuses a wrong one), so what reaches the page
// is either a valid setting or none.
const treasury = treasurySetting(process.env.NEXT_PUBLIC_BOUND_TREASURY);
export const TREASURY: Address | null = treasury ? address(treasury) : null;
export const FEE_BPS: bigint = feeBpsSetting(process.env.NEXT_PUBLIC_BOUND_FEE_BPS);
/** v1 transactions only when a build says so, until one has landed on mainnet (review BR-12). */
export const V1_ENABLED = process.env.NEXT_PUBLIC_BOUND_ENABLE_V1 === '1';
