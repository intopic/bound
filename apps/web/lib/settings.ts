import { isAddress } from '@solana/kit';

/**
 * The deployment settings the page is built with, read the same way by the page, the agent API and
 * the build itself (next.config.ts), which refuses a wrong one. A fee typed as a percentage ("0.3")
 * would otherwise stop the page from loading at all, an empty one would make every swap fail as
 * "too small", and a mistyped treasury would silently run a fee-free deployment.
 */

/** NEXT_PUBLIC_ORIENTIM_FEE_BPS: whole basis points, 0 to 100 (30 = 0.3%); 30 when unset or empty. */
export function feeBpsSetting(raw: string | undefined): bigint {
  const value = raw?.trim() ?? '';
  if (value === '') return 30n;
  if (!/^\d{1,3}$/.test(value) || BigInt(value) > 100n) {
    throw new Error(`NEXT_PUBLIC_ORIENTIM_FEE_BPS must be a whole number of basis points from 0 to 100 (30 means 0.3%), not "${raw}".`);
  }
  return BigInt(value);
}

/** NEXT_PUBLIC_ORIENTIM_TREASURY: a Solana address, or empty for test mode (no fee). */
export function treasurySetting(raw: string | undefined): string | null {
  const value = raw?.trim() ?? '';
  if (value === '') return null;
  if (!isAddress(value)) throw new Error(`NEXT_PUBLIC_ORIENTIM_TREASURY must be a Solana address, or empty for test mode: "${raw}" is not one.`);
  return value;
}

/** Two signatures: a network fee limit below this refuses every swap. */
const LEAST_NETWORK_FEE_LAMPORTS = 10_000n;

/** ORIENTIM_MAX_NETWORK_FEE_LAMPORTS: lamports, at least two signatures' worth; 500,000 when unset or empty. */
export function maxNetworkFeeSetting(raw: string | undefined): bigint {
  const value = raw?.trim() ?? '';
  if (value === '') return 500_000n;
  if (!/^\d{1,19}$/.test(value) || BigInt(value) < LEAST_NETWORK_FEE_LAMPORTS) {
    throw new Error(`ORIENTIM_MAX_NETWORK_FEE_LAMPORTS must be a whole number of lamports of at least ${LEAST_NETWORK_FEE_LAMPORTS}, not "${raw}".`);
  }
  return BigInt(value);
}

/**
 * Every setting at once, as the build checks them: the first wrong one is thrown, with what to fix.
 * A treasury with a fee of 0 is refused too: every swap it builds would carry no fee, which a
 * deployment with a treasury refuses to build.
 */
export function checkDeploymentSettings(env: Record<string, string | undefined>): void {
  const fee = feeBpsSetting(env.NEXT_PUBLIC_ORIENTIM_FEE_BPS);
  const treasury = treasurySetting(env.NEXT_PUBLIC_ORIENTIM_TREASURY);
  maxNetworkFeeSetting(env.ORIENTIM_MAX_NETWORK_FEE_LAMPORTS);
  if (treasury && fee === 0n) {
    throw new Error('NEXT_PUBLIC_ORIENTIM_FEE_BPS is 0 while NEXT_PUBLIC_ORIENTIM_TREASURY is set: every swap would be refused. Set the fee (30 = 0.3%), or empty the treasury for test mode.');
  }
}
