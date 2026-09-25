import { address } from '@solana/kit';
import { createJupiterClient, MIN_FEE } from '@orientim/jupiter';
import type { JupiterClient } from '@orientim/jupiter';
import { createRetryingRpc } from '@orientim/solana';
import type { SolanaRpc } from '@orientim/solana';
import { serverConfig } from '../config';
import { treasurySetting } from '../../settings';
import type { AgentDeps } from './api';

/**
 * The agent API is off unless the deployment sets both of these (tools/agent-key.ts makes them).
 * They are read when a deployment starts: on Vercel a change needs a redeploy (review FA-02), so
 * revoking a key or pausing follows the runbook in SECURITY.md, not an edit in the dashboard.
 *
 *   ORIENTIM_API_SECRET           32 random bytes, base64: seals tickets and derives each E
 *   ORIENTIM_API_SECRET_PREVIOUS  optional, the one before it, while its tickets expire (a minute)
 *   ORIENTIM_API_KEYS             id:sha256-of-key, comma-separated; only the hashes are stored
 *   ORIENTIM_API_FEE_BPS          optional, the fee for API swaps; the page's fee otherwise
 *   ORIENTIM_API_PER_MINUTE       optional, requests per minute per key and endpoint (60)
 *   ORIENTIM_MIN_SKILL_VERSION    optional, the oldest skill prepare serves; older copies are asked to update
 */
function secretOf(value: string | undefined): Uint8Array | null {
  if (!value) return null;
  const bytes = Buffer.from(value.trim(), 'base64');
  return bytes.length >= 32 ? new Uint8Array(bytes) : null;
}

function keysOf(value: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  const ids = new Set<string>();
  for (const entry of (value ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [id, hash] = entry.split(':');
    // Two keys with one id would share tickets and limits: the first one wins (FA-16).
    if (ids.has(id)) continue;
    ids.add(id);
    if (/^[\w-]{1,40}$/.test(id ?? '') && /^[0-9a-f]{64}$/.test(hash ?? '')) keys.set(hash, id);
  }
  return keys;
}

// The clients are kept per instance. The settings are read on every request, but a host may fix the
// environment per deployment (Vercel does): see the runbook for pausing and revoking (FA-02).
let clients: { rpc: SolanaRpc; jupiter: JupiterClient; for: string } | null = null;

export function agentDeps(): AgentDeps | null {
  const current = secretOf(process.env.ORIENTIM_API_SECRET);
  const keys = keysOf(process.env.ORIENTIM_API_KEYS);
  if (!current || keys.size === 0) return null;
  const previous = secretOf(process.env.ORIENTIM_API_SECRET_PREVIOUS);
  const server = serverConfig();
  // The API may run on keys of its own, so that agents cannot use up the page's quota (FA-06).
  // Jupiter counts its limits per organisation, not per key (research audit F-10): only a key from
  // a separate Jupiter account gives the API a quota of its own.
  const rpcUrl = process.env.RPC_URL_AGENTS || server.rpcUrl;
  const jupiterApiKey = process.env.JUPITER_API_KEY_AGENTS || server.jupiterApiKey;
  const feeBps = BigInt(/^\d{1,3}$/.test(process.env.ORIENTIM_API_FEE_BPS ?? '') ? process.env.ORIENTIM_API_FEE_BPS!
    : /^\d{1,3}$/.test(process.env.NEXT_PUBLIC_ORIENTIM_FEE_BPS ?? '') ? process.env.NEXT_PUBLIC_ORIENTIM_FEE_BPS! : '30');
  // A fee the verifier would refuse is a configuration error: the API stays off, rather than charge
  // a fee nobody chose (engineering audit, Stage 1, L-01).
  if (feeBps > 100n) {
    console.error(`The agent API is off: its fee is ${feeBps} bps, above the verifier's ceiling of 100.`);
    return null;
  }
  // A treasury that is set but cannot be read would make every API swap fee-free: the API stays off.
  let treasury: string | null;
  try {
    treasury = treasurySetting(process.env.NEXT_PUBLIC_ORIENTIM_TREASURY);
  } catch (e) {
    console.error(`The agent API is off: ${(e as Error).message}`);
    return null;
  }
  const identity = `${rpcUrl}|${jupiterApiKey ?? ''}`;
  if (clients?.for !== identity) {
    clients = {
      for: identity,
      rpc: createRetryingRpc(rpcUrl),
      jupiter: createJupiterClient({
        buildUrl: 'https://api.jup.ag/swap/v2/build',
        tokensUrl: 'https://api.jup.ag/tokens/v2/search',
        labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label',
        apiKey: jupiterApiKey ?? undefined,
        timeoutMs: 15_000,
      }),
    };
  }
  const perMinute = Number(process.env.ORIENTIM_API_PER_MINUTE);
  const minSkillVersion = process.env.ORIENTIM_MIN_SKILL_VERSION?.trim() ?? '';
  return {
    rpc: clients.rpc,
    jupiter: clients.jupiter,
    secrets: previous ? [current, previous] : [current],
    keys,
    // The verifier refuses anything above 1% whatever is configured here.
    feeBps,
    treasury: treasury ? address(treasury) : null,
    excludeDexes: server.excludeDexes,
    maxNetworkFeeLamports: server.maxNetworkFeeLamports,
    disabled: server.disabled,
    v1: process.env.NEXT_PUBLIC_ORIENTIM_ENABLE_V1 === '1',
    perMinute: Number.isInteger(perMinute) && perMinute > 0 ? perMinute : 60,
    minSkillVersion: /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(minSkillVersion) ? minSkillVersion : null,
    // The smallest swap, about $1, so that no swap costs more to build than it brings.
    minFee: MIN_FEE,
  };
}

export const notEnabled = () =>
  Response.json({ error: { code: 'not-enabled', message: 'The agent API is not enabled on this deployment.' } }, { status: 404 });
