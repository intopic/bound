import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export const metadata = { title: 'Terms — Orientim', description: 'The terms for using Orientim.' };

export default async function Page() {
  signPageChunks('terms/page');
  await connection();
  return (
    <InfoPage eyebrow="Terms" title="Terms of use" draft lead="By using Orientim you agree to these terms. Please read them with the risks page.">
      <section>
        <h2>What Orientim is</h2>
        <p>
          Orientim is software that builds and checks Solana swap transactions so that the swap program can use only the amount
          you approve. It is non-custodial: Orientim never holds your funds or your keys, and every transaction runs only
          when your wallet signs it. Swaps are executed by Solana and by third-party markets routed through Jupiter, which
          Orientim does not control.
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
      <section>
        <h2>Fees</h2>
        <p>Orientim&apos;s fee and every other cost are shown before you sign and are part of the transaction you approve. See the <a href="/fees">fees page</a>.</p>
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
