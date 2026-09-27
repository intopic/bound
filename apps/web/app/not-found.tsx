import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export const metadata = { title: 'Page not found — Orientim', robots: { index: false, follow: false } };

/** Any address the site does not have: the site's own frame and a way back, never Next's bare page. */
export default async function NotFound() {
  signPageChunks('_not-found/page');
  // Rendered per request, like every page, so its scripts carry this response's CSP nonce (proxy.ts).
  await connection();
  return (
    <InfoPage eyebrow="404" title="This page does not exist" lead="The address may be mistyped, or the page has moved.">
      <div className="cta-actions">
        <a className="button primary-link" href="/#swap">Back to swap</a>
        <a className="button ghost-link" href="/security">How Orientim protects you</a>
      </div>
    </InfoPage>
  );
}
