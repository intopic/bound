import { AgentTerminal, CapsuleFlow, CheckedTwice } from './Motion';

const CAPSULE_STEPS = [
  ['Your agent chooses the amount.', 'Only what it approves leaves the wallet: the amount and the fees it was shown. The rest of the wallet is never part of the swap.'],
  ['Only that amount goes into the swap.', 'Orientim finds a route across Solana’s markets and trades just that amount, never the wallet.'],
  ['At least the minimum, or nothing happens.', 'Your agent sets its own minimum before it signs. If less would arrive, the whole swap cancels and nothing is traded; at most the small network fee is paid.'],
];

const AGENT_POINTS = [
  ['Checks before signing', 'With the skill or command line, the exact transaction is checked on your own connection to Solana. Direct API integrations must run the same check.'],
  ['Limits you set', 'Set an amount per swap, a daily budget, a fee cap and your own price floor. Keep unattended limits at the signer.'],
  ['Recovers an interrupted order', 'The skill keeps an order record across restarts. Direct bots need durable, shared order records to avoid a second swap.'],
  ['Works with your stack', 'A skill for coding agents, an API and a command line for bots. Keep the signing key outside the agent to enforce your own limits.'],
];

/** How an agent starts: the key, the skill, the first swap (the developer page has each in full). */
const START_STEPS = [
  ['Get an API key', 'Connect the wallet your agent swaps from and sign Orientim’s message. The key appears at once; signing moves nothing.'],
  ['Download the skill', 'Instructions for your agent, a working example, a command line for bots, and the verifier that checks every swap.'],
  ['Ask for a swap', 'Tell your agent: “swap 5 USDC to SOL with Orientim”. It checks the transaction on its own RPC, then signs.'],
];

const KEEPS_NOTHING = [
  [NoDatabaseIcon, 'No account. No database.', 'No sign-up, and Orientim keeps no record of your swaps or of the keys it issues. Our host keeps standard request logs.'],
  [ShieldIcon, 'Never your keys or funds.', 'Your agent signs with its own wallet or signing service. Orientim never holds funds or asks for a seed phrase.'],
  [EyeOffIcon, 'No tracking.', 'No cookies, analytics or trackers on this site.'],
] as const;

export function HomeSections() {
  return (
    <>
      <section className="hero">
        <div className="container hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">Protected swaps on Solana, for AI agents and bots</p>
            <h1 className="hero-title">Give your agent a safer way to swap.</h1>
            <p className="hero-sub">Orientim isolates the amount being traded. With the skill or verifier and a signer you control, each transaction is checked against your limits before it is signed.</p>
            <div className="cta-actions hero-actions">
              <a className="button primary-link" href="/developers#access">Get an API key</a>
              <a className="button ghost-link" href="/developers#start">Quickstart</a>
            </div>
          </div>
          <div className="hero-app">
            <AgentTerminal />
          </div>
        </div>
      </section>

      {/* The one line under the hero: how every swap is protected. */}
      <section className="proof-strip" aria-label="How every swap is protected">
        <div className="container proof-row">
          <p className="one-key">
            <LockIcon />
            <strong>Your trade gets its own wallet. Your wallet never becomes the trade.</strong>
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
              <h2>Your agent trades within the limits you set.</h2>
              <p className="lead">
                The skill checks each transaction before signing. For bots using the API directly, run the same verification and
                keep the signing key and spending policy outside the agent’s control.
              </p>
              <ul className="agent-points">
                {AGENT_POINTS.map(([title, text]) => <li key={title}><b>{title}</b><span>{text}</span></li>)}
              </ul>
              <div className="cta-actions">
                <a className="button primary-link" href="/developers#access">Get an API key</a>
                <a className="button ghost-link" href="/developers">Developer docs</a>
              </div>
            </div>
            <div className="glass-stage">
              <div className="ambient" aria-hidden="true" />
              <div className="capsule-card">
                <h3 className="start-title">Start in three steps</h3>
                <ol className="start-steps">
                  {START_STEPS.map(([title, text], i) => (
                    <li key={title}><span className="step-n">{i + 1}</span><div><h3>{title}</h3><p>{text}</p></div></li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
          <div className="checked-twice">
            <h3>Checked by Orientim, checked again by your agent</h3>
            <CheckedTwice />
          </div>
        </div>
      </section>

      <section className="section" id="security">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">Private by design</p>
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
              <h2>Give your agent a wallet, not a blank cheque.</h2>
              <p>Get a key with your agent’s wallet, download the skill, and let it swap within the limits you set.</p>
            </div>
            <div className="cta-actions">
              <a className="button primary-link" href="/developers#access">Get an API key</a>
              <a className="button ghost-link" href="/developers">Developer docs</a>
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
