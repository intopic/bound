import { FEE_BPS, TREASURY } from '@/lib/client/config';
import { DevTabs } from './DevTabs';
import { AgentTerminal, AuthorityMap, CapsuleFlow } from './Motion';

const feeText = `${(Number(FEE_BPS) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

/** What has been proven on mainnet, each one on the proof page with its transaction. */
const PROOF = ['Phantom', 'Trust Wallet', 'AI agents', 'Token-2022', 'Pump.fun launch curve'];

const CAPSULE_STEPS = [
  ['The amount moves into a one-time key', 'Only what you approve leaves your wallet, into a key that exists for this one swap.'],
  ['The route trades it', 'Jupiter finds the route. It works with the one-time key, never with your wallet.'],
  ['The minimum is checked on chain', 'If less than the minimum would arrive, the whole swap cancels itself. Then the key is gone.'],
];

const STEPS = [
  ['Choose', 'Pick the tokens and the amount. Paste any token’s address to find it.'],
  ['Review', 'See the minimum you receive and every fee before anything is signed.'],
  ['Approve', 'Sign in your own wallet the exact transaction Orientim checked.'],
];

const AGENT_POINTS = [
  ['Verified on its own RPC', 'The full verifier runs in the agent, on the exact bytes it signs.'],
  ['Limits of its own', 'A maximum fee, a maximum SOL cost and a price floor from its own source.'],
  ['Safe across crashes', 'An id for every order, recovery after a restart, never the same swap twice.'],
  ['Any language, any signer', 'A skill for coding agents, an API, a CLI for Python, Rust or Go; keys in a KMS or Turnkey.'],
];

const COVERED = [
  'The route can spend only the amount you approve, and a market’s account fee when one is shown first.',
  'Your other tokens, your NFTs and the rest of your SOL are never handed to the swap programs.',
  'No permission over your wallet is granted, and none outlives the transaction.',
  'You receive at least the minimum shown, or the swap cancels itself.',
];

const NOT_COVERED = [
  'The price or the future value of the token you buy.',
  'What a token’s issuer can do to it anywhere, such as freezing it. Orientim warns you first.',
  'A wallet, a key or a device that is already compromised.',
];

const FAQ: [string, string][] = [
  ['What does Orientim protect?', 'What a swap can reach. The swap programs work with a one-time key that holds only the amount you approve, never with your wallet’s authority, and the minimum you accepted is enforced on chain. It does not protect the value of a token or a wallet that is already compromised.'],
  ['Does Orientim hold my funds or my keys?', 'No. You sign with your own wallet. Orientim never holds funds and never asks for your seed phrase.'],
  ['Why use Orientim if I already use Jupiter?', 'Orientim uses Jupiter’s routes and liquidity, and adds what a regular swap does not have: the route never holds your wallet’s authority. A protected route can occasionally price differently; when it does, you are asked before signing.'],
  ['What happens if the minimum cannot be met?', 'The whole swap cancels itself instead of completing for less. The network fee of an attempted transaction may still be paid.'],
  ['Which tokens and wallets work?', 'Any token Jupiter can route and Orientim can isolate, including Token-2022 and Pump.fun tokens. Browser wallets that sign and hand the transaction back work, such as Phantom and Trust Wallet. A token Orientim cannot isolate is refused, with the reason.'],
  ['What does a pending or unknown result mean?', 'The network has not confirmed the outcome yet. Orientim starts no new swap from the same wallet until it knows, so the same swap never runs twice.'],
  ['Can my AI agent use Orientim?', 'Yes, through the API, the agent skill or the command line. The agent verifies every transaction on its own RPC before signing, so even a compromised server cannot make it sign more than its limits.'],
  ['What does it cost?', `An Orientim fee of ${TREASURY ? feeText : '0%'} of the swap, and Solana’s network fee. Some markets and tokens add a charge; it is shown before you sign.`],
];

export function HomeSections() {
  return (
    <>
      <section className="proof-strip" aria-label="Tested live on mainnet">
        <div className="container proof-row">
          <span className="proof-title">Tested live on mainnet</span>
          <ul>{PROOF.map(p => <li key={p}>{p}</li>)}</ul>
          <a className="text-link" href="/proof">See the transactions →</a>
        </div>
      </section>

      <section className="section" id="how">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">How protection works</p>
            <h2>The swap gets the amount. Never your wallet.</h2>
          </div>
          <div className="capsule-card">
            <CapsuleFlow />
            <ol className="capsule-steps">
              {CAPSULE_STEPS.map(([title, text], i) => (
                <li key={title}><span className="step-n">{i + 1}</span><div><h3>{title}</h3><p>{text}</p></div></li>
              ))}
            </ol>
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

      <section className="section">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">Three steps</p>
            <h2>Choose. Review. Approve.</h2>
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

      <section className="section" id="agents">
        <div className="container">
          <div className="dev-grid">
            <div>
              <p className="eyebrow eyebrow-cyan">For AI agents and bots</p>
              <h2>Your agent trades. Your wallet stays out of reach.</h2>
              <p className="lead">
                The same protection through an API, a skill for coding agents and a command line. The agent verifies every
                transaction on its own RPC before it signs, so even a compromised server cannot make it sign more than its limits.
              </p>
              <ul className="agent-points">
                {AGENT_POINTS.map(([title, text]) => <li key={title}><b>{title}</b><span>{text}</span></li>)}
              </ul>
              <div className="cta-actions">
                <a className="button primary-link" href="/docs#access">Get an API key</a>
                <a className="button ghost-link" href="/docs">Read the docs</a>
              </div>
            </div>
            <div className="agent-media">
              <AgentTerminal />
              <DevTabs />
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="security">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">Security</p>
            <h2>Understand the protection. Inspect the evidence.</h2>
          </div>
          <div className="split">
            <div className="panel">
              <h3>What Orientim enforces</h3>
              <ul className="checks">{COVERED.map(t => <li key={t}>{t}</li>)}</ul>
            </div>
            <div className="panel">
              <h3>What it does not cover</h3>
              <ul className="limits">{NOT_COVERED.map(t => <li key={t}>{t}</li>)}</ul>
            </div>
          </div>
          <div className="evidence">
            <a href="/security"><b>How protection works</b><span>The model, its assumptions and its limits</span></a>
            <a href="/proof"><b>Real swaps</b><span>Every test on mainnet, with its transaction</span></a>
            <a href="/proof#reviews"><b>Reviews</b><span>What each review found, and its type</span></a>
            <a href="/security#supported"><b>Supported tokens</b><span>What can be swapped, and why some can&apos;t</span></a>
          </div>
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
              <a className="button ghost-link" href="/docs#access">Get an API key</a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
