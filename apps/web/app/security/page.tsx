import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { FEE_BPS, TREASURY } from '@/lib/client/config';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

/** The fee this build charges, as the swap page states it: compiled in, like the page's own. */
const feeText = `${(Number(FEE_BPS) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

export const metadata = {
  title: 'Security — Orientim',
  description: 'What a protected swap guarantees, what it does not, and what it costs.',
};

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
      lead="A normal swap hands the swap program your wallet's authority for the whole transaction. Orientim builds the swap so that the program never gets it: only the amount you swap is placed where the program can reach it, under a one-time key that exists for this one transaction."
    >
      <section>
        <h2>What happens when you swap</h2>
        <ol>
          <li>Orientim asks Jupiter for a route and builds one transaction around it.</li>
          <li>
            Before your wallet opens, your browser checks every instruction of that exact transaction against Orientim&apos;s
            rules. If it contains anything else, nothing is signed.
          </li>
          <li>Your wallet signs first. Orientim checks that it signed exactly what was checked, then adds the last signature.</li>
          <li>The swap runs. If less than the minimum you saw would arrive, the whole transaction is cancelled.</li>
        </ol>
      </section>

      <section>
        <h2>What is guaranteed</h2>
        <ul>
          <li>The swap can spend only the amount you approve, plus a market&apos;s one-time account deposit when one is shown first.</li>
          <li>Your other tokens, your NFTs and the rest of your SOL are never given to the swap program.</li>
          <li>No permission over your wallet is granted, and none outlives the transaction.</li>
          <li>You receive at least the minimum shown, or nothing happens and only the network fee is paid.</li>
          <li>Orientim never holds your funds and never asks for your seed phrase.</li>
        </ul>
      </section>

      <section>
        <h2>What it does not do</h2>
        <ul>
          <li>It protects your wallet, not the price or the value of the token you buy.</li>
          <li>
            The minimum for a token you buy is checked against your balance as the network reported it when the swap was
            built.
          </li>
          <li>
            Tokens whose issuer can run code on every transfer, or move balances through a program, are refused: Orientim
            cannot isolate them. Some wallets cannot be used: those that can only sign and send at once, and multisig
            vaults.
          </li>
          <li>The checks run in this page, which Orientim serves: open Orientim only at orientim.com.</li>
          <li>
            Orientim keeps your swaps in this browser to follow their outcome, so it needs this site&apos;s data allowed. While
            the network cannot yet say whether your last swap went through, it starts no new one from the same wallet.
          </li>
          <li>It cannot protect a wallet or a device that is already compromised.</li>
        </ul>
      </section>

      <section>
        <h2>What your wallet shows</h2>
        <p>
          Wallets show a protected swap in their own way. Phantom shows the amounts. Others, such as Trust Wallet, list the
          transaction&apos;s steps instead:
        </p>
        <ul>
          <li><strong>A second signer</strong>: Orientim&apos;s one-time key for this swap. It is normal.</li>
          <li><strong>Close account, owner: the one-time key</strong>: Orientim closing its temporary accounts; what is in them comes back to your wallet.</li>
          <li><strong>A small transfer to Orientim&apos;s treasury</strong>: the Orientim fee.</li>
          <li>
            <strong>Addresses loaded from a lookup table</strong>: a standard way for Solana transactions routed through Jupiter
            to fit their size limit. Some wallets cannot display those addresses and warn about it.
          </li>
        </ul>
      </section>

      <section>
        <h2>What it costs</h2>
        <ul>
          {TREASURY ? (
            <li>Orientim&apos;s fee is {feeText} of the swap, shown before your wallet opens. It is taken in one of the swap&apos;s own tokens when possible (SOL, USDC or USDT first), otherwise in SOL from your wallet.</li>
          ) : (
            <li>This deployment takes no Orientim fee.</li>
          )}
          <li>The network fee, usually a fraction of a cent and never more than 0.001 SOL, is shown exactly before you sign.</li>
        </ul>
        <p>
          The reviews and their fixes are listed on the <a href="/audits">audits page</a>.
        </p>
      </section>
    </InfoPage>
  );
}
