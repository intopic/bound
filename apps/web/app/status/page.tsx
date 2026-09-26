import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { publicStatus } from '@/lib/server/config';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export const metadata = { title: 'Status — Orientim', description: 'Whether protected swaps are running right now.' };

export default async function Page() {
  signPageChunks('status/page');
  await connection();
  const status = publicStatus();
  const rows: [string, boolean, string, string][] = [
    ['Protected swaps', status.enabled, 'Running', 'Paused: no new swaps start. Your funds are not affected.'],
    // A key being set says the service is configured, not that it is answering.
    ['Price service', status.jupiterKey, 'Configured', 'Not configured: prices may be slow or refused'],
  ];
  return (
    <InfoPage eyebrow="Status" title={status.enabled ? 'Protected swaps are running' : 'Protected swaps are paused'} lead="Read from this deployment when the page loads: whether new swaps are allowed, and how it is configured. Continuous monitoring comes with the public launch.">
      <section>
        {rows.map(([name, ok, good, bad]) => (
          <div key={name} className="status-row">
            <span>{name}</span>
            <span className={ok ? 'status-ok' : 'status-bad'}>{ok ? good : bad}</span>
          </div>
        ))}
        <p>
          When something is wrong, Orientim stops new swaps on its server first: a page left open cannot go around it. A swap
          already sent is settled by the network, not by Orientim.
        </p>
      </section>
    </InfoPage>
  );
}
