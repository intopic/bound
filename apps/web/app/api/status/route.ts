import { publicStatus } from '@/lib/server/config';

export const dynamic = 'force-dynamic';

/** Public configuration and the kill switch (ORIENTIM_DISABLED=1 stops new swaps immediately). */
export function GET() {
  return Response.json(publicStatus(), { headers: { 'cache-control': 'no-store' } });
}
