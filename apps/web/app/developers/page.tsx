import { connection } from 'next/server';
import { SiteFooter, SiteHeader } from '@/components/site/Brand';
import { DevNav, type DevNavGroup } from '@/components/site/DevNav';
import { GetApiKey } from '@/components/site/GetApiKey';
import { FEE_BPS, TREASURY } from '@/lib/client/config';
import { signPageChunks } from '@/lib/server/scriptIntegrity';
import { SKILL_ARCHIVE, SKILL_VERSION } from '@/lib/server/skillSums';

export const metadata = {
  title: 'Developers — Orientim',
  description: 'Protected Solana swaps for AI agents and bots: the agent skill, the command line and the API.',
};

/** The fee this build charges, as the other pages state it. */
const feeText = TREASURY ? `${(Number(FEE_BPS) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%` : 'No fee (test deployment)';

/** The sidebar's contents: every entry is a section of this page. */
const NAV: DevNavGroup[] = [
  { title: 'Getting started', items: [['overview', 'Overview'], ['start', 'Quickstart'], ['access', 'API keys']] },
  {
    title: 'Guides',
    items: [['skill', 'AI agents: the skill'], ['cli', 'Bots: the command line'], ['how', 'How a protected swap works'], ['verify', 'Verify before you sign'], ['recovery', 'Results and recovery']],
  },
  { title: 'API reference', items: [['api', 'Authentication'], ['prepare', 'Prepare'], ['finalize', 'Finalize'], ['keys', 'Key endpoints'], ['errors', 'Errors'], ['limits', 'Rate limits']] },
  { title: 'Reference', items: [['env', 'Environment variables'], ['fees', 'Fees and limits'], ['supported', 'Tokens and wallets'], ['downloads', 'Downloads']] },
];

/** Every error the API answers with, and what the caller does about it (AGENT-API.md, "Errors"). */
const ERRORS: [string, string, string][] = [
  ['400', 'bad-request', 'Fix the request; message says which field.'],
  ['400', 'invalid-ticket', 'The ticket was not issued to this API key, or was altered.'],
  ['400', 'transaction-changed', 'The message is not the one Orientim built. Sign the transaction exactly as returned.'],
  ['400', 'bad-signature', 'Key endpoints: the signature does not match, or the challenge expired or was not Orientim’s. Ask for a new challenge.'],
  ['400', 'wallet-changed-transaction', 'Your wallet’s signature is missing or does not match.'],
  ['401', 'unauthorized', 'Missing or unknown API key.'],
  ['403', 'wrong-wallet', 'The key belongs to another wallet; a self-serve key prepares swaps for its own wallet only.'],
  ['403', 'wallet-empty', 'Key endpoints: the wallet holds less than 0.01 SOL. Fund it, then ask again.'],
  ['404', 'not-enabled', 'The agent API is not available.'],
  ['409', 'price-moved', 'The market cannot meet your minOut. newMinOut is what it supports now: prepare again with it only with the user’s approval.'],
  ['409', 'costs-more', 'The protected route is gapBps below the open market. With the user’s approval, prepare again with acceptCostBps.'],
  ['409', 'output-balance-changed', 'Your balance of the output token moved since prepare. Check the signature, then prepare again.'],
  ['410', 'expired', 'The transaction’s lifetime passed before finalize. Check the signature, then prepare again.'],
  ['422', 'amount-too-small', 'The amount is below the smallest swap Orientim takes, about $1.'],
  ['422', 'unsupported-token, no-route, insufficient-sol, insufficient-balance, simulation-failed, …', 'This swap cannot be built safely right now; message says why.'],
  ['426', 'skill-outdated', 'This copy of the skill is older than Orientim serves. Download the current one; a swap already signed still finalizes.'],
  ['429', 'rate-limited', 'Too many requests for this key (per wallet for a self-serve key). Wait Retry-After seconds.'],
  ['500', 'internal', 'Something unexpected failed; nothing was signed by Orientim or sent. Retry later.'],
  ['503', 'busy, unavailable', 'The market data or the network is overloaded. Wait Retry-After seconds and retry.'],
  ['503', 'fee-unavailable', 'Orientim cannot collect its fee on this swap right now, so it built nothing. Wait and retry.'],
  ['503', 'paused', 'Orientim has paused protected swaps. Your funds are not affected.'],
  ['503', 'route-format', 'The route’s format changed and Orientim refuses what it cannot read. Wait at least Retry-After (300 seconds).'],
];

const PREPARE_FIELDS: [string, string, string][] = [
  ['owner', 'required', 'The wallet that pays and receives. It signs first.'],
  ['inputMint, outputMint', 'required', 'Mint addresses. SOL is So11111111111111111111111111111111111111112.'],
  ['amountIn', 'required', 'Base units, as a string ("5000000" is 5 USDC). It includes the fee when the fee is taken in the input token.'],
  ['minOut', 'optional', 'Your own floor, in base units of the output: what your wallet must keep. Orientim never enforces less. The skill’s check refuses to sign without a floor of your own.'],
  ['slippageBps', 'optional', 'How far below the quote the swap may fill: 10 to 1500 (0.1% to 15%). Default 50, or 300 on a Pump.fun launch curve.'],
  ['acceptCostBps', 'optional', 'Accept a protected route this many bps below the open market (see costs-more): a whole number, as a number or a string.'],
];

const PREPARE_ANSWER: [string, string][] = [
  ['ticket', 'Pass it to finalize, with the signed transaction.'],
  ['transaction', 'The unsigned transaction, base64. Verify it, then sign it as your wallet.'],
  ['messageSha256', 'The hash of the message; the certificate and the ticket are bound to it.'],
  ['temporaryAuthority', 'The one-time key of this swap.'],
  ['lastValidBlockHeight, blocksLeft', 'The transaction’s lifetime: 150 blocks, about 40 seconds.'],
  ['amounts', 'amountIn, fee, feeMint, feeBps, quotedOut, minOut and priceImpactPct.'],
  ['costs', 'The network fee, rent, and keptSolLamports: all the SOL the swap costs and does not return.'],
  ['notices, tokens', 'A busy network, and what each token’s issuer can do (freeze balances, mint more).'],
  ['certificate, policy', 'What this exact transaction does, and the rules it was verified against.'],
];

/** What `orientim-verify` exits with (skills/orientim-protected-swap/src/cli.ts). */
const EXIT_CODES: [string, string][] = [
  ['0', 'Done. prepare: sign message. finalize: confirmed, with received. recover: all settled. check: safe to sign.'],
  ['1', 'Refused, or not swapped (failed, expired or rejected), including error.code floor-too-low, price-impact-high and the owner’s limits (mint-not-allowed, amount-over-limit, daily-limit). Nothing is left to settle.'],
  ['2', 'A usage or configuration error, such as a prepare without an order id: the answer says what is missing.'],
  ['3', 'Settle first: an earlier swap may still land, another finalize from this wallet is still running (busy), or the state directory cannot be made or read. Run recover; start nothing new.'],
  ['4', 'Orientim said no: error.code is one of the Errors below.'],
  ['5', 'This order id already swapped, or its transaction may still land. It is never swapped twice.'],
];

const ENV: [string, string][] = [
  ['ORIENTIM_API_URL', 'https://orientim.com'],
  ['ORIENTIM_API_KEY', 'Your key, ori_…'],
  ['SOLANA_RPC_URL', 'Your own RPC, never Orientim’s: the check is worth what the chain state it reads is worth.'],
  ['JUPITER_API_KEY', 'For the agent’s own price floor (free at developers.jup.ag).'],
  ['ORIENTIM_WALLET_KEYPAIR', 'The example only: the path to the wallet’s key file, or pass a signing service in code. The command line never reads a key; the bot signs. A key file the example can read, the agent that runs it can read too.'],
  ['ORIENTIM_POLICY', 'Optional, recommended for agents and unattended bots: the path to a JSON file of the owner’s limits, kept where the agent cannot edit it. maxAmountIn is the most one swap may spend of each input mint (a mint not listed is refused); maxAmountInPerDay the most all swaps from the wallet may spend in 24 hours. Base units, as strings.'],
  ['ORIENTIM_STATE_DIR', 'Where swaps in flight and the order book are kept across restarts (.orientim-state by default). Give it an absolute path on a disk that outlives the bot, not a container’s own file system.'],
  ['ORIENTIM_TREASURY', 'Optional, for a test deployment only: Orientim’s treasury is built into the skill.'],
];

/** For developers: everything an agent or a bot needs, one section per entry of the sidebar. */
export default async function Page() {
  signPageChunks('developers/page');
  // Rendered per request so that every response carries a fresh CSP nonce (proxy.ts).
  await connection();
  return (
    <div className="site">
      <SiteHeader right={<a className="ghost connect" href="/#swap">Open the app</a>} />
      <main className="dev-page">
        <div className="container devdocs-grid">
          <aside className="dev-aside">
            <DevNav groups={NAV} />
          </aside>
          <article className="dev-main prose">
            <header className="dev-head">
              <p className="eyebrow">Developers</p>
              <h1>Protected swaps for agents and bots</h1>
              <p className="lead">
                An API, an agent skill and a command line for Solana swaps in which your wallet never hands over its authority.
                With the skill, your agent checks every transaction on its own RPC before it signs.
              </p>
            </header>

            <section id="overview">
              <h2>Overview</h2>
              <p>The swap program only ever holds a one-time key with the amount you approve, and if less than your minimum would arrive, the whole transaction reverts. Three ways in:</p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Use</th><th>For</th></tr></thead>
                  <tbody>
                    <tr><td><a href="#skill">Agent skill</a></td><td>Coding agents: instructions, a working TypeScript example and the verifier.</td></tr>
                    <tr><td><a href="#cli">Command line</a></td><td>Bots in Python, Rust, Go or any language that can start a process.</td></tr>
                    <tr><td><a href="#api">API</a></td><td>Your own integration: two calls, with <a href="#verify">the check</a> run before you sign.</td></tr>
                  </tbody>
                </table>
              </div>
              <p>You need:</p>
              <ul>
                <li>An <a href="#access">API key</a> for the wallet that swaps.</li>
                <li>An RPC of your own.</li>
                <li>A wallet that signs first and hands the transaction back: a local key or a signing service.</li>
                <li>Node 22.18 or later, for the skill and the command line.</li>
              </ul>
            </section>

            <section id="start">
              <h2>Quickstart</h2>
              <ol>
                <li><strong>Get an API key</strong> with the wallet your agent swaps from, in <a href="#access">API keys</a>.</li>
                <li>
                  <strong>Download the skill</strong>: <a href={SKILL_ARCHIVE} download>orientim-protected-swap.zip</a> (v{SKILL_VERSION}).
                  It holds the instructions for your agent, a working example, the command line and the verifier.
                </li>
                <li>
                  <strong>Check it</strong>: in the unzipped folder, every file against the list this site serves (on macOS,{' '}
                  <code>shasum -a 256 -c</code>).
                  <pre><code>{`cd orientim-protected-swap
curl -s https://orientim.com/skill/SHA256SUMS | sha256sum -c`}</code></pre>
                </li>
                <li>
                  <strong>Run it</strong>: <code>npm ci</code>, set the <a href="#env">environment variables</a>, then follow{' '}
                  <a href="#skill">AI agents</a> or <a href="#cli">Bots</a>.
                </li>
              </ol>
            </section>

            <section id="access">
              <h2>API keys</h2>
              <p>
                Get a key at once, with no form: the wallet your agent swaps from signs a message, and the key is bound to that
                wallet. Signing moves nothing. The wallet needs at least 0.01 SOL. A key lasts 90 days; sign again for a new one.
              </p>
              <GetApiKey skill={{ href: SKILL_ARCHIVE, version: SKILL_VERSION }} />
              <h3>From the command line, with the agent&apos;s own wallet</h3>
              <pre><code>{`echo '{"wallet": "<the agent's address>"}' | node bin/orientim-verify.mjs key-challenge
# sign "messageBase64" with the agent's key, then:
echo '{"message": "...", "challenge": "...", "signature": "<base58>"}' | node bin/orientim-verify.mjs key`}</code></pre>
              <p>
                In code, <code>requestApiKey</code> from the skill does both steps. It signs only Orientim&apos;s key message for that
                wallet, and refuses anything else. The HTTP calls are in <a href="#keys">Keys</a>.
              </p>
            </section>

            <section id="skill">
              <h2>AI agents: the skill</h2>
              <p>
                For coding agents: instructions for the agent (<code>SKILL.md</code>), a working example that needs only{' '}
                <code>@solana/kit</code>, and the check it runs before every signature. The agent gets its settings from you, in the{' '}
                <a href="#env">environment variables</a>, never in chat.
              </p>
              <h3>1. Install it</h3>
              <ul>
                <li>
                  <strong>Claude Code</strong>: unzip it into <code>.claude/skills/orientim-protected-swap/</code> in your project, or into{' '}
                  <code>~/.claude/skills/</code> for every project. The agent picks it up when a task needs a swap.
                </li>
                <li><strong>Any other agent</strong>: put the folder in your project and point the agent to <code>SKILL.md</code>.</li>
                <li>Then, in that folder: check it (see <a href="#start">Quickstart</a>) and run <code>npm ci</code>.</li>
              </ul>
              <h3>2. Try it without signing</h3>
              <pre><code>{`node examples/swap.ts --in <mint> --out <mint> --amount 5000000 \\
  --owner <wallet> --dry-run`}</code></pre>
              <p>This prepares and verifies a swap on your RPC and prints what it would cost. Nothing is signed.</p>
              <h3>3. Swap</h3>
              <pre><code>{`node examples/swap.ts --in <mint> --out <mint> --amount 5000000 --id order-42`}</code></pre>
              <p>
                The same order id on every retry: an order that swapped, or may still land, is never swapped again. Or ask your agent,
                in plain words: <em>&ldquo;swap 5 USDC to SOL with Orientim&rdquo;</em>.
              </p>
              <h3>4. In your own code</h3>
              <pre><code>{`import { createKeyPairSignerFromBytes, createSolanaRpc } from '@solana/kit';
import { readFileSync } from 'node:fs';
import { createFileStore, protectedSwap, recoverPending } from './examples/swap.ts';

const rpc = createSolanaRpc(process.env.SOLANA_RPC_URL!);
const wallet = await createKeyPairSignerFromBytes(
  new Uint8Array(JSON.parse(readFileSync(process.env.ORIENTIM_WALLET_KEYPAIR!, 'utf8'))));
const store = createFileStore('.orientim-state');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';

// Settle what a stopped run left before anything new.
const { unknown } = await recoverPending(store, rpc, { orders: store });
if (unknown.length) throw new Error('An earlier swap may still land');

const result = await protectedSwap({
  apiUrl: process.env.ORIENTIM_API_URL!,
  apiKey: process.env.ORIENTIM_API_KEY!,
  jupiterApiKey: process.env.JUPITER_API_KEY,
  rpc, wallet, pending: store, orders: store,
  intent: { id: 'order-42', inputMint: USDC, outputMint: SOL, amountIn: '5000000' },
});
// result.outcome: 'confirmed' | 'failed' | 'expired' | 'unknown' | 'rejected'`}</code></pre>
              <p>
                <code>protectedSwap</code> asks Jupiter for its own price on every swap and takes your minimum from it when{' '}
                <code>minOut</code> is not set (a <code>minOut</code> more than 20% below that price is refused), verifies the
                transaction on your RPC, signs as the wallet, keeps the swap before finalize and reads the outcome on chain.
              </p>
              <h3>A wallet in a signing service</h3>
              <p>
                Pass <code>signerFromSignBytes(address, sign)</code> (a KMS, an HSM, raw-message signing) or{' '}
                <code>signerFromSignTransaction(address, sign)</code> (a service that signs and hands the transaction back) as{' '}
                <code>wallet</code>. A service that can only sign and send cannot be used: Orientim signs last. With a service that
                reads the transaction and applies its own policies (Turnkey or Privy, for example), prefer{' '}
                <code>signerFromSignTransaction</code>.
              </p>
              <p>
                Orientim protects the wallet from the route and the server, not from the agent: a key file the swap can read, the
                agent that runs it can read too, and a permission rule does not change that. To keep the key from the agent, sign in
                a process the agent does not run: a signing service, or a small signer of your own with its own limits. Either way,
                give the agent a wallet of its own holding only what it may swap, and set <a href="#env">ORIENTIM_POLICY</a>.
              </p>
            </section>

            <section id="cli">
              <h2>Bots: the command line</h2>
              <p>
                <code>bin/orientim-verify.mjs</code> in the skill runs the whole flow for a bot written in Python, Rust, Go or anything
                that can start a process: JSON in on stdin, JSON out on stdout, and an exit code. It does everything the skill does:
                your own floor, the check on your RPC, the record kept before finalize, and the outcome read on chain. The bot keeps
                its key and signs one message itself. Run <code>npm ci</code> in the skill folder first.
              </p>
              <h3>The flow</h3>
              <ol>
                <li><strong>recover</strong>: settles what a stopped run left. Exit 3 means an earlier swap may still land: start nothing new.</li>
                <li><strong>prepare</strong> <code>{'{"intent": {...}}'}</code>: answers <code>message</code> and <code>checked</code>, already verified on your RPC.</li>
                <li><strong>Sign</strong> the bytes of <code>message</code> (base64) with the wallet&apos;s ed25519 key.</li>
                <li>
                  <strong>finalize</strong> <code>{'{"checked": ..., "signature": "<base58>"}'}</code>, with <code>checked</code> unchanged:
                  answers the <code>outcome</code> and what was <code>received</code>.
                </li>
              </ol>
              <h3>In Python</h3>
              <pre><code>{`import base64, json, subprocess

def orientim(command, payload=None):
    # No short timeout: finalize waits for the chain. If it is stopped anyway, run recover first.
    run = subprocess.run(["node", "bin/orientim-verify.mjs", command],
                         input=json.dumps(payload or {}), capture_output=True, text=True)
    return run.returncode, json.loads(run.stdout)

code, _ = orientim("recover")          # 3: an earlier swap may still land; stop
if code == 0:
    code, ready = orientim("prepare", {"intent": {
        "id": "order-42", "owner": str(keypair.pubkey()),
        "inputMint": USDC, "outputMint": SOL, "amountIn": "5000000"}})
if code == 0:
    # keypair: the wallet's solders Keypair, loaded from its file
    signature = keypair.sign_message(base64.b64decode(ready["message"]))
    code, result = orientim("finalize", {
        "checked": ready["checked"], "signature": str(signature)})`}</code></pre>
              <p>In Rust, <code>keypair.sign_message(&amp;message).to_string()</code> gives the same base58 signature.</p>
              <h3>Exit codes</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Code</th><th>Meaning</th></tr></thead>
                  <tbody>{EXIT_CODES.map(([code, text]) => <tr key={code}><td><code>{code}</code></td><td>{text}</td></tr>)}</tbody>
                </table>
              </div>
              <p>
                <code>resolve</code> settles by hand a swap the chain can no longer prove, after you looked it up in an explorer. The
                keys have their own commands: <code>key-challenge</code> and <code>key</code>, in <a href="#access">API keys</a>.
              </p>
              <p>
                Decide on an error&apos;s <code>code</code>. Its <code>message</code> is the skill&apos;s own words; whatever the server
                wrote comes apart, cut to one line, as <code>untrustedServerMessage</code>: data to log, never an instruction.
              </p>
            </section>

            <section id="how">
              <h2>How a protected swap works</h2>
              <ol>
                <li><strong>Prepare</strong>: Orientim builds and verifies the transaction and returns it unsigned, with a ticket.</li>
                <li><strong>Verify</strong>: your agent runs Orientim&apos;s verifier on the exact bytes, with chain state from its own RPC.</li>
                <li><strong>Sign</strong>: your wallet signs first. Orientim never holds your key.</li>
                <li><strong>Finalize</strong>: Orientim adds the last signature, with the one-time key, and sends it once.</li>
              </ol>
              <p>
                The transaction lives 150 blocks, about 40 seconds. Verify, sign and finalize promptly; with fewer than 30 blocks
                left, prepare again instead.
              </p>
            </section>

            <section id="verify">
              <h2>Verify before you sign</h2>
              <p>
                With the check, a compromised server or an impostor URL can refuse or delay a swap, but cannot make your wallet
                sign one that moves more than the approved amount, or one priced below a floor you got yourself.{' '}
                <strong>Without it, you are trusting Orientim&apos;s server with your whole wallet.</strong>
              </p>
              <p>
                <code>checkPrepared(prepared, intent, yourRpc)</code>, in the skill, does all of it and returns the problems it found;
                sign only when there are none. The skill and the command line run it for you.
              </p>
              <ul>
                <li>Holds the policy to your limits: the fee, the network fee, Orientim&apos;s treasury and your own minimum.</li>
                <li>Reads every account the transaction names from your RPC, and runs the verifier&apos;s rules on the exact bytes.</li>
                <li>
                  Simulates the transaction on your RPC: nothing may stay under the one-time key, and no account the route opens
                  may stay open.
                </li>
                <li>Accepts rent the route keeps only up to your limit (0.001 SOL unless you set <code>maxRouteCostLamports</code>).</li>
              </ul>
              <p>
                Your minimum is required, and it must be a price you got yourself, never Orientim&apos;s: <code>ownMinimum</code> asks
                Jupiter for one. For a large order, check it against a second source as well.
              </p>
              <p>
                Calling the API yourself, in any language? Pipe prepare&apos;s answer to the command line before you sign:{' '}
                <code>{'{"prepared": ..., "intent": {...}}'}</code> into <code>orientim-verify check</code> exits 0 only when it is safe
                to sign.
              </p>
            </section>

            <section id="recovery">
              <h2>Results and recovery</h2>
              <p>
                The transaction&apos;s id on chain is your wallet&apos;s signature, known before finalize. Keep it, with the ticket, before
                you call finalize: whatever finalize answers, or if no answer arrives, that signature is how you find out what
                happened.
              </p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>status</th><th>Meaning</th></tr></thead>
                  <tbody>
                    <tr><td><code>sent</code></td><td>Accepted, or already on chain. Confirm it on chain; re-broadcast <code>signedTransaction</code> until it confirms or its lifetime passes. It can land only once.</td></tr>
                    <tr><td><code>unknown</code></td><td>The connection failed after the request left. Check the signature before anything else.</td></tr>
                    <tr><td><code>rejected</code></td><td>This request never sent it, usually because the price moved.</td></tr>
                  </tbody>
                </table>
              </div>
              <p>
                The skill and the command line read the result on chain for you and answer an <code>outcome</code> instead:{' '}
                <code>confirmed</code>, <code>failed</code>, <code>expired</code>, <code>unknown</code> (check again before anything new),
                or <code>rejected</code> (finalize refused, and the transaction can no longer land).
              </p>
              <ul>
                <li>Finalizing the same ticket again is safe: it answers for the same transaction, which can land only once.</li>
                <li>
                  Before preparing the same swap again, make sure the one you signed can no longer land: no record of its signature,
                  and the network past its last valid block.
                </li>
                <li>
                  Run one swap per wallet at a time. The skill does all of this for you (<code>protectedSwap</code>,{' '}
                  <code>recoverPending</code>), and <code>orientim-verify resolve</code> settles a swap by hand.
                </li>
              </ul>
            </section>

            <section id="api">
              <h2>Authentication</h2>
              <p>Base URL <code>https://orientim.com</code>. Every request carries an API key:</p>
              <pre><code>Authorization: Bearer ori_...</code></pre>
              <p>
                A key prepares swaps for its own wallet only; another <code>owner</code> is refused with{' '}
                <code>403 wrong-wallet</code>. Calls may carry <code>x-orientim-skill: &lt;version&gt;</code>, as the skill does.
              </p>
            </section>

            <section id="prepare">
              <h2>Prepare</h2>
              <pre><code>{`POST /api/v1/prepare
Authorization: Bearer ori_...
Content-Type: application/json

{
  "owner": "<your wallet address>",
  "inputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "outputMint": "So11111111111111111111111111111111111111112",
  "amountIn": "5000000",
  "minOut": "42400000",
  "slippageBps": 100
}`}</code></pre>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Field</th><th>Meaning</th></tr></thead>
                  <tbody>{PREPARE_FIELDS.map(([f, need, text]) => <tr key={f}><td><code>{f}</code><span className="dev-need">{need}</span></td><td>{text}</td></tr>)}</tbody>
                </table>
              </div>
              <h3>Answer</h3>
              <p>All amounts are strings in base units.</p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Field</th><th>Meaning</th></tr></thead>
                  <tbody>{PREPARE_ANSWER.map(([f, text]) => <tr key={f}><td><code>{f}</code></td><td>{text}</td></tr>)}</tbody>
                </table>
              </div>
            </section>

            <section id="finalize">
              <h2>Finalize</h2>
              <pre><code>{`POST /api/v1/finalize
Authorization: Bearer ori_...
Content-Type: application/json

{ "ticket": "eyJ2Ijox....", "signedTransaction": "<base64, signed by your wallet>" }`}</code></pre>
              <p>
                Orientim checks that the message is byte for byte the one it built, that your wallet&apos;s signature is valid and that
                the transaction has not expired, then adds the last signature and sends it once. If an earlier finalize of this
                ticket already sent it, the answer is that same transaction and nothing is sent again.
              </p>
              <pre><code>{`{
  "signature": "5h...",
  "status": "sent",
  "signedTransaction": "<base64, fully signed>",
  "lastValidBlockHeight": "312345678"
}`}</code></pre>
              <p>What each <code>status</code> means is in <a href="#recovery">Results and recovery</a>.</p>
            </section>

            <section id="keys">
              <h2>Keys</h2>
              <pre><code>{`GET /api/v1/keys/challenge?wallet=<address>
→ { "message": "...", "challenge": "...", "expiresAt": "..." }

POST /api/v1/keys
{ "message": "<the message, unchanged>", "challenge": "...", "signature": "<base58 or base64>" }
→ { "key": "ori_...", "wallet": "<address>", "expiresAt": "..." }`}</code></pre>
              <ul>
                <li>Sign the challenge within 10 minutes.</li>
                <li>
                  Sign only Orientim&apos;s key message for your own wallet: a signature over bytes someone else chose could be a
                  signature for a transaction. The skill checks the message before anything is signed.
                </li>
                <li>
                  <code>400 bad-signature</code>: the signature does not match, or the challenge expired, was not Orientim&apos;s, or
                  names another site. <code>403 wallet-empty</code>: the wallet holds less than 0.01 SOL.
                </li>
                <li>From one address, 30 challenges and 10 keys an hour; a <code>429</code> carries <code>Retry-After</code>.</li>
              </ul>
            </section>

            <section id="errors">
              <h2>Errors</h2>
              <p>
                Every error is <code>{'{ "error": { "code": "...", "message": "..." } }'}</code>, and the request that received it signed
                and sent nothing. <code>price-moved</code> and <code>costs-more</code> carry <code>requiresApproval: true</code>: a worse
                price is the user&apos;s decision, not a retry.
              </p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>HTTP</th><th>code</th><th>What to do</th></tr></thead>
                  <tbody>{ERRORS.map(([http, code, text]) => <tr key={code}><td>{http}</td><td><code>{code}</code></td><td>{text}</td></tr>)}</tbody>
                </table>
              </div>
            </section>

            <section id="limits">
              <h2>Rate limits</h2>
              <ul>
                <li>
                  60 requests a minute for each endpoint, counted per wallet for a self-serve key. A <code>429</code> carries{' '}
                  <code>Retry-After</code>: the seconds until the count starts again.
                </li>
                <li>API keys: 30 challenges and 10 keys an hour from one address.</li>
                <li>One swap per output token at a time, and one per wallet in the skill.</li>
                <li>A key used to overload or attack the service is revoked.</li>
              </ul>
            </section>

            <section id="env">
              <h2>Environment variables</h2>
              <p>The skill and the command line read these. Never put a wallet key in a prompt, a message, a log or a command line.</p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Variable</th><th>Value</th></tr></thead>
                  <tbody>{ENV.map(([name, value]) => <tr key={name}><td><code>{name}</code></td><td>{value}</td></tr>)}</tbody>
                </table>
              </div>
            </section>

            <section id="fees">
              <h2>Fees and limits</h2>
              <ul>
                <li>
                  {feeText}, inside the transaction you sign, in SOL, USDC or USDT when the swap has one of them, otherwise in the
                  input token or in SOL. A swap whose fee cannot be collected is refused with <code>503 fee-unavailable</code>.
                </li>
                <li>The verifier refuses any fee above 1% and any network fee above 0.001 SOL.</li>
                <li>
                  A slippage tolerance of your choice (<code>slippageBps</code>, 0.1% to 15%); 0.5% by default, 3% on a Pump.fun launch
                  curve.
                </li>
                <li>
                  The skill refuses a swap whose price impact is above 5% before anything is prepared (<code>maxPriceImpactBps</code>{' '}
                  raises it, to 20% at most).
                </li>
                <li>
                  Limits no flag can loosen: in the skill, a minimum never more than 20% below Jupiter&apos;s own price
                  (<code>floor-too-low</code>) and Orientim&apos;s fee at 0.3% at most.
                </li>
                <li>
                  The owner&apos;s own limits, per swap and per day for each input mint, in a file (<code>ORIENTIM_POLICY</code>):
                  a swap outside them is refused before anything is prepared and again before finalize.
                </li>
                <li>Swaps smaller than about $1 are not taken.</li>
              </ul>
            </section>

            <section id="supported">
              <h2>Tokens and wallets</h2>
              <p>
                The same tokens as the page: see <a href="/security#supported">supported tokens</a>. Wallets must be able to sign first
                and hand the transaction back: local keys and signing services work; sign-and-send-only wallets and multisig vaults
                do not.
              </p>
            </section>

            <section id="downloads">
              <h2>Downloads</h2>
              <ul>
                <li><a href={SKILL_ARCHIVE} download>orientim-protected-swap.zip</a>: the skill, version {SKILL_VERSION}.</li>
                <li><a href="/skill/SHA256SUMS">SHA256SUMS</a>: the checksum of every file in it.</li>
                <li>The full API reference, every field and recovery step, is <code>reference/AGENT-API.md</code> in the download.</li>
              </ul>
            </section>
          </article>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
