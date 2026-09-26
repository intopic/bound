import { agentPrepare } from '@/lib/server/agent/api';
import { agentDeps, notEnabled } from '@/lib/server/agent/config';

export const dynamic = 'force-dynamic';
// Building a swap can take several round trips to Jupiter and the RPC, and a repair or two.
export const maxDuration = 60;

/** Builds and verifies a protected swap for an agent (AGENT-API.md). */
export function POST(req: Request) {
  const deps = agentDeps();
  return deps ? agentPrepare(req, deps) : notEnabled();
}
