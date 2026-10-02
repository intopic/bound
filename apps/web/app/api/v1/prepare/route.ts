import { agentPrepare } from '@/lib/server/agent/api';
import { agentDeps, notEnabled } from '@/lib/server/agent/config';
import { observed } from '@/lib/server/agent/events';

export const dynamic = 'force-dynamic';
// Building a swap can take several round trips to Jupiter and the RPC, and a repair or two.
export const maxDuration = 60;

/** Builds and verifies a protected swap for an agent (AGENT-API.md). */
export function POST(req: Request) {
  const deps = agentDeps();
  // Counted for the operator: status, error code and time (lib/server/agent/events.ts).
  return observed('prepare', async () => (deps ? agentPrepare(req, deps) : notEnabled()));
}
