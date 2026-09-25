import { FEE_BPS, TREASURY } from '@/lib/client/config';
import { DevTabs } from './DevTabs';

const feeText = `${(Number(FEE_BPS) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

const STEPS = [
  ['Set the order', 'Choose the tokens and the amount. You see the minimum you will receive and every cost before anything is signed.'],
  ['Orientim prepares and verifies', 'The swap is built around a one-time key that holds only this amount. Your browser checks every instruction of that exact transaction.'],
  ['Approve in your wallet', 'You sign the exact transaction that was checked. If less than the minimum would arrive, the whole swap cancels itself.'],
];

const GUARANTEED = [
  'The swap can spend only the amount you approve, and a market’s account fee when one is shown first.',
  'Your other tokens, your NFTs and the rest of your SOL are never handed to the swap program.',
  'No permission over your wallet is granted, and none outlives the transaction.',
  'You receive at least the minimum shown, or nothing happens and only the network fee is paid.',
];

const NOT_COVERED = [
  'The price or the value of the token you buy.',
  'What a token’s issuer can do to it anywhere, such as freezing it. Orientim warns you before the swap.',
  'A wallet or a device that is already compromised.',
];

const FLOW = ['Prepare', 'Verify', 'Sign', 'Finalize'];

export function HomeSections() {
  return (
    <>
      <section className="section" id="how">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">How it works</p>
            <h2>Three steps, and your wallet stays yours.</h2>
          </div>
          <ol className="steps">
            {STEPS.map(([title, text], i) => (
              <li key={title} className="step">
                <span className="step-n">{i + 1}</span>
                <h3>{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section" id="security">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">Security</p>
            <h2>The swap gets a budget, not your wallet.</h2>
            <p className="lead">
              A normal swap hands the swap program your wallet&apos;s authority for the whole transaction. Orientim gives it a
              one-time key that holds only the amount you swap, and checks the exact transaction before your wallet opens.
            </p>
          </div>
          <div className="split">
            <div className="panel">
              <h3>What is guaranteed</h3>
              <ul className="checks">{GUARANTEED.map(t => <li key={t}>{t}</li>)}</ul>
            </div>
            <div className="panel">
              <h3>What it does not cover</h3>
              <ul className="limits">{NOT_COVERED.map(t => <li key={t}>{t}</li>)}</ul>
              <div className="panel-links">
                <a className="text-link" href="/security">The full security model →</a>
                <a className="text-link" href="/audits">Audits →</a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="developers">
        <div className="container dev-grid">
          <div>
            <p className="eyebrow">For AI agents and developers</p>
            <h2>Your agent swaps. It can&apos;t overspend.</h2>
            <p className="lead">
              The same protection through an API and a skill for coding agents. The agent verifies every transaction with its
              own RPC before it signs, so even Orientim&apos;s server cannot make it sign more than the approved amount.
            </p>
            <ol className="flow" aria-label="The flow">
              {FLOW.map(step => <li key={step}>{step}</li>)}
            </ol>
          </div>
          <DevTabs />
        </div>
      </section>

      <section className="section" id="fees">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">Fees</p>
            <h2>Every cost, before you sign.</h2>
          </div>
          <div className="fee-grid two">
            <div className="fee">
              <p className="fee-name">Orientim fee</p>
              <p className="fee-value">{TREASURY ? feeText : '0'}</p>
              <p>Of the swap, inside the transaction you sign.</p>
            </div>
            <div className="fee">
              <p className="fee-name">Network fee</p>
              <p className="fee-value">~0.00002 SOL</p>
              <p>Paid to Solana, shown exactly before you sign.</p>
            </div>
          </div>
          <a className="text-link" href="/fees">All fees →</a>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="cta-band">
            <div>
              <h2>Swap with your wallet protected.</h2>
              <p>Connect a Solana wallet and make your first protected swap in seconds.</p>
            </div>
            <div className="cta-actions">
              <a className="button primary-link" href="#swap">Start swapping</a>
              <a className="button ghost-link" href="/docs">Read the docs</a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
