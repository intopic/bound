import { connection } from 'next/server';
import { FEE_BPS, TREASURY } from '@/lib/client/config';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

/** The fee this build charges, as the swap page states it: compiled in, like the page's own. */
const feeText = `${(Number(FEE_BPS) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

export const metadata = {
  title: 'How Bound protects you',
  description: 'What a protected swap guarantees, what it does not, and what it costs.',
};

/**
 * What the product promises, in the words a person swapping needs, and no more than the code
 * enforces (README, SECURITY.md). A trust page for people who never read a repository (final audit, M3).
 */
export default async function Page() {
  signPageChunks('how/page');
  // Rendered per request so that every response carries a fresh CSP nonce (proxy.ts).
  await connection();
  return (
    <main className="page how">
      <header className="top">
        <a className="brand" href="/">← Bound</a>
      </header>

      <section className="card">
        <h1>How Bound protects you</h1>
        <p>
          A normal swap hands the swap program your wallet&apos;s authority for the whole transaction. Bound builds the
          swap so that the program never gets it: only the amount you swap is placed where the program can reach it,
          under a one-time key that exists for this one transaction.
        </p>
      </section>

      <section className="card">
        <h2>What happens when you swap</h2>
        <ol>
          <li>Bound asks Jupiter for a route and builds one transaction around it.</li>
          <li>
            Before your wallet opens, your browser checks every instruction of that exact transaction against Bound&apos;s
            rules. If it contains anything else, nothing is signed.
          </li>
          <li>Your wallet signs first. Bound checks that it signed exactly what was checked, then adds the last signature.</li>
          <li>The swap runs. If less than the minimum you saw would arrive, the whole transaction is cancelled.</li>
        </ol>
      </section>

      <section className="card">
        <h2>What is guaranteed</h2>
        <ul>
          <li>The swap can spend only the amount you approve, plus a market&apos;s one-time account deposit when one is shown first.</li>
          <li>Your other tokens, your NFTs and the rest of your SOL are never given to the swap program.</li>
          <li>No permission over your wallet is granted, and none outlives the transaction.</li>
          <li>You receive at least the minimum shown, or nothing happens and only the network fee is paid.</li>
          <li>Bound never holds your funds and never asks for your seed phrase.</li>
        </ul>
      </section>

      <section className="card">
        <h2>What it does not do</h2>
        <ul>
          <li>It protects your wallet, not the price or the value of the token you buy.</li>
          <li>
            The minimum for a token you buy is checked against your balance as the network reported it when the swap was
            built.
          </li>
          <li>
            Tokens whose issuer can run code on every transfer, or move balances through a program, are refused: Bound
            cannot isolate them. Some wallets cannot be used: those that can only sign and send at once, and multisig
            vaults.
          </li>
          <li>The checks run in this page, which Bound serves: open Bound only at its own address.</li>
          <li>
            Bound keeps your swaps in this browser to follow their outcome, so it needs this site&apos;s data allowed. While
            the network cannot yet say whether your last swap went through, it starts no new one from the same wallet.
          </li>
        </ul>
      </section>

      <section className="card">
        <h2>What it costs</h2>
        <ul>
          {TREASURY ? (
            <li>Bound&apos;s fee is {feeText} of the swap, shown before your wallet opens. It is taken in one of the swap&apos;s own tokens when possible (SOL, USDC or USDT first), otherwise in SOL from your wallet.</li>
          ) : (
            <li>This deployment takes no Bound fee.</li>
          )}
          <li>The network fee, usually a fraction of a cent and never more than 0.001 SOL, is shown exactly before you sign.</li>
          <li>A new token account, the first time you hold a token, keeps a small deposit that stays yours.</li>
        </ul>
      </section>

      <p className="muted">
        <a href="/">Back to the swap</a>
      </p>
    </main>
  );
}
