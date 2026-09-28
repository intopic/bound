import { connection } from 'next/server';
import { SiteFooter, SiteHeader } from '@/components/site/Brand';
import { MobileNav } from '@/components/site/MobileNav';
import { HomeSections } from '@/components/site/HomeSections';
import { HeroBlocks } from '@/components/site/HeroBlocks';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export default async function Page() {
  signPageChunks('page');
  // Rendered per request so that every response carries a fresh CSP nonce (proxy.ts).
  await connection();
  return (
    <div className="site home">
      <div className="page-grid" aria-hidden="true" />
      <HeroBlocks />
      <SiteHeader menu={<MobileNav />} right={<a className="ghost connect" href="/developers#access">Get an API key</a>} />
      <main>
        <HomeSections />
      </main>
      <SiteFooter />
    </div>
  );
}
