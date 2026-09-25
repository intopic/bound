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
  // operator reads it; /api/status says it too.
  if (!process.env.JUPITER_API_KEY && process.env.NODE_ENV === 'production' && !warnedNoJupiterKey) {
    warnedNoJupiterKey = true;
    console.error('JUPITER_API_KEY is not set: Jupiter throttles keyless requests, and quotes will fail as "busy". Get a key at https://developers.jup.ag/portal.');
  }
  return {
    rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    jupiterApiKey: process.env.JUPITER_API_KEY || null,
    // No limit unless one is configured: the protection does not depend on the amount, and a
    // limit would also block every token that has no USD price.
    maxUsdPerSwap: process.env.ORIENTIM_MAX_USD_PER_SWAP ? Number(process.env.ORIENTIM_MAX_USD_PER_SWAP) : null,
    disabled: process.env.ORIENTIM_DISABLED === '1',
    excludeDexes: (process.env.ORIENTIM_EXCLUDE_DEXES ?? 'HumidiFi').split(',').map(s => s.trim()).filter(Boolean),
    // Clamped to the verifier's absolute ceiling (audit B-02); the verifier enforces it anyway.
    maxNetworkFeeLamports: maxFee < ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS ? maxFee : ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS,
  };
}

/** What the browser is allowed to know. */
export type PublicStatus = {
  enabled: boolean;
  /** Optional operational cap per swap, in USD; null means no limit. */
  maxUsdPerSwap: number | null;
  excludeDexes: string[];
  maxNetworkFeeLamports: string;
  /** Whether the deployment has a Jupiter API key; without one, quotes fail under load. */
  jupiterKey: boolean;
};

export function publicStatus(): PublicStatus {
  const c = serverConfig();
  return {
    enabled: !c.disabled,
    maxUsdPerSwap: c.maxUsdPerSwap,
    excludeDexes: c.excludeDexes,
    maxNetworkFeeLamports: c.maxNetworkFeeLamports.toString(),
    jupiterKey: c.jupiterApiKey !== null,
  };
}
