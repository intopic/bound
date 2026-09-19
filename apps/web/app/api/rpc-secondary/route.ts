import { serverConfig } from '@/lib/server/config';
import { LOOKUP_METHODS, proxyRpc } from '@/lib/server/rpcProxy';

export const dynamic = 'force-dynamic';

/** A second, independent RPC used only to cross-check lookup tables. */
export function POST(req: Request) {
  return proxyRpc(req, serverConfig().rpcUrlSecondary, LOOKUP_METHODS);
}
