import { agentFinalize } from '@/lib/server/agent/api';
import { agentDeps, notEnabled } from '@/lib/server/agent/config';
import { observed } from '@/lib/server/agent/events';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Signs as E the exact message prepare built, once W has signed it, and sends it once. */
export function POST(req: Request) {
  const deps = agentDeps();
  // Counted for the operator: status, error code and time (lib/server/agent/events.ts).
  return observed('finalize', async () => (deps ? agentFinalize(req, deps) : notEnabled()));
}
