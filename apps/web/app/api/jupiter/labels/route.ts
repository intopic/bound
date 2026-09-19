import { UPSTREAM_TIMEOUT_MS } from '@/lib/server/body';
import { serverConfig } from '@/lib/server/config';

export const dynamic = 'force-dynamic';

let cache: { body: string; expires: number } | null = null;

/** Program id → DEX label, used to name the DEX to exclude when a route fails in simulation. */
export async function GET() {
  if (!cache || cache.expires < Date.now()) {
    const { jupiterApiKey } = serverConfig();
    const upstream = await fetch('https://api.jup.ag/swap/v2/program-id-to-label', {
      headers: jupiterApiKey ? { 'x-api-key': jupiterApiKey } : {},
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    }).catch(() => null);
    if (!upstream) return Response.json({}, { status: 504 });
    if (!upstream.ok) return Response.json({}, { status: 502 });
    cache = { body: await upstream.text(), expires: Date.now() + 3_600_000 };
  }
  return new Response(cache.body, {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
  });
}
