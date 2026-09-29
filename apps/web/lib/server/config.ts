import { ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS } from '@orientim/core';
import { maxNetworkFeeSetting } from '../settings';

/**
 * Server-only settings. Secrets (RPC URLs, API keys) never reach the browser.
 *
 * The fee and the treasury are NOT here: they are fixed at build time (NEXT_PUBLIC_ORIENTIM_*), so a
 * compromised server cannot change where fees go or how large they are.
 */
let warnedNoJupiterKey = false;
let warnedNoRpcUrl = false;
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
  // refuses, so quotes fail as "busy" under any load. Said once, where the
  // operator reads it, and never to the public.
  if (!process.env.JUPITER_API_KEY && process.env.NODE_ENV === 'production' && !warnedNoJupiterKey) {
    warnedNoJupiterKey = true;
    console.error('JUPITER_API_KEY is not set: Jupiter throttles keyless requests, and quotes will fail as "busy". Get a key at https://developers.jup.ag/portal.');
  }
  // Without RPC_URL the site falls back to Solana's public endpoint, whose limits are far too low to
  // send swaps under any load: they fail as "busy" with no other sign of why. Said once, like the key.
  if (!process.env.RPC_URL && process.env.NODE_ENV === 'production' && !warnedNoRpcUrl) {
    warnedNoRpcUrl = true;
    console.error('RPC_URL is not set: using the public Solana RPC, which rate-limits hard, so swaps will fail as "busy". Set RPC_URL to a paid provider (Helius).');
  }
  return {
    rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    // A second provider, asked only when the first is down or rate-limited (rpcFailover.ts).
    rpcFallbackUrl: process.env.RPC_URL_FALLBACK || null,
    jupiterApiKey: process.env.JUPITER_API_KEY || null,
    disabled: process.env.ORIENTIM_DISABLED === '1',
    excludeDexes: (process.env.ORIENTIM_EXCLUDE_DEXES ?? 'HumidiFi').split(',').map(s => s.trim()).filter(Boolean),
    // Clamped to the verifier's absolute ceiling; the verifier enforces it anyway.
    maxNetworkFeeLamports: maxFee < ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS ? maxFee : ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS,
  };
}

/** What anyone may know, at /api/status. */
export type PublicStatus = {
  enabled: boolean;
  excludeDexes: string[];
  maxNetworkFeeLamports: string;
};

export function publicStatus(): PublicStatus {
  const c = serverConfig();
  return {
    enabled: !c.disabled,
    excludeDexes: c.excludeDexes,
    maxNetworkFeeLamports: c.maxNetworkFeeLamports.toString(),
  };
}
