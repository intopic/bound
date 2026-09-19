import { ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS } from '@bound/core';

/**
 * Server-only settings. Secrets (RPC URLs, API keys) never reach the browser (D8).
 *
 * The fee and the treasury are NOT here: they are fixed at build time (NEXT_PUBLIC_BOUND_*), so a
 * compromised server cannot change where fees go or how large they are (audit B-01).
 */
export function serverConfig() {
  const maxFee = BigInt(process.env.BOUND_MAX_NETWORK_FEE_LAMPORTS ?? '200000');
  return {
    rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    rpcUrlSecondary: process.env.RPC_URL_SECONDARY || null,
    jupiterApiKey: process.env.JUPITER_API_KEY || null,
    maxUsdPerSwap: Number(process.env.BOUND_MAX_USD_PER_SWAP ?? '100'),
    disabled: process.env.BOUND_DISABLED === '1',
    excludeDexes: (process.env.BOUND_EXCLUDE_DEXES ?? 'HumidiFi,Pump.fun Amm').split(',').map(s => s.trim()).filter(Boolean),
    // Clamped to the verifier's absolute ceiling (audit B-02); the verifier enforces it anyway.
    maxNetworkFeeLamports: maxFee < ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS ? maxFee : ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS,
  };
}

/** What the browser is allowed to know. */
export type PublicStatus = {
  enabled: boolean;
  maxUsdPerSwap: number;
  excludeDexes: string[];
  maxNetworkFeeLamports: string;
  secondaryRpc: boolean;
};

export function publicStatus(): PublicStatus {
  const c = serverConfig();
  return {
    enabled: !c.disabled,
    maxUsdPerSwap: c.maxUsdPerSwap,
    excludeDexes: c.excludeDexes,
    maxNetworkFeeLamports: c.maxNetworkFeeLamports.toString(),
    secondaryRpc: !!c.rpcUrlSecondary,
  };
}
