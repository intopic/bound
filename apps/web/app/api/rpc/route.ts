import { serverConfig } from '@/lib/server/config';
import { proxyRpc } from '@/lib/server/rpcProxy';

export const dynamic = 'force-dynamic';

export function POST(req: Request) {
  return proxyRpc(req, serverConfig().rpcUrl);
}
