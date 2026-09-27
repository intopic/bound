import { serverConfig } from './config';

export type Check = { ok: boolean; ms: number };
export type Health = {
  ok: boolean;
  /** The kill switch is on: swaps are paused on purpose, which is not an outage. */
  paused: boolean;
  rpc: Check;
  /** The backup RPC (RPC_URL_FALLBACK), null when none is set. */
  rpcFallback: Check | null;
  jupiter: Check;
};

const TIMEOUT_MS = 5_000;

async function timed(request: () => Promise<Response>, answered: (r: Response) => Promise<boolean>): Promise<Check> {
  const started = Date.now();
  try {
    const res = await request();
    return { ok: res.ok && (await answered(res)), ms: Date.now() - started };
  } catch {
    return { ok: false, ms: Date.now() - started };
  }
}

const rpcCheck = (url: string, fetchImpl: typeof fetch) =>
  timed(
    () => fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBlockHeight' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
    async r => typeof ((await r.json()) as { result?: unknown })?.result === 'number',
  );

/**
 * Whether a swap could go through right now: the RPC answers, and Jupiter answers with Orientim's
 * key. For an uptime monitor (every few minutes); it names no URL and no key. Swaps paused by the
 * kill switch are reported, not counted as down.
 */
export async function checkHealth(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<Health> {
  const { rpcUrl, rpcFallbackUrl, jupiterApiKey, disabled } = serverConfig();
  const [rpc, rpcFallback, jupiter] = await Promise.all([
    rpcCheck(rpcUrl, fetchImpl),
    rpcFallbackUrl ? rpcCheck(rpcFallbackUrl, fetchImpl) : Promise.resolve(null),
    timed(
      () => fetchImpl('https://api.jup.ag/tokens/v2/search?query=So11111111111111111111111111111111111111112', {
        headers: jupiterApiKey ? { 'x-api-key': jupiterApiKey } : {}, cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      async r => Array.isArray(await r.json()),
    ),
  ]);
  // With a backup, the RPC side is up while either of them answers.
  const rpcUp = rpc.ok || rpcFallback?.ok === true;
  return { ok: rpcUp && jupiter.ok, paused: disabled, rpc, rpcFallback, jupiter };
}
