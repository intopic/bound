import { connection } from 'next/server';
import { GetApiKey } from '@/components/site/GetApiKey';
import { InfoPage } from '@/components/site/InfoPage';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export const metadata = {
  title: 'Docs — Orientim',
  description: 'Protected Solana swaps for bots and AI agents: the skill, the API and the command line.',
};

/** The agent API in the words a developer needs first; AGENT-API.md is the full reference. */
export default async function Page() {
  signPageChunks('docs/page');
  // Rendered per request so that every response carries a fresh CSP nonce (proxy.ts).
  await connection();
  return (
    <InfoPage
      eyebrow="Docs"
      title="Protected swaps for agents and bots"
      lead="Your wallet signs a swap in which the swap program only ever holds a one-time key and a temporary account with the amount you approved. It cannot touch anything else in the wallet, and if less than your minimum would arrive, the whole transaction reverts."
    >
      <section>
        <h2>How it works</h2>
        <ol>
          <li><strong>Prepare</strong>: Orientim builds and verifies the transaction and returns it unsigned, with a ticket.</li>
          <li><strong>Verify</strong>: your agent runs Orientim&apos;s verifier on the exact bytes, with chain state from its own RPC.</li>
          <li><strong>Sign</strong>: your wallet signs first. Orientim never holds your key.</li>
          <li><strong>Finalize</strong>: Orientim adds the last signature, with the one-time key, and sends it once.</li>
        </ol>
        <p>
          <strong>Verify before you sign.</strong> With the check, a compromised server or an impostor URL can refuse or delay
          a swap, but cannot make your wallet sign one that moves more than the approved amount, or one priced below a floor
          you got yourself. Without it, you are trusting Orientim&apos;s server with your whole wallet.
        </p>
      </section>

      <section id="skill">
        <h2>Agent skill</h2>
        <p>
          For coding agents: instructions, a working example that needs only <code>@solana/kit</code>, and the check it runs before
          every signature. The skill is delivered with your API key.
        </p>
        <p>The agent needs, from you and never in chat:</p>
        <ul>
          <li><code>ORIENTIM_API_URL</code>: <code>https://orientim.com</code></li>
          <li><code>ORIENTIM_API_KEY</code>: your key, <code>ori_…</code></li>
          <li><code>SOLANA_RPC_URL</code>: your own RPC, never Orientim&apos;s</li>
          <li><code>ORIENTIM_WALLET_KEYPAIR</code>: the path to the wallet&apos;s key file, or a signing service</li>
          <li><code>JUPITER_API_KEY</code>: for the agent&apos;s own price floor</li>
        </ul>
      </section>

      <section id="api">
        <h2>API</h2>
        <p>Every request carries an API key. Requests are limited per key; a <code>429</code> means wait and retry.</p>
        <pre><code>{`POST /api/v1/prepare
Authorization: Bearer ori_...

{
  "owner": "<your wallet address>",
  "inputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "outputMint": "So11111111111111111111111111111111111111112",
  "amountIn": "5000000",
  "minOut": "42400000",
  "slippageBps": 100
}`}</code></pre>
        <p>
          The answer is the unsigned <code>transaction</code>, a <code>ticket</code>, the amounts and costs, and the policy it was
          verified against. All amounts are strings in base units. The transaction lives about 40 seconds.
        </p>
        <pre><code>{`POST /api/v1/finalize
Authorization: Bearer ori_...

{ "ticket": "eyJ2Ijox....", "signedTransaction": "<base64, signed by your wallet>" }`}</code></pre>
        <p>
          Orientim checks that the message is byte for byte the one it built, adds the last signature and sends it once. The
          answer is <code>sent</code>, <code>unknown</code> (check the signature before anything else) or <code>rejected</code>.
        </p>
      </section>

      <section>
        <h2>Command line, for bots in any language</h2>
        <p>
          <code>bin/orientim-verify.mjs</code> in the skill runs the whole flow for a bot written in Python, Rust, Go or anything
          that can start a process: JSON in on stdin, JSON out on stdout, an exit code. The bot keeps its key and signs one
          message itself.
        </p>
        <pre><code>{`echo '{"intent":{"owner":"<wallet>","inputMint":"<mint>","outputMint":"<mint>","amountIn":"5000000"}}' \\
  | node bin/orientim-verify.mjs prepare`}</code></pre>
      </section>

      <section>
        <h2>Fees and limits</h2>
        <ul>
          <li>0.3%, inside the transaction you sign, in SOL, USDC or USDT when the swap has one of them, otherwise in the input token or in SOL.</li>
          <li>The verifier refuses any fee above 1% and any network fee above 0.001 SOL.</li>
          <li>Wallets must be able to sign first and hand the transaction back: local keys and signing services work; sign-and-send-only wallets and multisig vaults do not.</li>
          <li>
            The same protection as the page, in every integration: a slippage tolerance of your choice (<code>slippageBps</code>, 0.1% to
            15%; 0.5% by default), a swap refused before anything is prepared when its price impact is above 5%, notes about a
            token&apos;s issuer, and what arrived, read from the transaction.
          </li>
        </ul>
      </section>

      <section id="access">
        <h2>API access</h2>
        <p>
          Get a key at once, with no form: the wallet your agent swaps from signs a message, and the key is bound to that wallet.
          Signing moves nothing. The wallet needs at least 0.01 SOL, and the key lasts 90 days.
        </p>
        <GetApiKey />
        <h3>From the command line, with the agent&apos;s own wallet</h3>
        <pre><code>{`echo '{"wallet": "<the agent's address>"}' | node bin/orientim-verify.mjs key-challenge
# sign "messageBase64" with the agent's key, then:
echo '{"message": "...", "challenge": "...", "signature": "<base58>"}' | node bin/orientim-verify.mjs key`}</code></pre>
        <p>
          In code, <code>requestApiKey</code> from the skill does both steps. It signs only Orientim&apos;s key message for that
          wallet, and refuses anything else.
        </p>
      </section>

      <section>
        <h2>Full reference</h2>
        <p>Every field, error and recovery step is in the reference that ships with the skill.</p>
      </section>
    </InfoPage>
  );
}
