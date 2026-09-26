import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export const metadata = {
  title: 'Proof — Orientim',
  description: 'Protected swaps made on Solana mainnet with real wallets and a real agent, and every review of Orientim.',
};

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
  ['26 Sep 2026', 'Independent audit of agent integrations, keys and settings', 'Independent AI review', 'ORI-01 to ORI-18: a sent swap always reported, one swap per wallet across processes, tolerance capped by the owner'],
];

const TESTS: [string, string][] = [
  ['A malicious swap program', 'A real attacker program in the swap program’s place, run against classic and Token-2022 tokens in a Solana virtual machine: it can take nothing beyond the approved amount'],
  ['Property and fuzz tests', 'Hundreds of thousands of generated transactions: honest ones pass, every altered one is refused'],
  ['Mainnet state', 'Routes across 30 pairs, large amounts, stablecoins, Token-2022 and Pump.fun, built, verified and executed in simulation'],
  ['The browser', 'The whole page in a real browser: nonce-based CSP, script integrity, nothing sent without a valid wallet signature'],
];

const solscan = (sig: string) => `https://solscan.io/tx/${sig}`;
const short = (sig: string) => `${sig.slice(0, 6)}…${sig.slice(-4)}`;

/** Every row is a confirmed mainnet transaction, read back from the chain (docs/AUDIT.md 0zg and 0zk). */
const GROUPS: { title: string; lead: string; rows: [string, string, string][] }[] = [
  {
    title: 'From the page, with Phantom',
    lead: 'Phantom returned the transaction byte for byte, adding only its signature.',
    rows: [
      ['0.03 SOL → 3.576 USDC', 'A classic token', '454VKZ5K9gLGggCrJ1CR7XDAgwxa3Jqn93E47644WcBEyeWuyaBdLs3Lcm3QMP7VmA1cv2pmoYwVU5g9MS7tgVNC'],
      ['3.576 USDC → 975,000 BONK', 'A memecoin, a new token account', '4aU956dKoK9CzsmZHxB7M6KxZkcEtLv9Fpnmdeyk2VuMpnxaWgTsYcD3PckAkahY6b5NUhyCcwnahDWGgMppjMpr'],
      ['0.01 SOL → 35,361.8 Ecat', 'Token-2022, on the Pump.fun launch curve', '4Nhi3HVTXQFMgRnZHZK6wmuMYFFUnhmQLywbyUpX9YwVRCvtVhGyGVbZeabty3f453NLXxdXZNHsi7DdJxuFb2JS'],
      ['35,361.8 Ecat → 0.00986 SOL', 'Selling on the curve, SOL as the output', '2TexpajG613sFmf67sos3a27Pb3PQhcP3yy6eX2MtnSbCd6qB11wKJ47mvM1CMJVfFn9HqvGQ46vsiyLYo5ryej3'],
    ],
  },
  {
    title: 'From the page, with Trust Wallet',
    lead: 'A second wallet, which shows the transaction’s steps instead of its amounts.',
    rows: [
      ['0.01 SOL → 1.2058 USDC', 'Trust Wallet’s browser extension', '2FgKk4GiqFeMhvPQs2MdYjBGSeqpLZReXFRENzikdb2XDTuvCsd5uRM1rB14PUmDQvkbNai9kLt1kdtWiwmR2uS'],
    ],
  },
  {
    title: 'By an agent, with no person and no wallet app',
    lead: 'The skill’s example agent prepared, verified on its own RPC, signed, finalized and confirmed each swap itself.',
    rows: [
      ['0.01 SOL → 1.222039 USDC', 'A classic token', '4iTJkZXKf5MJpZXJ9biVcgCyJuH9WSqGHnsCB3XMHdoA28vKSuXj37o8vfu9k1kYS5ePjxVz8caEAn1UJCGsYoTM'],
      ['1.222039 USDC → 0.00996 SOL', 'SOL as the output', '2RmL9qN93nHCnkC1z6xATASwt15NVCMBRczP9a6GfVEhQACEG6QzbxmyqCbMBP2g1Ut7ocC2tseavhzTt6vRf88g'],
      ['0.01 SOL → 337,152 AI', 'Token-2022 on the Pump.fun launch curve; the market’s account returned in the same swap', '4oGqF2g42ESsjZJyEPf4M1iBD7ri9yLcTCRqhpSz3ryjphwzjq6zFFhQ7ZjU6AarLAUnTPzMYAL9hHhvJZmsubzK'],
      ['337,152 AI → 0.00964 SOL', 'Selling on the curve', '5fu9yHXQxJUnxoq9ZyPP9seTtHsHwV5z4YEtKENkzKbDx3DkvkzQeG7zNcUERPuPNkNgpVeHLr9Hp9RAcd9TkgfN'],
    ],
  },
];

export default async function Page() {
  signPageChunks('proof/page');
  await connection();
  return (
    <InfoPage
      eyebrow="Proof"
      title="Tested live on Solana mainnet, and reviewed"
      lead="Every protected swap below ran with real funds and is public on the chain. Open any of them on Solscan: two signers, your wallet and a one-time key, and nothing left under that key afterwards."
    >
      {GROUPS.map(g => (
        <section key={g.title}>
          <h2>{g.title}</h2>
          <p>{g.lead}</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Swap</th><th>What it proves</th><th>Transaction</th></tr></thead>
              <tbody>
                {g.rows.map(([swap, what, sig]) => (
                  <tr key={sig}><td>{swap}</td><td>{what}</td><td><a href={solscan(sig)} target="_blank" rel="noreferrer"><code>{short(sig)}</code></a></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <section>
        <h2>An attack the agent refused</h2>
        <p>
          A server placed between the agent and Orientim changed the prepared swap six ways: the fee sent to another wallet, with
          and without restating the message&apos;s hash and the policy; a fee of 1% instead of 0.3%; a minimum far below the
          agent&apos;s own floor. The agent&apos;s check refused all six before anything was signed, and no funds moved.
        </p>
      </section>
      <section id="reviews">
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
      <section id="testing">
        <h2>How it is tested</h2>
        <ul>{TESTS.map(([name, text]) => <li key={name}><strong>{name}</strong>: {text}.</li>)}</ul>
      </section>
    </InfoPage>
  );
}
