import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export const metadata = { title: 'Privacy — Orientim', description: 'What Orientim sees and keeps, and what it does not.' };

export default async function Page() {
  signPageChunks('privacy/page');
  await connection();
  return (
    <InfoPage eyebrow="Privacy" title="Privacy" draft lead="Orientim has no accounts and no database. It keeps as little as a swap needs, and most of it stays in your own browser.">
      <section>
        <h2>What stays in your browser</h2>
        <ul>
          <li>Your recent swaps (their signatures, amounts and wallet address), so that the page can follow their outcome.</li>
          <li>The last messages the page showed you, so that you can copy them when you ask for help.</li>
        </ul>
        <p>They never leave your browser. Clearing this site&apos;s data removes them.</p>
      </section>
      <section>
        <h2>What passes through Orientim&apos;s server</h2>
        <ul>
          <li>
            Requests to the Solana network, relayed to Orientim&apos;s RPC provider: account reads, simulations and the
            transaction you signed. These include your wallet address, as every Solana app&apos;s requests do.
          </li>
          <li>Price and route requests, relayed to Jupiter without your wallet address.</li>
          <li>Token icons, fetched by the server so that your browser never contacts the hosts token creators choose.</li>
          <li>Your IP address, used in memory to limit how often requests can be made, and in the hosting provider&apos;s logs.</li>
        </ul>
        <p>
          None of it is kept: Orientim&apos;s servers answer each request and keep no record of it. Orientim does not use cookies,
          analytics or advertising trackers.
        </p>
      </section>
      <section id="developers">
        <h2>Developers, agents and bots</h2>
        <ul>
          <li>
            To issue an API key, Orientim checks the message your wallet signed and reads the wallet&apos;s SOL balance. It keeps
            neither. The key itself carries its wallet address and its expiry, sealed so that only Orientim can verify it:
            Orientim keeps no list of keys.
          </li>
          <li>
            An agent&apos;s requests carry its wallet address, the tokens and the amount, as any swap does. They are used to build
            the swap and are not kept.
          </li>
          <li>Your agent or bot keeps its own records, on its own machine.</li>
        </ul>
      </section>
      <section>
        <h2>What is public by nature</h2>
        <p>Every Solana transaction, including your swaps, is public on the blockchain and can be read by anyone.</p>
      </section>
      <section>
        <h2>Changes and contact</h2>
        <p>This notice may change; the date of the current version will be shown here. A contact address will be added before launch.</p>
      </section>
    </InfoPage>
  );
}
