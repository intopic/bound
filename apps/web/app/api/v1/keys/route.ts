import { keyIssue } from '@/lib/server/agent/access';
import { accessDeps, notEnabled } from '@/lib/server/agent/config';

export const dynamic = 'force-dynamic';

/** A key bound to the wallet that signed the challenge (AGENT-API.md, "API access"). */
export function POST(req: Request) {
  const deps = accessDeps();
  return deps ? keyIssue(req, deps) : notEnabled();
}
