import { AgentTerminal, CapsuleFlow, CheckedTwice } from './Motion';

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
  [NoDatabaseIcon, 'No account. No database.', 'No sign-up, and Orientim keeps no record of your swaps. Our host keeps standard request logs. Your history stays in your own browser.'],
  [ShieldIcon, 'Never your keys or funds.', 'You sign in your own wallet. Orientim never holds funds or asks for a seed phrase.'],
  [EyeOffIcon, 'No tracking.', 'No cookies, analytics or trackers. Price quotes are requested without your wallet address.'],
] as const;

export function HomeSections() {
  return (
    <>
      {/* The one line under the hero: how every swap is protected. */}
      <section className="proof-strip" aria-label="How every swap is protected">
        <div className="container proof-row">
          <p className="one-key">
            <LockIcon />
            <strong>The swap program reaches only the amount you approve.</strong>
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
          <div className="checked-twice">
            <h3>Every swap is checked twice, independently</h3>
            <CheckedTwice />
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
