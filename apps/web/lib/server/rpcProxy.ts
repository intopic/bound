import { readBodyLimited, UPSTREAM_TIMEOUT_MS } from './body';
import { notOrientimShaped } from './orientimShape';
import { serverConfig } from './config';
import { clientKey, fromAnotherSite, rateLimited } from './rateLimit';

/** The only RPC methods the dApp needs. Everything else is refused. */
const ALLOWED_METHODS = new Set([
  'getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getTokenAccountBalance', 'getLatestBlockhash',
  'getBlockHeight', 'getEpochInfo', 'simulateTransaction', 'sendTransaction', 'getSignatureStatuses', 'getFeeForMessage',
  'getMinimumBalanceForRentExemption', 'getTransaction', 'getRecentPrioritizationFees',
  // Helius's priority estimate (heliusPriorityFee); another provider answers "method not found".
  'getPriorityFeeEstimate',
]);
const MAX_BODY_BYTES = 64 * 1024;
const LIMIT_PER_MINUTE = 300;
// A swap re-broadcasts every 3 s for at most ~90 s, and a user may retry: 60 per minute leaves room
// for that while still bounding the one method that costs real money per call.
const SENDS_PER_MINUTE = 60;

const rpcError = (id: unknown, code: number, message: string, status: number, notForwarded = true) =>
  Response.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
    {
      status,
      headers: {
        'cache-control': 'no-store',
        // The sender may say "not broadcast" only when this proxy stopped the request locally.
        ...(notForwarded ? { 'x-orientim-not-forwarded': '1' } : {}),
      },
    },
  );

/** An upstream that failed this way may be having an outage, and the backup RPC is asked instead. */
const outage = (status: number) => status === 429 || status >= 500;

/**
 * How long the relay waits upstream: each RPC at most `attemptMs`, both together at most `totalMs`,
 * within the route's maxDuration (app/api/rpc/route.ts). A send is not started on the backup with
 * less than `minSendMs` left.
 */
export type RelayTimes = { totalMs: number; attemptMs: number; minSendMs: number };
export const RELAY_TIMES: RelayTimes = { totalMs: 25_000, attemptMs: UPSTREAM_TIMEOUT_MS, minSendMs: 5_000 };

type Upstream = { status: number; text: string } | null;

async function ask(url: string, text: string, timeoutMs: number): Promise<Upstream> {
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: text, cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, text: await res.text() };
  } catch {
    return null;
  }
}

/** A JSON-RPC answer that carries a result: for a send, the signature, the same whichever RPC sent it. */
function succeeded(answer: Upstream): boolean {
  if (!answer || answer.status !== 200) return false;
  try {
    const body = JSON.parse(answer.text);
    return body !== null && typeof body === 'object' && 'result' in body && !('error' in body);
  } catch {
    return false;
  }
}

/**
 * `fallback` is the operator's backup RPC (RPC_URL_FALLBACK), asked only when the main one does not
 * answer, is rate-limited or fails (5xx), and only with the time the main one left. A read takes the
 * backup's answer unless it is itself rate-limited or failing, when the main one's stands (a backup
 * answer still beats none). A send takes it only when it is a success: the same signed bytes can land
 * once however many RPCs relay them, but a refusal from the backup (a node behind, a blockhash it has
 * not seen) says nothing about what the main RPC may already have broadcast, so the page is then given
 * the main RPC's answer.
 */
export async function proxyRpc(req: Request, target: string | null, fallback: string | null = null, times: RelayTimes = RELAY_TIMES): Promise<Response> {
  if (!target) return rpcError(null, -32601, 'Not configured', 404);
  if (fromAnotherSite(req)) return rpcError(null, -32600, "Orientim's RPC serves Orientim's own page", 403);
  const client = clientKey(req);
  if (rateLimited(`rpc:${client}`, LIMIT_PER_MINUTE)) return rpcError(null, -32005, 'Too many requests', 429);
  const text = await readBodyLimited(req, MAX_BODY_BYTES); // bytes, counted while reading
  if (text === null) return rpcError(null, -32600, 'Request too large', 413);
  let body: { id?: unknown; method?: unknown; params?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(body) || typeof body !== 'object' || body === null) {
    return rpcError(null, -32600, 'Batch requests are not allowed', 400);
  }
  if (typeof body.method !== 'string' || !ALLOWED_METHODS.has(body.method)) {
    return rpcError(body.id, -32601, 'Method not allowed', 403);
  }
  if (body.method === 'sendTransaction') {
    // The kill switch is enforced here, not only in the UI. Local refusals carry an
    // explicit marker, so an upstream 4xx can never be mistaken for proof that nothing was sent.
    if (serverConfig().disabled) return rpcError(body.id, -32000, 'Protected swaps are paused', 403);
    if (rateLimited(`send:${client}`, SENDS_PER_MINUTE)) return rpcError(body.id, -32005, 'Too many requests', 429);
  }
  // After the kill switch and the send limit: only Orientim's own transactions are sent or simulated
  // through Orientim's RPC account. A local refusal: nothing was forwarded, so the
  // sender may say "never broadcast".
  if (body.method === 'sendTransaction' || body.method === 'simulateTransaction') {
    const params = Array.isArray(body.params) ? body.params : [];
    const options = (params[1] ?? {}) as { encoding?: unknown };
    const why = options.encoding === 'base64' ? notOrientimShaped(params[0]) : 'only base64 transactions are relayed';
    if (why) return rpcError(body.id, -32602, `Only Orientim transactions are relayed: ${why}`, 422);
  }

  const deadline = Date.now() + times.totalMs;
  let answer = await ask(target, text, Math.min(times.attemptMs, times.totalMs));
  const left = deadline - Date.now();
  const send = body.method === 'sendTransaction';
  if (fallback && fallback !== target && (!answer || outage(answer.status)) && left > (send ? times.minSendMs : 0)) {
    const backup = await ask(fallback, text, Math.min(times.attemptMs, left));
    if (send ? succeeded(backup) : backup && (!answer || !outage(backup.status))) answer = backup;
  }
  // The request may have reached the RPC before the connection failed, so this is not proof that a
  // send was stopped before broadcast.
  if (!answer) return rpcError(body.id, -32603, 'Upstream RPC did not answer', 504, false);
  return new Response(answer.text, {
    status: answer.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
