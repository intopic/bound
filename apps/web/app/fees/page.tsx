import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { FEE_BPS, TREASURY } from '@/lib/client/config';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

const feeText = `${(Number(FEE_BPS) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

export const metadata = { title: 'Fees — Orientim', description: 'Every cost of a protected swap, and who receives it.' };

export default async function Page() {
  signPageChunks('fees/page');
  await connection();
  return (
    <InfoPage eyebrow="Fees" title="Every cost, before you sign" lead="The swap page shows each of these before your wallet opens, and the exact amounts while it is open.">
      <section>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Cost</th><th>Amount</th><th>Who receives it</th></tr></thead>
            <tbody>
              <tr><td>Orientim fee</td><td>{TREASURY ? `${feeText} of the swap` : 'None on this deployment'}</td><td>Orientim. Inside the transaction you sign: in SOL, USDC or USDT when the swap has one of them, otherwise in the input token or in SOL from your wallet.</td></tr>
              <tr><td>Network fee</td><td>Usually ~0.00002 SOL, never more than 0.001 SOL</td><td>Solana&apos;s validators. The exact amount is shown before you sign.</td></tr>
              <tr><td>Market account fee</td><td>Only on some markets, such as a Pump.fun launch curve</td><td>The market. Shown and asked about before your wallet opens.</td></tr>
              <tr><td>Token transfer tax</td><td>Only on tokens that tax transfers</td><td>The token&apos;s issuer. Stated before your wallet opens.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h2>What is never charged</h2>
        <ul>
          <li>No fee to connect, to get a price or to cancel.</li>
          <li>A swap that does not run, because less than the minimum would arrive or its time ran out, costs at most the network fee.</li>
          <li>Swaps smaller than $1 are not offered: the costs would be larger than the swap.</li>
        </ul>
      </section>
    </InfoPage>
  );
}
