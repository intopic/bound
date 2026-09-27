import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { FEE_BPS, TREASURY } from '@/lib/client/config';
import { legal } from '@/lib/legal';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

/** The fee this build charges, as the swap page states it: compiled in, like the page's own. */
const feeText = `${(Number(FEE_BPS) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

export const metadata = {
  title: 'Security — Orientim',
  description: 'What a protected swap guarantees, what it does not, what it costs, and what it supports.',
};

const SUPPORTED: [string, string][] = [
  ['SOL and standard SPL tokens', 'Supported'],
  ['Token-2022 tokens with metadata, groups, close authority or confidential transfers', 'Supported'],
  ['Token-2022 tokens with a transfer tax', 'Supported; the tax is shown before your wallet opens'],
  ['Stablecoins whose issuer can move balances with its own key (PYUSD, USDG, AUSD, CASH)', 'Supported, with a warning'],
  ['Tokens whose issuer can move balances through a program', 'Refused, with the reason: Orientim cannot isolate them'],
  ['Pump.fun tokens, on the launch curve and on PumpSwap', 'Supported'],
  ['Tokens with an active transfer hook, frozen by default, pausable, non-transferable or interest-bearing', 'Refused, with the reason: Orientim cannot isolate them'],
  ['Routes through a market that would leave an account open', 'Refused: its deposit would be lost'],
  ['Routes too large for one transaction', 'Refused: Orientim never splits a swap'],
];

/**
 * What the product promises, in the words a person swapping needs, and no more than the code
 * enforces (README, SECURITY.md). A trust page for people who never read a repository (final audit, M3).
 */
export default async function Page() {
  signPageChunks('security/page');
  // Rendered per request so that every response carries a fresh CSP nonce (proxy.ts).
  await connection();
  return (
    <InfoPage
      eyebrow="Security"
      title="How Orientim protects you"
      lead="A typical swap acts with your wallet's authority for the whole transaction. Orientim builds each swap so that the swap program never gets it: only the amount you approve is placed within its reach, under a one-time key that exists for this one transaction."
    >
      <section>
        <h2>What happens when you swap</h2>
        <ol>
          <li>Orientim finds a route across Solana&apos;s markets and builds one transaction around it.</li>
          <li>
            Before your wallet opens, your browser checks every instruction of that exact transaction against Orientim&apos;s
            rules. If it contains anything else, nothing is signed.
          </li>
          <li>Your wallet signs first. Orientim checks that it signed exactly what was checked, then adds the last signature, with the one-time key.</li>
          <li>The swap runs. If less than the minimum you saw would arrive, the whole transaction is cancelled.</li>
        </ol>
      </section>

      <section>
        <h2>What every protected swap enforces</h2>
        <ul>
          <li>The swap can spend only the amount you approve, plus a market&apos;s one-time account deposit when one is shown first.</li>
          <li>Your other tokens, your NFTs and the rest of your SOL are never given to the swap program.</li>
          <li>No permission over your wallet is granted, and none outlives the transaction.</li>
          <li>You receive at least the minimum shown, or nothing happens and only the network fee is paid.</li>
          <li>Orientim never holds your funds and never asks for your seed phrase.</li>
        </ul>
        <p>
          This describes how Orientim is designed. What is and is not guaranteed is set out in the <a href="/terms#protection">Terms</a>.
        </p>
      </section>

      <section>
        <h2>What it does not cover</h2>
        <ul>
          <li>It protects your wallet, not the price or the future value of the token you buy.</li>
          <li>
            Tokens Orientim cannot isolate are refused, with the reason: those whose issuer can run code on every transfer or
            move balances through a program.
          </li>
          <li>It cannot protect a wallet, a key or a device that is already compromised.</li>
          <li>
            The checks run in the page orientim.com serves. A page changed by an attacker could skip them: open Orientim only at
            orientim.com, and read what your wallet shows before you sign.
          </li>
        </ul>
      </section>

      <section>
        <h2>What your wallet may show</h2>
        <p>
          Wallets show a protected swap in their own way. Phantom shows the amounts. Others, such as Trust Wallet, list the
          transaction&apos;s steps instead:
        </p>
        <ul>
          <li><strong>A second signer</strong>: Orientim&apos;s one-time key for this swap. It is normal.</li>
          <li><strong>Close account, owner: the one-time key</strong>: Orientim closing its temporary accounts; what is in them comes back to your wallet.</li>
          <li><strong>A small transfer to Orientim&apos;s treasury</strong>: the Orientim fee.</li>
          <li>
            <strong>Addresses loaded from a lookup table</strong>: a standard way for large Solana transactions to fit their size
            limit. Some wallets cannot display those addresses and warn about it.
          </li>
        </ul>
      </section>

      <section id="fees">
        <h2>Fees</h2>
        <p>Every cost is shown before your wallet opens, and the exact amounts while it is open.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Cost</th><th>Amount</th><th>Who receives it</th></tr></thead>
            <tbody>
              <tr><td>Orientim fee</td><td>{TREASURY ? `${feeText} of the swap` : 'None'}</td><td>Orientim. Inside the transaction you sign: in SOL, USDC or USDT when the swap has one of them, otherwise in the input token or in SOL from your wallet.</td></tr>
              <tr><td>Network fee</td><td>Usually ~0.00002 SOL, never more than 0.001 SOL</td><td>Solana&apos;s validators. The exact amount is shown before you sign.</td></tr>
              <tr><td>Market account fee</td><td>Only on some markets, such as a Pump.fun launch curve</td><td>The market. Shown and asked about before your wallet opens.</td></tr>
              <tr><td>Token transfer tax</td><td>Only on tokens that tax transfers</td><td>The token&apos;s issuer. Stated before your wallet opens.</td></tr>
            </tbody>
          </table>
        </div>
        <ul>
          <li>No fee to connect, to get a price or to cancel.</li>
          <li>A swap that does not run, because less than the minimum would arrive or its time ran out, costs at most the network fee.</li>
          <li>Swaps smaller than $1 are not offered: the costs would be larger than the swap.</li>
        </ul>
      </section>

      <section id="supported">
        <h2>Supported tokens and wallets</h2>
        <p>
          Orientim works with any token pair that has a route on Solana&apos;s markets and that Orientim can isolate safely. Paste any token&apos;s address in
          the token window to check it: a token Orientim cannot swap safely is marked, and the page says why.
        </p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Kind</th><th>Answer</th></tr></thead>
            <tbody>{SUPPORTED.map(([kind, answer]) => <tr key={kind}><td>{kind}</td><td>{answer}</td></tr>)}</tbody>
          </table>
        </div>
        <ul>
          <li><strong>Browser wallets that sign and hand the transaction back</strong>, such as Phantom, Solflare, Backpack and Trust Wallet&apos;s extension, should work. Tested on mainnet so far with Phantom and Trust Wallet.</li>
          <li><strong>On a phone</strong>: open orientim.com inside your wallet&apos;s browser. Not yet tested on phones; a wallet that asks you to connect in another app is not supported yet.</li>
          <li><strong>Wallets that can only sign and send at once, and multisig vaults</strong>: not supported, because your wallet must sign first and Orientim last.</li>
        </ul>
      </section>

      <section id="report">
        <h2>Report a vulnerability</h2>
        <p>
          If you find a security problem in Orientim, write to {legal('securityEmail')} before telling anyone else, with enough detail to
          reproduce it. We answer, keep you informed while we fix it, and credit you if you wish.
        </p>
        <p>
          We will not take legal action against research done in good faith that avoids harm to users and their funds, does not access
          other people&apos;s data, does not disrupt the service, and gives us reasonable time to fix the problem before it is disclosed.
          Never test with other people&apos;s wallets or funds.
        </p>
      </section>
    </InfoPage>
  );
}
