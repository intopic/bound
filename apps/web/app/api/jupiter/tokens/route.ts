import { UPSTREAM_TIMEOUT_MS } from '@/lib/server/body';
import { serverConfig } from '@/lib/server/config';
import { clientKey, rateLimited } from '@/lib/server/rateLimit';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (rateLimited(`tokens:${clientKey(req)}`, 120)) return Response.json({ error: 'Too many requests' }, { status: 429 });
  const query = new URL(req.url).searchParams.get('query')?.trim() ?? '';
  if (!query || query.length > 2000) return Response.json({ error: 'Invalid query' }, { status: 400 });
  const { jupiterApiKey } = serverConfig();
  const base = jupiterApiKey ? 'https://api.jup.ag/tokens/v2/search' : 'https://lite-api.jup.ag/tokens/v2/search';
  try {
    const upstream = await fetch(`${base}?${new URLSearchParams({ query })}`, {
      headers: jupiterApiKey ? { 'x-api-key': jupiterApiKey } : {},
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' },
    });
  } catch {
    return Response.json({ error: 'Jupiter did not answer' }, { status: 504 });
  }
}
