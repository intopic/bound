import { UPSTREAM_TIMEOUT_MS } from './body';
import { serverConfig } from './config';
import { clientKey, rateLimited } from './rateLimit';

const ALLOWED = new Set([
  'inputMint', 'outputMint', 'amount', 'taker', 'slippageBps', 'maxAccounts', 'wrapAndUnwrapSol',
  'destinationTokenAccount', 'excludeDexes',
]);

/** Stateless proxy for Jupiter's /build: fixed upstream, allowlisted parameters, key added server-side. */
export async function proxyBuild(req: Request): Promise<Response> {
  const { disabled, jupiterApiKey } = serverConfig();
  if (disabled) return Response.json({ error: 'Protected swaps are paused' }, { status: 503 }); // audit B-05
  if (rateLimited(`build:${clientKey(req)}`, 90)) return Response.json({ error: 'Too many requests' }, { status: 429 });
  const params = new URL(req.url).searchParams;
  for (const key of params.keys()) {
    // `payer` in particular is refused: with payer = W, W appeared inside the swap (D12).
    if (!ALLOWED.has(key)) return Response.json({ error: `Parameter ${key} is not allowed` }, { status: 400 });
  }
  if (params.get('wrapAndUnwrapSol') !== 'false') {
    return Response.json({ error: 'wrapAndUnwrapSol must be false' }, { status: 400 });
  }
  try {
    const upstream = await fetch(`https://api.jup.ag/swap/v2/build?${params}`, {
      headers: jupiterApiKey ? { 'x-api-key': jupiterApiKey } : {},
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    // Jupiter's Retry-After reaches the page, which waits that long instead of guessing.
    const retryAfter = upstream.headers.get('retry-after');
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(retryAfter ? { 'retry-after': retryAfter } : {}) },
    });
  } catch {
    return Response.json({ error: 'Jupiter did not answer' }, { status: 504 });
  }
}
