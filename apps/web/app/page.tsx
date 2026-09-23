import { connection } from 'next/server';
import { SwapApp } from '@/components/SwapApp';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export default async function Page() {
  signPageChunks('page');
  // Rendered per request so that every response carries a fresh CSP nonce (proxy.ts).
  await connection();
  return <SwapApp />;
}
