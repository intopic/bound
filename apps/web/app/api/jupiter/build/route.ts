import { proxyBuild } from '@/lib/server/jupiterProxy';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  return proxyBuild(req);
}
