# Bound — Protected Swap (v0.1)

Swap any classic SPL token or SOL on Solana without giving the swap program authority over the
rest of your wallet.

> **What you approve is all the swap can touch.** The external swap program can move at most the
> amount you approve. It gets no spending authority over your other tokens, your NFTs or your SOL,
> no permission outlives the transaction, and the minimum output shown is enforced on successful
> execution: if less would arrive, the whole swap reverts.

## How it works

1. Bound creates a one-time key **E** in the browser (WebCrypto Ed25519, non-extractable).
2. In a single transaction, the wallet **W** moves exactly `q − fee` into a temporary account owned
   by E, pays the Bound fee (0.5%), and only E and that account are given to the one untrusted
   instruction (Jupiter's swap). After the swap, Bound checks that at least the minimum output
   arrived, then closes the temporary accounts back to W.
3. Before the wallet opens, the **verifier** checks the exact bytes against 7 rules (below).
4. The wallet signs first with `signTransaction` (no send). Bound checks that the returned message is
   byte-for-byte the verified one with a valid W signature. Only then does E add the last required
   signature and Bound sends it.

If anything fails, nothing is signed or the whole transaction reverts. There is no "continue anyway".

| Rule | Guarantee |
| --- | --- |
| R6 | Only W and E sign; W pays; what the wallet returns is exactly what was verified. Because W never appears in the swap, W's signature is never available to it: this is what makes the other rules sufficient |
| R1 | W and W's token accounts (except the output account) never reach the external program, including through lookup tables; nor do Bound's fee accounts |
| R2 | Every trusted instruction matches an exact template: amounts, accounts, order. No `Approve`, `SetAuthority`, stray transfers or closes. The output account's delegate is revoked before the swap, and the minimum output is checked after it. The fee is at most 1% |
| R3 | E and its accounts are fresh |
| R4 | The network fee paid by W is capped (never above 0.001 SOL) |
| R5 | One transaction within size limits; every temporary account is closed |
| R7 | Input and output are classic SPL tokens; intermediate Token-2022 hops may not run transfer hooks or have a permanent delegate |

## Repository

```text
bound/
├── packages/
│   ├── core/       intent → policy, compiler, constants (pure, no network)
│   ├── verifier/   the 7 rules and the certificate (pure, no network, independent of the compiler) + tests
│   ├── solana/     chain snapshot, simulation, send/confirm, ephemeral key
│   └── jupiter/    Jupiter Swap API V2 client, prepare → finalize pipeline, route repair
├── apps/web/       Next.js dApp, CSP proxy, stateless API routes (/api/rpc, /api/jupiter/*, /api/token-icon, /api/status)
├── tests/
│   ├── integration/mainnet.ts   T4 (30 pairs, v0 + v1), T1 runtime attacks and T5 minimum output, simulated on mainnet
│   ├── integration/large.ts     T7: growing sizes up to about $10M — there is no cap per swap
│   ├── cpi/                     T6: a malicious swap program (Rust) executed against the protected transaction in a real Solana VM
│   └── e2e/                     browser tests (Microsoft Edge via Playwright)
└── spikes/         phase 1 prototype and the wallet test pages (mainnet + devnet)
```

The verifier (`packages/verifier`, `@bound/verifier`) imports only `@solana/kit`, the token program
client and Bound's constants and types, never the compiler or the policy builder, and takes its
limits from `constants.ts`; a test enforces all of it. After a transaction passes every rule it
issues a certificate bound to the message's SHA-256, which the page shows before signing.

Bound supports any token pair that Jupiter can route and Bound can safely isolate. It keeps no
customer, wallet or transaction database; hosting and RPC providers keep their own operational
logs.

## Requirements

- Node.js 22.18 or newer (the scripts run TypeScript directly)
- For the browser tests: Microsoft Edge (preinstalled on Windows)

## Commands

```bash
npm install
npm test                  # unit, mutation (M1–M16), audit regression, proxy and property tests
npm run test:fuzz         # property tests with 100,000 runs each
npm run typecheck
npm run integration       # mainnet simulation: T4 + T1 + T5 (nothing is signed or sent)
npm run cpi               # T6: build the malicious program and run it (Linux or macOS)
npm run build             # production build of the dApp
npm run start -w @bound/web   # serve it on http://localhost:3000
npm run e2e               # browser smoke test against http://localhost:3000
```

## Configuration

Copy `apps/web/.env.example` to `apps/web/.env.local`.

Fixed at build time (compiled into the page, so the server cannot change them afterwards):

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_BOUND_TREASURY` | — | Fee wallet. Empty = test mode, no fee. Pre-create its token accounts for the tokens you charge in: a swap whose input token has no treasury account is fee-free |
| `NEXT_PUBLIC_BOUND_FEE_BPS` | 50 | 0.5%. The verifier refuses more than 100 (1%) |

Server only (never sent to the browser):

| Variable | Default | Meaning |
| --- | --- | --- |
| `RPC_URL` | public mainnet RPC | Solana RPC (a paid provider is recommended) |
| `RPC_URL_SECONDARY` | — | Second RPC to cross-check lookup tables |
| `JUPITER_API_KEY` | — | Optional; keyless access has lower limits |
| `BOUND_MAX_USD_PER_SWAP` | unset | Optional cap per swap in USD. Unset means no limit, the intended setting: the guarantee does not depend on the amount. While a cap applies, tokens without a USD price are blocked |
| `BOUND_DISABLED` | 0 | Kill switch: `1` makes the server refuse new swaps |
| `BOUND_CLIENT_IP_HEADER` | `x-vercel-forwarded-for` | The one header your ingress overwrites with the client address (Cloudflare: `cf-connecting-ip`). The app's rate limit is per instance; add a rule in the hosting firewall too |
| `BOUND_EXCLUDE_DEXES` | `HumidiFi,Pump.fun Amm` | DEXes that charge the taker persistent rent |
| `BOUND_MAX_NETWORK_FEE_LAMPORTS` | 200000 | F_max, capped at 1,000,000 by the verifier |

## Scope of v0.1

Protected: authority over the wallet and everything in it except the approved amount, and the
minimum output the user accepted (never below the quote minus 0.5% slippage), which Bound checks on
chain. If the price moves further before signing, Bound asks instead of lowering it.
Not in scope: price movement and MEV within that tolerance, the value of the token you buy,
approvals granted elsewhere before, phishing sites that do not use Bound, Token-2022 input and output
tokens.

See `SECURITY.md` for the threat model, `AUDIT.md` for the audit brief (with the fixes from the first
review), `AUDITIMI.md` for the engineering-audit brief in Albanian and `TESTIMI.md` for the manual
test guide.
