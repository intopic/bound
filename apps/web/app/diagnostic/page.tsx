import { connection } from 'next/server';
import { Diagnostic } from '@/components/Diagnostic';

export const metadata = { title: 'Bound — wallet signing diagnostic', robots: { index: false, follow: false } };

export default async function Page() {
  // Rendered per request so that every response carries a fresh CSP nonce (proxy.ts).
  await connection();
  return <Diagnostic />;
}
