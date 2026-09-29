import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { publicStatus } from '@/lib/server/config';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export const metadata = { title: 'Status — Orientim', description: 'Whether protected swaps are running right now.' };

export default async function Page() {
  signPageChunks('status/page');
  await connection();
  const { enabled } = publicStatus();
  return (
    <InfoPage eyebrow="Status" title={enabled ? 'Protected swaps are running' : 'Protected swaps are paused'} lead="Whether new protected swaps can start right now.">
      <section>
        <div className="status-row">
          <span>Protected swaps</span>
          <span className={enabled ? 'status-ok' : 'status-bad'}>{enabled ? 'Running' : 'Paused: no new swaps start. Your funds are not affected.'}</span>
        </div>
        <p>
          When something is wrong, Orientim stops new swaps first: the agent API prepares and signs nothing while paused. A swap already
          sent is settled by the Solana network.
        </p>
      </section>
    </InfoPage>
  );
}
