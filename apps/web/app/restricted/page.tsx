import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { LEGAL } from '@/lib/legal';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export const metadata = { title: 'Restricted territories — Orientim', description: 'Where Orientim is not offered.' };

/** The list the Terms (section 2) refer to, kept apart so it can change without changing the Terms. */
export default async function Page() {
  signPageChunks('restricted/page');
  await connection();
  return (
    <InfoPage
      eyebrow="Terms"
      title="Restricted territories"
      updated={LEGAL.lastUpdated}
      lead="Orientim is not offered to anyone located, organised or resident in these territories, or to any person under sanctions."
    >
      <section>
        <ul>{LEGAL.restricted.map(t => <li key={t}>{t}</li>)}</ul>
        <p>
          The same applies to any other country or territory subject to comprehensive sanctions of the United Nations, the European
          Union, the United Kingdom or the United States. This list may change; see the <a href="/terms#eligibility">Terms</a>, section 2.
        </p>
      </section>
    </InfoPage>
  );
}
