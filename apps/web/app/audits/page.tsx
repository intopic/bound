import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export const metadata = { title: 'Audits — Orientim', description: 'The reviews of Orientim, what they found and what was fixed.' };


/** The kind of each review is part of what it is worth: none of these is a professional firm's audit. */
const REVIEWS: [string, string, string, string][] = [
  ['19 Sep 2026', 'First review and a whole-repository review', 'Independent AI review', 'B-01 to B-12 and C-01 to C-10: fee and limits held by the verifier, decimals read from the chain, the send outcome said only when proven'],
  ['23 Sep 2026', 'v1 review', 'Independent AI review', 'BR-01 to BR-16: per-route tolerance, duplicate accounts, costs shown before the wallet opens, a release digest'],
  ['23 Sep 2026', 'Full audit, research first', 'Independent AI review', 'FA-01 to FA-16, including the Pump.fun account rent returned to the wallet'],
  ['23 Sep 2026', 'Research and compatibility audit', 'Independent AI review', 'F-01 to F-15: Token-2022, issuer stablecoins, wallets'],
  ['24 Sep 2026', 'Engineering review', 'Independent AI review', 'H-01 to L-10'],
  ['24 Sep 2026', 'Independent audit, stages 1 and 2', 'Independent AI review', 'S1-H-01 onward; nothing left under the one-time key, one swap per wallet at a time'],
  ['25 Sep 2026', 'Third audit', 'Independent AI review', 'F1 to F5: what an expired swap proves, unsettled swaps, accounts a route leaves open'],
  ['25 Sep 2026', 'Debugging pass and live tests', 'Internal review and mainnet tests', 'Settings checked at build; real swaps with Phantom, Trust Wallet and an agent, and a compromised server the agent refused'],
];

const TESTS: [string, string][] = [
  ['A malicious swap program', 'A real attacker program in the swap program’s place, run against classic and Token-2022 tokens in a Solana virtual machine: it can take nothing beyond the approved amount'],
  ['Property and fuzz tests', 'Tens of thousands of generated transactions: honest ones pass, every altered one is refused'],
  ['Mainnet state', 'Routes across 30 pairs, large amounts, stablecoins, Token-2022 and Pump.fun, built, verified and executed in simulation'],
  ['The browser', 'The whole page in a real browser: nonce-based CSP, script integrity, nothing sent without a valid wallet signature'],
];

export default async function Page() {
  signPageChunks('audits/page');
  await connection();
  return (
    <InfoPage eyebrow="Audits" title="Reviews and how Orientim is tested" lead="Every review of Orientim, what kind of review it was, and what it covered.">
      <section>
        <h2>Reviews</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Review</th><th>Kind</th><th>What it covered</th></tr></thead>
            <tbody>{REVIEWS.map(([date, name, kind, what]) => <tr key={name}><td>{date}</td><td>{name}</td><td>{kind}</td><td>{what}</td></tr>)}</tbody>
          </table>
        </div>
        <p>
          Every finding is recorded with its status and the validation for its fix in Orientim&apos;s audit log. Orientim has not
          yet been audited by a professional security firm; that audit comes before the public launch.
        </p>
      </section>
      <section>
        <h2>How it is tested</h2>
        <ul>{TESTS.map(([name, text]) => <li key={name}><strong>{name}</strong>: {text}.</li>)}</ul>
      </section>
    </InfoPage>
  );
}
