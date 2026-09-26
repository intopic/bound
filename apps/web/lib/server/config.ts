import { ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS } from '@orientim/core';
import { maxNetworkFeeSetting } from '../settings';

/**
 * Server-only settings. Secrets (RPC URLs, API keys) never reach the browser (D8).
 *
 * The fee and the treasury are NOT here: they are fixed at build time (NEXT_PUBLIC_ORIENTIM_*), so a
 * compromised server cannot change where fees go or how large they are (audit B-01).
 */
let warnedNoJupiterKey = false;
let warnedMaxFee = false;

/** F_max as configured; the default, said once, when the value cannot be read (the build refuses it too). */
function configuredMaxFee(): bigint {
  try {
    return maxNetworkFeeSetting(process.env.ORIENTIM_MAX_NETWORK_FEE_LAMPORTS);
  } catch (e) {
    if (!warnedMaxFee) {
      warnedMaxFee = true;
      console.error(`${(e as Error).message} Using 500000.`);
    }
    return 500_000n;
  }
}

export function serverConfig() {
  const maxFee = configuredMaxFee();
  // Jupiter's API asks for a key on every endpoint; without one it answers a request or two and then
  // refuses, so quotes fail as "busy" under any load (final audit, H1). Said once, where the
  // operator reads it, and never to the public.
  if (!process.env.JUPITER_API_KEY && process.env.NODE_ENV === 'production' && !warnedNoJupiterKey) {
    warnedNoJupiterKey = true;
    console.error('JUPITER_API_KEY is not set: Jupiter throttles keyless requests, and quotes will fail as "busy". Get a key at https://developers.jup.ag/portal.');
  }
  return {
    rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    jupiterApiKey: process.env.JUPITER_API_KEY || null,
    // No limit unless one is configured: the protection does not depend on the amount, and a
    // limit would also block every token that has no USD price.
    maxUsdPerSwap: usdCap(process.env.ORIENTIM_MAX_USD_PER_SWAP),
    disabled: process.env.ORIENTIM_DISABLED === '1',
    excludeDexes: (process.env.ORIENTIM_EXCLUDE_DEXES ?? 'HumidiFi').split(',').map(s => s.trim()).filter(Boolean),
    // Clamped to the verifier's absolute ceiling (audit B-02); the verifier enforces it anyway.
    maxNetworkFeeLamports: maxFee < ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS ? maxFee : ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS,
  };
}

/**
 * The operator's cap per swap, in USD, or null for none. A value that is set but is not a number
 * ("1,000") becomes 0, which refuses every swap: a mistyped cap fails closed, never open.
 */
export function usdCap(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  if (!warnedBadCap) {
    warnedBadCap = true;
    console.error(`ORIENTIM_MAX_USD_PER_SWAP is not a number (${JSON.stringify(raw)}): every swap is refused until it is fixed.`);
  }
  return 0;
}
let warnedBadCap = false;

/** What the browser is allowed to know. */
export type PublicStatus = {
  enabled: boolean;
  /** Optional operational cap per swap, in USD; null means no limit. */
  maxUsdPerSwap: number | null;
  excludeDexes: string[];
  maxNetworkFeeLamports: string;
};

export function publicStatus(): PublicStatus {
  const c = serverConfig();
  return {
    enabled: !c.disabled,
    maxUsdPerSwap: c.maxUsdPerSwap,
    excludeDexes: c.excludeDexes,
    maxNetworkFeeLamports: c.maxNetworkFeeLamports.toString(),
  };
}
