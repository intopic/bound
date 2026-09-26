import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export const metadata = { title: 'Terms — Orientim', description: 'The terms for using Orientim, and the risks that remain.' };

const RISKS: [string, string][] = [
  ['Price and token value', 'Tokens can lose their value at any time, and new tokens often do. Orientim guarantees the minimum you accepted for this swap, not what the token is worth afterwards.'],
  ['What a token’s issuer can do', 'Some issuers can freeze balances, mint more, or move tokens. Orientim warns before the swap; it cannot change the token.'],
  ['Third-party programs and markets', 'Jupiter and the markets it routes through are run by others. Orientim limits what they can reach to the approved amount, but cannot fix a flaw inside them.'],
  ['The network', 'A swap can be delayed, expire or be cancelled. One that does not execute moves nothing but may still cost its network fee.'],
  ['An outcome not yet known', 'While the network has not yet confirmed a swap, it may still land. Orientim starts no new swap from the same wallet until it does.'],
  ['Your wallet and device', 'Orientim cannot protect a wallet whose seed phrase or device is compromised. Never share your seed phrase, and keep large amounts on a hardware wallet.'],
  ['Impostor sites', 'Open Orientim only at orientim.com. A copy elsewhere is not Orientim.'],
  ['Law and taxes', 'Rules on digital assets differ by country and change. You are responsible for following those that apply to you.'],
];

export default async function Page() {
  signPageChunks('terms/page');
  await connection();
  return (
    <InfoPage eyebrow="Terms" title="Terms of use" draft lead="By using Orientim you agree to these terms, including the risks set out below.">
      <section>
        <h2>What Orientim is</h2>
        <p>
          Orientim is a protection layer for Solana swaps. It is not an exchange, a broker or a market: it does not set prices,
          match orders or hold funds. It builds each swap and checks it before your wallet signs, so that the route can use only
          the amount you approve and never your wallet. Swaps are executed by Solana and by third-party markets routed through
          Jupiter, which Orientim does not control.
        </p>
        <p>
          Orientim is non-custodial. It never holds your funds or your keys, and every transaction runs only when your wallet
          signs it.
        </p>
      </section>
      <section>
        <h2>What Orientim keeps</h2>
        <p>
          Nothing. Orientim has no accounts and no database, and its servers keep no record of your swaps, your wallet or your
          keys. Your recent swaps are kept in your own browser, so that the page can follow their outcome. The privacy notice
          says what passes through Orientim&apos;s servers.
        </p>
      </section>
      <section>
        <h2>Your responsibilities</h2>
        <ul>
          <li>You are responsible for your wallet, its keys and its device. Orientim never asks for your seed phrase.</li>
          <li>Use Orientim only at orientim.com, and check what your wallet shows before you sign.</li>
          <li>You decide what to buy. Orientim gives no investment, financial, legal or tax advice.</li>
          <li>You use Orientim lawfully, and not from a place or as a person where its use is prohibited.</li>
        </ul>
      </section>
      <section id="developers">
        <h2>Developers, agents and bots</h2>
        <ul>
          <li>An API key is bound to the wallet that signed for it and works for that wallet only. It expires after 90 days, and Orientim may revoke it.</li>
          <li>
            You are responsible for your agent or bot: its decisions and limits, where it keeps its keys and its records, and running
            Orientim&apos;s checks on your own RPC before it signs. An integration that skips those checks relies on Orientim&apos;s
            answer alone.
          </li>
          <li>Rate limits apply. A key used to overload or attack the service is revoked.</li>
        </ul>
      </section>
      <section>
        <h2>Fees</h2>
        <p>
          Orientim&apos;s fee and every other cost are shown before you sign and are part of the transaction you approve. See{' '}
          <a href="/security#fees">fees</a>.
        </p>
      </section>
      <section id="risks">
        <h2>Risks</h2>
        <p>Orientim removes one risk: that a swap takes more of your wallet than you approved. These remain.</p>
        <ul>{RISKS.map(([name, text]) => <li key={name}><strong>{name}.</strong> {text}</li>)}</ul>
      </section>
      <section>
        <h2>No guarantee of price, value or availability</h2>
        <p>
          Orientim protects your wallet&apos;s authority during a swap. It does not guarantee the price or the value of any token,
          that a swap will be available, or that a transaction will be included by the network. Orientim may pause new swaps at
          any time. The software is provided as it is, to the extent the law allows.
        </p>
      </section>
      <section>
        <h2>Limitation of liability</h2>
        <p>
          To the extent the law allows, Orientim is not liable for losses from market prices, tokens, third-party programs and
          markets, the Solana network, your wallet or device, or your own decisions.
        </p>
      </section>
      <section>
        <h2>Changes</h2>
        <p>These terms may change; the date of the current version will be shown here. The governing law and a contact address will be added before launch.</p>
      </section>
    </InfoPage>
  );
}
