import { receiveReport } from '@/lib/server/report';

export const dynamic = 'force-dynamic';

export function POST(req: Request) {
  return receiveReport(req);
}
