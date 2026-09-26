import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader } from './Brand';

/** The pages behind the footer share one frame: the site's header, a title, a lead, the text. */
export function InfoPage(props: { eyebrow: string; title: string; lead?: ReactNode; draft?: boolean; children: ReactNode }) {
  return (
    <div className="site">
      <SiteHeader right={<a className="ghost connect" href="/#swap">Open the app</a>} />
      <main className="info-page">
        <div className="container">
          <p className="eyebrow">{props.eyebrow}</p>
          <h1>{props.title}</h1>
          {props.lead && <p className="lead">{props.lead}</p>}
          {props.draft && (
            <p className="draft-note">
              Draft: this text is under legal review and will be final before Orientim opens to the public.
            </p>
          )}
          <div className="prose">{props.children}</div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
