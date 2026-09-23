import { agentFinalize } from '@/lib/server/agent/api';
import { agentDeps, notEnabled } from '@/lib/server/agent/config';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Signs as E the exact message prepare built, once W has signed it, and sends it once. */
export function POST(req: Request) {
  const deps = agentDeps();
  return deps ? agentFinalize(req, deps) : notEnabled();
}
