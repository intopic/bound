import { serverConfig } from '@/lib/server/config';
import { proxyRpc } from '@/lib/server/rpcProxy';

export const dynamic = 'force-dynamic';
// The relay waits upstream at most 25 s, the main RPC and the backup together (RELAY_TIMES).
export const maxDuration = 30;

export function POST(req: Request) {
  const { rpcUrl, rpcFallbackUrl } = serverConfig();
  return proxyRpc(req, rpcUrl, rpcFallbackUrl);
}
