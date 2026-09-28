import { connection } from 'next/server';
import { SiteFooter, SiteHeader } from '@/components/site/Brand';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export const metadata = { title: 'Page not found — Orientim', robots: { index: false, follow: false } };

/** Any address the site does not have: the site's own frame and a way back, never Next's bare page. */
export default async function NotFound() {
  signPageChunks('_not-found/page');
  // Rendered per request, like every page, so its scripts carry this response's CSP nonce (proxy.ts).
  await connection();
  // InfoPage's frame, without the phone menu: the 404's client chunks are listed by every page, and one
  // that page never loads would be preloaded there without the CSP nonce (lib/server/scriptIntegrity.ts).
  return (
    <div className="site">
      <SiteHeader right={<a className="ghost connect" href="/developers#access">Get an API key</a>} />
      <main className="info-page">
        <div className="container">
          <p className="eyebrow">404</p>
          <h1>This page does not exist</h1>
          <p className="lead">The address may be mistyped, or the page has moved.</p>
          <div className="prose">
            <div className="cta-actions">
              <a className="button primary-link" href="/">Back to the home page</a>
              <a className="button ghost-link" href="/security">How Orientim protects you</a>
            </div>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
