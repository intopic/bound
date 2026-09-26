import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Diagnostic } from '@/components/Diagnostic';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export const metadata = { title: 'Orientim — wallet signing diagnostic', robots: { index: false, follow: false } };

/** A tool for testing wallets, served only where ORIENTIM_DIAGNOSTIC=1: never on the public site. */
export default async function Page() {
  // Rendered per request so that every response carries a fresh CSP nonce (proxy.ts).
  await connection();
  if (process.env.ORIENTIM_DIAGNOSTIC !== '1') notFound();
  signPageChunks('diagnostic/page');
  return <Diagnostic />;
}
