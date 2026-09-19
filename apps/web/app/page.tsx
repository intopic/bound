import { connection } from 'next/server';
import { SwapApp } from '@/components/SwapApp';

export default async function Page() {
  // Rendered per request so that every response carries a fresh CSP nonce (proxy.ts).
  await connection();
  return <SwapApp />;
}
