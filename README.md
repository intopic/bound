# Orientim — Protected Swap (v0.1)

Swap SOL and SPL or Token-2022 tokens on Solana without giving the swap program authority over the
rest of your wallet. Every token whose setup Orientim can prove harmless to the swap is supported; any
other is refused with the reason (SECURITY.md, "What works and what is refused").

> **What you approve is all the swap can touch.** The external swap program can move at most the
> amount you approve, plus a market's one-time account fee when one is shown before your wallet
> opens. It gets no spending authority over your other tokens, your NFTs or your SOL, no permission
> outlives the transaction, and the minimum output shown is enforced on successful execution: if
> less would arrive, the whole swap reverts. For a token output that check relies on the RPC's
> report of your balance of that token (SECURITY.md, "One RPC provider").

## How it works

1. Orientim creates a one-time key **E** in the browser (WebCrypto Ed25519, non-extractable).
2. In a single transaction, the wallet **W** moves exactly the amount to swap into a temporary account
   owned by E, pays the Orientim fee (0.3%), and only E and that account are given to the one untrusted
   instruction (Jupiter's swap). After the swap, Orientim checks that at least the minimum output
   arrived, then closes the temporary accounts back to W.
3. Before the wallet opens, the **verifier** checks the exact bytes against 7 rules (below).
4. The wallet signs first with `signTransaction` (no send). Orientim checks that the returned message is
   byte-for-byte the verified one with a valid W signature. Only then does E add the last required
   signature and Orientim sends it.

If anything fails, nothing is signed or the whole transaction reverts. There is no "continue anyway".

Wallets: any wallet that signs a transaction and hands it back unsent (Wallet Standard
`solana:signTransaction`) with a second signer left empty. Orientim builds v0 transactions; with v1
enabled, only a route too big for v0 is built as v1, because not every signer reads v1 yet (Ledger's
Solana app does not). Phantom's embedded wallets (sign-and-send
only) and multisig or smart-wallet vaults (Squads, Swig) cannot sign first, so they cannot use Orientim
(review FA-14). Tested with real wallets on mainnet: Phantom (ten swaps, Token-2022 and Pump.fun
among them, docs/AUDIT.md 0zg) and Trust Wallet (one swap, 0zh). Solflare and Backpack are still to be
tested.

| Rule | Guarantee |
| --- | --- |
| R6 | Only W and E sign; W pays; what the wallet returns is exactly what was verified. Because W never appears in the swap, W's signature is never available to it: this is what makes the other rules sufficient |
| R1 | W and W's token accounts (except the output account) never reach the external program, including through lookup tables; nor do Orientim's fee accounts |
| R2 | Every trusted instruction matches an exact template: amounts, accounts, order. No `Approve`, `SetAuthority`, stray transfers or closes. The output account's delegate is revoked before the swap, and the minimum output is checked after it. Jupiter's route must deliver into that output account (E's temporary one for SOL), where its own floor is measured. The fee is at most 1% when taken from the input before the swap or from a SOL, USDC or USDT output after the minimum is checked. For a pair neither token of which can carry it, the fee is paid in SOL from the wallet before the swap, priced by Jupiter when it is built: the verifier pins where it goes, and the page shows it (an agent holds it to its own price) before the wallet signs |
| R3 | E and its accounts are fresh |
| R4 | The network fee paid by W is capped (never above 0.001 SOL) |
| R5 | One transaction within size limits; every temporary account is closed. Before the wallet opens, the exact transaction is simulated: nothing may stay under E, and no account the route opens may stay open |
| R7 | Input, output and intermediate mints are classic SPL, or Token-2022 carrying only extensions that cannot touch the swap (metadata, groups, close authority, confidential transfers and their fee, an unset transfer hook, accounts initialized by default, a permanent delegate that is an ordinary key, and a transfer fee on the swap's own mints) |

## Repository

```text
bound/
├── packages/
│   ├── core/       intent → policy, compiler, constants (pure, no network)
│   ├── verifier/   the 7 rules and the certificate (pure, no network, independent of the compiler) + tests
│   ├── solana/     chain snapshot, simulation, send/confirm, ephemeral key
│   └── jupiter/    Jupiter Swap API V2 client, prepare → finalize pipeline, route repair
├── apps/web/       Next.js dApp, CSP proxy, stateless API routes (/api/rpc, /api/jupiter/*, /api/token-icon,
│                   /api/status) and the agent API (/api/v1/prepare, /api/v1/finalize)
├── skills/orientim-protected-swap/   the package agents and bots download: SKILL.md, the verifier bundle,
│                                  the `orientim-verify` command and the example (AGENT-API.md)
├── integrations/solana-agent-kit/   the Solana Agent Kit plugin (its own package, dependencies and tests)
├── tests/
│   ├── integration/   mainnet simulations: T4, T1 and T5 (mainnet.ts), T7 sizes (large.ts), T9 cost of
│   │                  protection (thresholds.ts), Jupiter's floor, Pump.fun, Token-2022 and issuer stablecoins
│   ├── cpi/           T6: a malicious swap program (Rust) executed against the protected transaction in a real Solana VM
│   └── e2e/           browser tests (Microsoft Edge via Playwright)
├── tools/          skill build, release digest, live check, canary, agent API keys
├── docs/           AUDIT.md (every review, finding and fix), TESTIMI.md (the manual wallet test, in
│                   Albanian), audit-prompts/ (the briefs given to auditors)
└── .github/        CI, fuzz, T6, canary, release and live-check workflows
```

The verifier (`packages/verifier`, `@orientim/verifier`) imports only `@solana/kit`, the token program
client and Orientim's constants and types, never the compiler or the policy builder, and takes its
limits from `constants.ts`; a test enforces all of it. After a transaction passes every rule it
issues a certificate bound to the message's SHA-256, which travels with the prepared swap for a
wallet, an agent or an auditor; the page itself states the minimum and the costs in plain words.

Orientim supports any token pair that Jupiter can route and Orientim can safely isolate. It keeps no
customer, wallet or transaction database; hosting and RPC providers keep their own operational
logs.

## Requirements

- Node.js 22.18 or newer (the scripts run TypeScript directly)
- For the browser tests: Microsoft Edge (preinstalled on Windows)

## Commands

```bash
npm install
npm test                  # unit, mutation (M1–M16), audit regression, proxy and property tests
npm run test:fuzz         # every property at full size; the Fuzz workflow runs about 30 million cases in 45 shards
npm run typecheck
npm run integration       # mainnet simulation: T4 + T1 + T5 (nothing is signed or sent)
npm run cpi               # T6: build the malicious program and run it (Linux or macOS)
npm run build             # production build of the dApp
npm run start -w @orientim/web   # serve it on http://localhost:3000
npm run e2e               # browser smoke test against http://localhost:3000
node tests/e2e/busy.ts    # the page when Jupiter or the RPC refuse with 429 (same server)
node tools/agent-key.ts <id>   # an API key for the agent API (AGENT-API.md)
node tools/agent-key.ts --key-secret   # the secret that turns on self-serve API keys (/docs#access)
cd integrations/solana-agent-kit && npm install && npm test   # the Solana Agent Kit plugin, on its own
node skills/orientim-protected-swap/examples/swap.ts   # the agent skill's example (SKILL.md); prints its usage
node tools/build-skill.ts             # rebuild the verifier bundled in the skill (CI checks it)
node tests/integration/jupiter-floor.ts   # Jupiter's on-chain floor and where it is measured, on mainnet state
node tools/canary.ts                  # do seven protected swaps, with every kind of fee, v1 and Pump.fun, still build and execute?
node tests/e2e/pump-card.ts           # what a Pump.fun buy shows before the wallet opens (same server as e2e)
npm run build:digest      # one hash over everything the browser loads, to compare with a release
node tools/check-live.ts --site <url> --manifest build-digest.txt   # is a site serving that release?
```

## Configuration

Copy `apps/web/.env.example` to `apps/web/.env.local`.

Fixed at build time (compiled into the page, so the server cannot change them afterwards):

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_ORIENTIM_TREASURY` | — | Fee wallet. Empty = test mode, no fee. The fee is taken like Jupiter's: in SOL first, then USDC, then USDT, on whichever side of the swap they are; otherwise in the input token. Fund the wallet with a little SOL and open its USDC and USDT accounts: then every swap pays, memecoin sales included; a pair neither token of which the treasury can receive pays in SOL from the wallet, at the swap's value (AUDIT.md 0w). With a treasury set, a swap whose fee cannot be collected (the wallet not funded yet, a pair that cannot be priced in SOL, an amount too small to carry it) is refused, never built free (AUDIT.md 0zb) |
| `NEXT_PUBLIC_ORIENTIM_FEE_BPS` | 30 | 0.3%. The verifier refuses more than 100 (1%) |
| `NEXT_PUBLIC_ORIENTIM_ENABLE_V1` | — | `1` builds v1 transactions for wallets that advertise them. Off until a Orientim v1 swap has landed on mainnet |

Server only (never sent to the browser):

| Variable | Default | Meaning |
| --- | --- | --- |
| `RPC_URL` | public mainnet RPC | Solana RPC. The public one rate-limits and refuses browser sends; run on a provider (Helius is the chosen one, see SECURITY.md) |
| `JUPITER_API_KEY` | — | Required for any real use (free at developers.jup.ag/portal): Jupiter asks for a key on every endpoint and throttles keyless requests after one or two, so quotes fail as "busy". `/api/status` says whether it is set |
| `ORIENTIM_MAX_USD_PER_SWAP` | unset | Optional cap per swap in USD. Unset means no limit, the intended setting: the guarantee does not depend on the amount. While a cap applies, tokens without a USD price are blocked |
| `ORIENTIM_DISABLED` | 0 | Kill switch: `1` makes the server refuse new swaps |
| `ORIENTIM_CLIENT_IP_HEADER` | `x-vercel-forwarded-for` | The one header your ingress overwrites with the client address (Cloudflare: `cf-connecting-ip`). The app's rate limit is per instance; add a rule in the hosting firewall too |
| `ORIENTIM_EXCLUDE_DEXES` | `HumidiFi` | DEXes whose per-taker rent is too high to pay on every swap |
| `ORIENTIM_MAX_NETWORK_FEE_LAMPORTS` | 500000 | F_max, capped at 1,000,000 by the verifier |

### Deploy: the firewall

The app's own limits are per instance and in memory; the hosting firewall is what holds under load,
and what stops a script from spending Orientim's RPC (Helius) and Jupiter quota through its proxies.
Orientim's proxies already refuse requests other websites make from their visitors' browsers
(`Sec-Fetch-Site: cross-site`). On Vercel, add rate-limit rules per client IP, for example:

| Path | Limit | Why |
| --- | --- | --- |
| `/api/rpc` | 300 per minute | The page's chain reads; sends are also limited by the app (60 per minute) |
| `/api/jupiter/*` | 90 per minute | Quotes and token search, on Orientim's Jupiter key |
| `/api/token-icon` | 600 per minute | Icons, cached a day |
| `/api/v1/*` | 120 per minute | The agent API; each key has its own limit too (`ORIENTIM_API_PER_MINUTE`) |

Give the agent API quotas of its own (`RPC_URL_AGENTS`, and `JUPITER_API_KEY_AGENTS` from a separate
Jupiter account), so that agents cannot use up the page's, and set usage alerts at the RPC provider
(Helius: credit usage) and on the hosting bill, so abnormal consumption is seen the day it starts.

## Scope of v0.1

Protected: authority over the wallet and everything in it except the approved amount, and the
minimum output the user accepted (never below the quote minus 0.5% slippage, 3% on a Pump.fun
bonding curve, or the tolerance the person chose on the page, at most 15%), which Orientim checks on
chain. If the price moves further before signing, Orientim asks
instead of lowering it.
Every router must compile its quote to this same exact on-chain balance floor. A router-only or
off-chain minimum is not accepted as protection; a route that cannot express the floor is refused.
Not in scope: price movement and MEV within that tolerance, the value of the token you buy,
approvals granted elsewhere before, phishing sites that do not use Orientim, and Token-2022 tokens
whose extensions Orientim refuses (a permanent delegate a program can sign for, frozen by default,
pausable and the rest, listed in docs/AUDIT.md section 0f), and what a token's own issuer can do outside
the swap (PYUSD's, for example, can move it in any wallet; the page says so). Transfer-fee tokens are supported: Orientim prices the active schedule
from the current epoch and harvests temporary accounts before closing them.

See `SECURITY.md` for the threat model, `AGENT-API.md` for the agent API, `docs/AUDIT.md` for every
review, finding and fix, and `docs/TESTIMI.md` for the manual wallet test.
