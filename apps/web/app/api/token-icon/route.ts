import { proxyIcon } from '@/lib/server/iconProxy';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  return proxyIcon(req);
}
