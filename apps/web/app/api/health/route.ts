import { checkHealth } from '@/lib/server/health';
import { clientKey, rateLimited } from '@/lib/server/rateLimit';

export const dynamic = 'force-dynamic';

/** 200 when a swap could go through now, 503 when the RPC or Jupiter does not answer or the agent API is off. For uptime monitors. */
export async function GET(req: Request) {
  // Each call asks the RPC and Jupiter: a monitor needs one a minute at most.
  if (rateLimited(`health:${clientKey(req)}`, 30)) return Response.json({ error: 'Too many requests' }, { status: 429 });
  const health = await checkHealth();
  return Response.json(health, { status: health.ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
