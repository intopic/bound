import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export const metadata = { title: 'Supported tokens and wallets — Orientim', description: 'Which tokens, markets and wallets a protected swap works with.' };

const ROWS: [string, string][] = [
  ['SOL and standard SPL tokens', 'Supported'],
  ['Token-2022 tokens with metadata, groups, close authority or confidential transfers', 'Supported'],
  ['Token-2022 tokens with a transfer tax', 'Supported; the tax is stated before your wallet opens'],
  ['Stablecoins whose issuer holds a permanent delegate (PYUSD, USDG, AUSD, CASH)', 'Supported, with a warning'],
  ['Pump.fun tokens, on the launch curve and on PumpSwap', 'Supported'],
  ['Tokens with an active transfer hook, frozen by default, pausable, non-transferable or interest-bearing', 'Refused, with the reason: Orientim cannot isolate them'],
  ['Markets that open an account and leave it open', 'Refused: the deposit would be lost'],
  ['Routes too large for one transaction', 'Refused: Orientim never splits a swap'],
];

export default async function Page() {
  signPageChunks('supported/page');
  await connection();
  return (
    <InfoPage eyebrow="Supported" title="Tokens, markets and wallets" lead="Orientim works with any token pair Jupiter can route and Orientim can safely isolate. Paste any token's address in the token window to check it: a token Orientim cannot swap safely is marked, and the page says why.">
      <section>
        <h2>Tokens and markets</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Kind</th><th>Answer</th></tr></thead>
            <tbody>{ROWS.map(([kind, answer]) => <tr key={kind}><td>{kind}</td><td>{answer}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
      <section>
        <h2>Wallets</h2>
        <ul>
          <li><strong>Browser wallets that sign and hand the transaction back</strong>, such as Phantom, Solflare, Backpack and Trust Wallet&apos;s extension: supported. Tested on mainnet with Phantom and Trust Wallet.</li>
          <li><strong>On a phone</strong>: open orientim.com inside your wallet&apos;s browser.</li>
          <li><strong>Wallets that can only sign and send at once, and multisig vaults</strong>: not supported, because your wallet must sign first and Orientim last.</li>
        </ul>
      </section>
    </InfoPage>
  );
}
