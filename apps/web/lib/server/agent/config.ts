import { address, isAddress } from '@solana/kit';
import { createJupiterClient } from '@bound/jupiter';
import type { JupiterClient } from '@bound/jupiter';
import { createRetryingRpc } from '@bound/solana';
import type { SolanaRpc } from '@bound/solana';
import { serverConfig } from '../config';
import type { AgentDeps } from './api';

/**
 * The agent API is off unless the deployment sets both of these (tools/agent-key.ts makes them):
 *
 *   BOUND_API_SECRET           32 random bytes, base64: seals tickets and derives each E
 *   BOUND_API_SECRET_PREVIOUS  optional, the one before it, while its tickets expire (a minute)
 *   BOUND_API_KEYS             id:sha256-of-key, comma-separated; only the hashes are stored
 *   BOUND_API_FEE_BPS          optional, the fee for API swaps; the page's fee otherwise
 *   BOUND_API_PER_MINUTE       optional, requests per minute per key and endpoint (60)
 */
function secretOf(value: string | undefined): Uint8Array | null {
  if (!value) return null;
  const bytes = Buffer.from(value.trim(), 'base64');
  return bytes.length >= 32 ? new Uint8Array(bytes) : null;
}

function keysOf(value: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  for (const entry of (value ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [id, hash] = entry.split(':');
    if (/^[\w-]{1,40}$/.test(id ?? '') && /^[0-9a-f]{64}$/.test(hash ?? '')) keys.set(hash, id);
  }
  return keys;
}

// The clients are kept per instance; the settings are read on every request, so the kill switch
// and a rotated key take effect without a redeploy.
let clients: { rpc: SolanaRpc; jupiter: JupiterClient; for: string } | null = null;

export function agentDeps(): AgentDeps | null {
  const current = secretOf(process.env.BOUND_API_SECRET);
  const keys = keysOf(process.env.BOUND_API_KEYS);
  if (!current || keys.size === 0) return null;
  const previous = secretOf(process.env.BOUND_API_SECRET_PREVIOUS);
  const server = serverConfig();
  const feeBps = BigInt(/^\d{1,3}$/.test(process.env.BOUND_API_FEE_BPS ?? '') ? process.env.BOUND_API_FEE_BPS!
    : /^\d{1,3}$/.test(process.env.NEXT_PUBLIC_BOUND_FEE_BPS ?? '') ? process.env.NEXT_PUBLIC_BOUND_FEE_BPS! : '20');
  const treasury = process.env.NEXT_PUBLIC_BOUND_TREASURY?.trim() ?? '';
  const identity = `${server.rpcUrl}|${server.jupiterApiKey ?? ''}`;
  if (clients?.for !== identity) {
    clients = {
      for: identity,
      rpc: createRetryingRpc(server.rpcUrl),
      jupiter: createJupiterClient({
        buildUrl: 'https://api.jup.ag/swap/v2/build',
        tokensUrl: 'https://api.jup.ag/tokens/v2/search',
        labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label',
        apiKey: server.jupiterApiKey ?? undefined,
      }),
    };
  }
  const perMinute = Number(process.env.BOUND_API_PER_MINUTE);
  return {
    rpc: clients.rpc,
    jupiter: clients.jupiter,
    secrets: previous ? [current, previous] : [current],
    keys,
    // The verifier refuses anything above 1% whatever is configured here.
    feeBps: feeBps <= 100n ? feeBps : 20n,
    treasury: isAddress(treasury) ? address(treasury) : null,
    excludeDexes: server.excludeDexes,
    maxNetworkFeeLamports: server.maxNetworkFeeLamports,
    disabled: server.disabled,
    v1: process.env.NEXT_PUBLIC_BOUND_ENABLE_V1 === '1',
    perMinute: Number.isInteger(perMinute) && perMinute > 0 ? perMinute : 60,
  };
}

export const notEnabled = () =>
  Response.json({ error: { code: 'not-enabled', message: 'The agent API is not enabled on this deployment.' } }, { status: 404 });
