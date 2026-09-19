import { readBodyLimited, UPSTREAM_TIMEOUT_MS } from './body';
import { serverConfig } from './config';
import { clientKey, rateLimited } from './rateLimit';

/** The only RPC methods the dApp needs. Everything else is refused. */
const ALLOWED_METHODS = new Set([
  'getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getTokenAccountBalance', 'getLatestBlockhash',
  'getBlockHeight', 'simulateTransaction', 'sendTransaction', 'getSignatureStatuses', 'getFeeForMessage',
  'getMinimumBalanceForRentExemption',
]);
/** The second RPC only cross-checks address lookup tables. */
export const LOOKUP_METHODS = new Set(['getMultipleAccounts', 'getAccountInfo']);
const MAX_BODY_BYTES = 64 * 1024;
const LIMIT_PER_MINUTE = 300;
// A swap re-broadcasts every 3 s for at most ~90 s, and a user may retry: 60 per minute leaves room
// for that while still bounding the one method that costs real money per call (B-06).
const SENDS_PER_MINUTE = 60;

const rpcError = (id: unknown, code: number, message: string, status: number) =>
  Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } });

export async function proxyRpc(req: Request, target: string | null, methods: ReadonlySet<string> = ALLOWED_METHODS): Promise<Response> {
  if (!target) return rpcError(null, -32601, 'Not configured', 404);
  const client = clientKey(req);
  if (rateLimited(`rpc:${client}`, LIMIT_PER_MINUTE)) return rpcError(null, -32005, 'Too many requests', 429);
  const text = await readBodyLimited(req, MAX_BODY_BYTES); // bytes, counted while reading (C-07)
  if (text === null) return rpcError(null, -32600, 'Request too large', 413);
  let body: { id?: unknown; method?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(body) || typeof body !== 'object' || body === null) {
    return rpcError(null, -32600, 'Batch requests are not allowed', 400);
  }
  if (typeof body.method !== 'string' || !methods.has(body.method)) {
    return rpcError(body.id, -32601, 'Method not allowed', 403);
  }
  if (body.method === 'sendTransaction') {
    // The kill switch is enforced here, not only in the UI (audit B-05). A 4xx tells the client the
    // transaction was never forwarded, so it can say that nothing moved (audit C-03).
    if (serverConfig().disabled) return rpcError(body.id, -32000, 'Protected swaps are paused', 403);
    if (rateLimited(`send:${client}`, SENDS_PER_MINUTE)) return rpcError(body.id, -32005, 'Too many requests', 429);
  }

  try {
    const upstream = await fetch(target, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: text, cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return rpcError(body.id, -32603, 'Upstream RPC did not answer', 504);
  }
}
