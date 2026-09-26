import { FEE_BPS, TREASURY } from '@/lib/client/config';
import { AgentTerminal, AuthorityMap, CapsuleFlow } from './Motion';

const feeText = `${(Number(FEE_BPS) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

const CAPSULE_STEPS = [
  ['The amount moves into a one-time key', 'Only what you approve leaves your wallet, into a key that exists for this one swap.'],
  ['The route trades it', 'A route across Solana’s markets is found for you. It works with the one-time key, never with your wallet.'],
  ['The minimum is checked on chain', 'If less than the minimum would arrive, the whole swap cancels itself. Then the key is gone.'],
];

const AGENT_POINTS = [
  ['Verified on its own RPC', 'The skill runs the full verifier in the agent, on the exact bytes it signs.'],
  ['Limits of its own', 'A maximum fee, a maximum SOL cost and a price floor from its own source.'],
  ['Safe across crashes', 'An id for every order, recovery after a restart, never the same swap twice.'],
  ['Any language, any signer', 'A skill for coding agents, an API, and a CLI for Python, Rust or Go. Works with your own key setup.'],
];

const KEEPS_NOTHING = [
  [NoDatabaseIcon, 'No account. No database.', 'No sign-up, and Orientim’s servers keep no record of your swaps. Your history stays in your own browser.'],
  [ShieldIcon, 'Never your keys or funds.', 'You sign in your own wallet. Orientim never holds funds or asks for a seed phrase.'],
  [EyeOffIcon, 'No tracking.', 'No cookies, analytics or trackers. Price quotes are requested without your wallet address.'],
] as const;

const FAQ: [string, string][] = [
  ['What does Orientim protect?', 'What a swap can reach. The swap programs work with a one-time key that holds only the amount you approve, never with your wallet’s authority, and the minimum you accepted is enforced on chain. It does not protect the value of a token or a wallet that is already compromised.'],
  ['Does Orientim hold my funds or my keys?', 'No. You sign with your own wallet. Orientim never holds funds and never asks for your seed phrase.'],
  ['Why use Orientim instead of a regular swap?', 'Orientim routes through the same markets as a regular swap, and adds what a regular swap does not have: the route never holds your wallet’s authority. A protected route can occasionally price a little differently; when it costs more than 0.5% over the open market, you are asked before signing.'],
  ['What happens if the minimum cannot be met?', 'The whole swap cancels itself instead of completing for less. The network fee of an attempted transaction may still be paid.'],
  ['Which tokens and wallets work?', 'Any token with a route on Solana’s markets that Orientim can isolate, including Token-2022 and Pump.fun tokens. Browser wallets that sign and hand the transaction back work, such as Phantom and Trust Wallet. A token Orientim cannot isolate is refused, with the reason.'],
  ['What does a pending or unknown result mean?', 'The network has not confirmed the outcome yet. In this browser, Orientim starts no new swap from the same wallet until it knows, so the same swap is not sent twice from here.'],
  ['Can my AI agent use Orientim?', 'Yes, through the API, the agent skill or the command line. With the skill or the command line, the agent verifies every transaction on its own RPC before signing, so even a compromised server cannot make it sign more than its limits.'],
  ['What does it cost?', `An Orientim fee of ${TREASURY ? feeText : '0%'} of the swap, and Solana’s network fee. Some markets and tokens add a charge; it is shown before you sign.`],
];

export function HomeSections() {
  return (
    <>
      {/* The one line under the hero: how every swap is protected. */}
      <section className="proof-strip" aria-label="How every swap is protected">
        <div className="container proof-row">
          <p className="one-key">
            <LockIcon />
            <strong>Zero exposure beyond the order.</strong>
          </p>
        </div>
      </section>

      <section className="section" id="how">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">How protection works</p>
            <h2>The swap gets the amount. Never your wallet.</h2>
          </div>
          <div className="glass-stage">
            <div className="ambient" aria-hidden="true" />
            <div className="capsule-card">
              <CapsuleFlow />
              <ol className="capsule-steps">
                {CAPSULE_STEPS.map(([title, text], i) => (
                  <li key={title}><span className="step-n">{i + 1}</span><div><h3>{title}</h3><p>{text}</p></div></li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container split-media">
          <div>
            <p className="eyebrow">The difference</p>
            <h2>A budget, not your signature.</h2>
            <p className="lead">
              In a typical swap, your wallet signs as the authority of the swap&apos;s instructions, and the programs on the route act
              with that signature. In Orientim, the route only ever holds a one-time key with the amount you approved. That holds even
              if a program on the route misbehaves.
            </p>
          </div>
          <AuthorityMap />
        </div>
      </section>

      <section className="section" id="agents">
        <div className="container">
          <div className="dev-grid">
            <div>
              <p className="eyebrow eyebrow-cyan">For AI agents and bots</p>
              <h2>Your agent trades. Your wallet stays out of reach.</h2>
              <p className="lead">
                The same one-key protection through an API, a skill for coding agents and a command line. With the skill, your agent
                checks every transaction on its own RPC before it signs, so even a compromised server can’t make it sign more than its
                limits.
              </p>
              <ul className="agent-points">
                {AGENT_POINTS.map(([title, text]) => <li key={title}><b>{title}</b><span>{text}</span></li>)}
              </ul>
              <div className="cta-actions">
                <a className="button primary-link" href="/developers#access">Get an API key</a>
                <a className="button ghost-link" href="/developers">Developer docs</a>
              </div>
            </div>
            <div className="agent-media">
              <AgentTerminal />
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="security">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">Stateless by design</p>
            <h2>Protection that keeps nothing.</h2>
          </div>
          <div className="glass-stage">
            <div className="ambient" aria-hidden="true" />
            <ul className="keeps-nothing">
              {KEEPS_NOTHING.map(([Icon, title, text]) => (
                <li key={title}><span className="trust-icon"><Icon /></span><h3>{title}</h3><p>{text}</p></li>
              ))}
            </ul>
          </div>
          <a className="text-link" href="/privacy">Privacy notice →</a>
        </div>
      </section>

      <section className="section" id="fees">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">Fees</p>
            <h2>Every cost, before you sign.</h2>
          </div>
          <div className="fee-grid">
            <div className="fee">
              <p className="fee-name">Orientim fee</p>
              <p className="fee-value">{TREASURY ? feeText : '0'}</p>
              <p>Of the swap, inside the transaction you sign.</p>
            </div>
            <div className="fee">
              <p className="fee-name">Network fee</p>
              <p className="fee-value">Solana&apos;s</p>
              <p>Usually a fraction of a cent. The exact amount is shown before you sign.</p>
            </div>
            <div className="fee">
              <p className="fee-name">Market charges</p>
              <p className="fee-value">Only if any</p>
              <p>Some markets and tokens add a charge. It is shown and asked about first.</p>
            </div>
          </div>
          <a className="text-link" href="/security#fees">How fees work →</a>
        </div>
      </section>

      <section className="section" id="faq">
        <div className="container faq-wrap">
          <div className="section-head">
            <p className="eyebrow">Questions</p>
            <h2>Before your first swap.</h2>
          </div>
          <div className="faq">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="cta-band">
            <div>
              <h2>Swap with your wallet out of reach.</h2>
              <p>Choose a pair, review the minimum and the fees, and approve in your own wallet.</p>
            </div>
            <div className="cta-actions">
              <a className="button primary-link" href="#swap">Start swapping</a>
              <a className="button ghost-link" href="/developers#access">Get an API key</a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2.5" />
    </svg>
  );
}

function NoDatabaseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="5.5" rx="7" ry="2.5" />
      <path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5M3 3l18 18" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l7 3v5.5c0 4.3-2.9 7.9-7 9.5-4.1-1.6-7-5.2-7-9.5V6z" />
      <circle cx="12" cy="10.5" r="1.8" />
      <path d="M12 12.3V15" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
      <path d="M4 4l16 16" />
    </svg>
  );
}
