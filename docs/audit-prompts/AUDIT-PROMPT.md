# Master prompt: full audit of Orientim Protected Swap

You are auditing **Orientim Protected Swap**, a non-custodial Solana swap guard, end to end: the web
app, the verifier, the transaction pipeline, the agent API and the agent skill, and every external
system they touch. The owner wants **full control**: find every hole, including the ones nobody has
asked you about.

Work in this order and do not skip ahead:

1. **Research first.** Independently establish how each external system actually behaves today
   (September 2026), from primary sources.
2. **Then audit the code against that research.** For every assumption Orientim makes about an external
   system, check whether the research confirms it, refutes it, or leaves it unproven.
3. **Then run the scenarios and hunt.** Walk the scenario matrix, think like every attacker listed
   here and any this document forgot, and look for what we have not seen.

Our documents (`AUDIT.md`, `SECURITY.md`, `API-AGJENTET.md`, `AGENT-API.md`, `README.md`) are
**claims to test, not facts.** Where a document and the code disagree, the code is what runs;
report the disagreement. Some sections of `AUDIT.md` are historical and their test counts are out
of date: the current state is `main` and `npm test`.

---

## 0. Rules of engagement

- **Evidence over opinion.** Every finding needs one of: a failing test or proof of concept, a
  simulation on mainnet state, a quoted line of our code plus a quoted primary source, or a precise
  argument a reader can check. Mark each claim **verified** (you ran or read it), **sourced** (a
  primary source says so) or **inferred** (reasoning only).
- **Primary sources.** Program source code on GitHub or verified on chain, official docs, SIMDs,
  release notes, changelogs, explorers. Blog posts and forums only as leads. Cite a URL and a date
  for every external fact; say when you could not confirm something.
- **Currency.** Solana, Token-2022, Jupiter, Pump.fun and wallets changed in 2025–2026. Check what
  is deployed now, and whether programs Orientim depends on are upgradeable and by whom.
- **Safety.** Do not sign or send mainnet transactions with real funds, and do not load or attack
  third-party infrastructure (no load tests against Jupiter, RPC providers or wallets). Simulation
  on mainnet state (`simulateTransaction`, `sigVerify: false`) and local VMs (litesvm, a local
  validator) are fine. Never put a private key or API key in a report.
- **Don't stop at the first answer.** When a check passes, ask what it assumes, and whether that
  assumption holds in every variant (A/B/C), both transaction versions (v0/v1), both token programs,
  the page and the agent API.

---

## 1. What Orientim is, and what it promises

A swap page and an agent API for Solana. Jupiter chooses where to trade; Orientim decides what authority
that trade gets. Jupiter's swap instruction never receives the user's wallet **W**: it receives a
one-time key **E** and temporary token accounts of E holding exactly the approved amount. W signs
first, Orientim verifies what W returned byte for byte, and E signs last. There is no Orientim program on
chain.

The guarantee (`SECURITY.md`, `AUDIT.md` section 1), for every transaction Orientim builds:

1. The external instruction can move at most `q − f` of the input token (`q` the amount entered,
   `f` Orientim's fee), plus, only on routes that open an account in E's name (Pump.fun), exactly the
   rent measured in simulation, capped at 0.005 SOL.
2. It never receives W or any token account of W except the output account `W_out`, whose delegate
   is revoked first; a `W_out` with a close authority is refused.
3. The transaction grants no new authority over W's assets.
4. The user receives at least the minimum they accepted, never below the quote less 0.5% (3% on a
   Pump.fun bonding curve), enforced on chain by a trusted self-transfer check after the swap; for a
   token output it is `balance(W_out) ≥ b0 + minOut`, with `b0` read from the RPC at prepare time.
   Jupiter's own threshold is a second floor.

Load-bearing rule: **R6** (signers are exactly {W, E}, W pays). R1 keeps W out of the external
instruction, so W's signature is never available to it. The verifier rules R1–R7 are in
`AUDIT.md` section 5 and `packages/verifier/src/verify.ts`.

Transaction variants: **A** SPL→SOL, **B** SOL→SPL, **C** SPL→SPL (`AUDIT.md` section 3).

### Decisions the owner made on purpose

Challenge any of these if you have a new argument, but don't report them as oversights:

- **No on-chain program** (decision A / D2). The fee for agents is enforced by Orientim signing last
  as E, not by a program.
- **Fee:** 0.2% in the input token, compiled in at build time; the verifier refuses above 1%. The
  swap is fee-free when the treasury has no account for the input token (D16). Orientim never waives
  its fee automatically to make a route fit.
- **No cap per swap**; the real limits are the route and one transaction (64 accounts, 1232 bytes
  for v0). A swap is never split across transactions.
- **One RPC provider** (Helius); the second-RPC cross-check was removed.
- **Slippage:** 0.5%; 3% only when the route contains the label `Pump.fun` **and** the curve program
  `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`. The user is asked when the protected route is ≥ 0.5%
  below the unrestricted one; refused past 50%. Price impact: warning from 1%, question from 5%.
- **Excluded DEXes:** HumidiFi (per-taker rent too high to lose on every swap). Tokens whose issuer
  delegate is off-curve (e.g. xStocks) are refused.
- **v1 transactions** only behind `NEXT_PUBLIC_ORIENTIM_ENABLE_V1=1` (Phantom declares `legacy, 0`).
- **Build-ahead:** the page prebuilds the swap while the user reads the quote. It is reused only
  under 20 s old, for the same inputs, with `W_out`'s balance unchanged.
- **Agent API:** E derived as Ed25519 from HMAC-SHA256(server secret, ticket nonce) (option (a) of
  `API-AGJENTET.md`). No SDK, no MCP; a skill instead. Finalize sends once and returns the fully
  signed transaction; the agent confirms it on its own RPC.

### Already known and open

Verify these, but they are not new findings:

- **Wallets:** no real-wallet test with Phantom or any other wallet yet. Whether Phantom modifies
  the message (Lighthouse) with `signTransaction` and a second unsigned signer is unknown.
- **Operations:**
  - treasury multisig and fee accounts;
  - branch protection (the repository is private);
  - firewall rate limits across instances (BR-09);
  - monitoring upgrades of the token programs and Jupiter (BR-13).
- **Verification:**
  - `@orientim/verifier` is not published, so an agent cannot yet verify independently;
  - the release digest is published only to a private repository.
- **Agent API:** built before the auditor answered `API-AGJENTET.md` section 9. **Answer those seven
  questions** as part of this audit.

---

## 2. The repository

`github.com/intopic/bound`: TypeScript monorepo, Node 24, `@solana/kit` 8, Next.js 16 (Turbopack).

| Path | What |
| --- | --- |
| `packages/core` | Constants and ceilings, policy (intent → accounts, fee, variant), compiler (v0/v1) |
| `packages/verifier` | Independent verifier: `parse.ts` (exact instruction shapes), `verify.ts` (R1–R7), `wallet.ts` (R6 on the wallet's return), `certificate.ts`, Token-2022 extension parsing |
| `packages/solana` | Snapshot reads, lookup tables, simulation, `sendAndConfirm`, `sendOnce`, retrying RPC transport, `createEphemeral` |
| `packages/jupiter` | Jupiter client; `swap.ts`, the pipeline: quote, route levels, rent probe (`takerRent`), repair, simulate, verify, fee check, `countersignProtectedSwap`, `finalizeProtectedSwap`, `revertedOnPrice` |
| `apps/web/components/SwapApp.tsx` | The page's whole signing flow and every message the user sees |
| `apps/web/lib/client/*` | Wallet Standard glue, token facts, swap lock (localStorage), history, received amount |
| `apps/web/lib/server/*` | RPC relay (method allowlist, send limit, kill switch), Jupiter relay (parameter allowlist, no `payer`), icon proxy, rate limits, script integrity |
| `apps/web/lib/server/agent/*`, `apps/web/app/api/v1/*` | Agent API: `prepare`, `finalize`, sealed tickets, derived E, API keys as hashes |
| `apps/web/proxy.ts` | Per-request CSP nonce |
| `skills/orientim-protected-swap/` | The agent skill: `SKILL.md` and `examples/swap.ts` (`checkPrepared`, `confirm`) |
| `tests/cpi` | T6: a malicious swap program in litesvm (CI only) |
| `tests/integration` | Mainnet-state simulations: T4/T1/T5, large amounts, transfer-fee tokens, Pump.fun (`pump.ts --market amm/curve`), thresholds |
| `tests/e2e` | Edge browser tests: `smoke.ts`, `busy.ts` |
| `tools/` | Build digest, live-site check, agent keys |
| `.github/workflows` | CI (tests, reproducible build ×2, fuzz), T6, release digest, live check |

Run: `npm ci && npm run typecheck && npm test`; `npm run test:fuzz`; `npm run integration`;
`node tests/integration/pump.ts --market curve`; `npm run build && npm run start -w @orientim/web`
then `node tests/e2e/smoke.ts` and `node tests/e2e/busy.ts`.

---

## 3. Phase 1: research every boundary

For each boundary, answer the questions **and** add the ones we did not think of. Record for each
external behaviour: what it is today, the source, and whether it is stable, versioned or upgradeable.

### B1. Solana runtime and transactions

- **Signers and CPI.**
  - Exact rules for signer and writable privilege in CPI.
  - Can any program, via CPI, use a signature or account it was not passed?
  - Can the same account appear twice with different privileges, statically or through a lookup table?
- **v0 and v1.**
  - v0 messages and address lookup tables. Can a lookup table change between the snapshot and
    execution: extension, deactivation, closing, reuse of the address?
  - The v1 transaction format, live on mainnet since 15 September 2026: its message config
    (compute limit, priority fee, loaded-accounts data size), size limits, account limits.
  - Which SIMDs define v1, and what changed?
- **Lifetime.**
  - Blockhash expiry, `lastValidBlockHeight`.
  - Durable nonces: could a wallet, or anyone else, turn a Orientim transaction into a durable-nonce
    one and hold it indefinitely? What would that break?
- **Fees and rent.**
  - Priority fees, and how `getRecentPrioritizationFees` relates to landing.
  - Compute unit accounting.
  - Current rent-exemption values and any 2025–2026 changes to rent.
- **ATA program.**
  - `CreateIdempotent` on an existing account: with the wrong owner, with the wrong mint, or frozen.
  - ATA creation for Token-2022 mints with account-side extensions (size, required extensions).
- **System program.**
  - Transfers to an account that does not exist, or below rent.
  - `SyncNative` semantics.
- **Recent changes.** Any runtime feature activated in 2025–2026 that changes what a malicious
  program in a CPI can do: account reallocation, lamport movement, direct mapping, loader v4.

### B2. SPL Token and Token-2022

- **The floor check.** The self-transfer semantics it rests on: does `TransferChecked` from an
  account to itself still check the balance before short-circuiting, in **both** programs, in the
  deployed versions today? Could an upgrade change it? Who holds the upgrade authority?
- **`CloseAccount`.** With non-zero balance, with withheld transfer fees, on native (WSOL) accounts,
  with a close authority, when frozen.
- **Token-2022 extensions, every one of them, including any added in 2025–2026:**
  - transfer fee, transfer hook, permanent delegate, default account state;
  - confidential transfer and confidential transfer fee;
  - memo transfer, CPI guard, immutable owner, non-transferable;
  - interest-bearing, scaled UI amount, pausable;
  - metadata and group pointers, token metadata, group/member, mint close authority.

  For each: what can it do inside our transaction, and to `W_out`, `E_in`, `E_out` and the
  intermediates? Compare with our allowlist (`unsupportedExtension`) and R7.
- **Account-side extensions on accounts we touch.**
  - **CPI guard** on the user's `W_in` or `W_out`: we transfer from `W_in` with W's signature at top
    level, not in CPI. Is that always true?
  - Memo-required, frozen accounts.
  - What does each do to our instruction list?
- **Permanent delegate** (section 0j, BR-05). Can it act inside a transaction whose signers are
  {W, E}, via a program-owned multisig, a PDA, or a reassigned delegate?
- **Withheld transfer fees.** Harvest ordering before `CloseAccount`, and on intermediate hops.

### B3. Jupiter

- **The Swap API v2 `/build` we call.** Every parameter we send and every field we use or ignore:
  `taker`, `destinationTokenAccount`, `wrapAndUnwrapSol=false`, `slippageBps`, `maxAccounts`,
  `excludeDexes`, `otherAmountThreshold`, `priceImpactPct`, `routePlan`, `setupInstructions`,
  `cleanupInstruction`, `otherInstructions`, `addressesByLookupTableAddress`.
- **What we ignore.** We use only the swap instruction and the lookup-table addresses, and rebuild
  setup and cleanup ourselves (D6). Does Jupiter ever put something load-bearing in
  `otherInstructions` (a token ledger, a tip, an extra signer)? What happens to such routes?
- **The Jupiter program deployed today.**
  - Its instruction variants: `route`, `shared_accounts_route`, exact-out, token ledger, v2 variants.
  - Where the slippage check happens, and exactly what it measures. We treat it as a second floor
    independent of the RPC (BR-01): is that true for every variant, and does it measure the
    destination balance or an internal amount?
  - Error 6001 (`SlippageToleranceExceeded`).
  - Upgrade authority, and recent upgrades.
- **Routes that break our model.** Can any DEX that Jupiter routes through require the taker to:
  - sign for anything beyond E;
  - hold native SOL;
  - own accounts that survive the transaction;
  - receive output into an account we do not close?

  List current DEXes with per-taker accounts or rent (HumidiFi, Pump.fun, others), prop AMMs with
  oracle co-signers, and DEXes whose accounts need W.
- **Keys and limits.** Rate limits and key tiers, 429 semantics and `Retry-After`, and API changes
  announced for 2026 (Ultra, v2 → v3, deprecations).
- **Jupiter's agent tooling** (`developers.jup.ag/docs/ai`: Skills, CLI, Trading MCP). How agents use
  it, how keys are held, and what safety it lacks. Is our skill and API compatible with how
  agents are actually built?

### B4. Pump.fun bonding curve and PumpSwap

- **Deployed programs.**
  - Curve `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` and PumpSwap
    `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`.
  - Their current buy/sell instructions (e.g. `BuyExactQuoteInV2`).
  - Fee configuration, creator fees, volume accumulators (the per-user account whose rent E pays:
    1,346,200 lamports), curve extension (+132,080), and any 2026 changes: Token-2022 mints for new
    coins, new fee or cashback programs.
- **What E pays.** Does anything in these programs take SOL from the taker beyond rent: fees paid
  natively, tips, creator vaults? We fund E with exactly what simulation says it spends, cap 0.005 SOL
  (`measureTakerRent`). Is simulation a faithful predictor? Could the amount differ at execution
  (another buyer created the account first; a fee changed between simulation and landing)? Then what?
- **Migration.** A curve that completes mid-route or between quote and landing. Our 3% rule keys
  on the label and program: can a route be curve-priced without containing the program, or the
  reverse?
- **The unwrap path.** Pump's buy unwrapped E_in's WSOL into E on 22 September and not on 23 September.
  Which path is current? Does either leave lamports or accounts under E after the transaction?
- **Rug-shaped risks.** Creator actions, freeze or mint authority, fake metadata. How the page and
  the agent API present them.

### B5. Wallets

- **Wallet Standard.** `solana:signTransaction` with a transaction that has a second, unsigned signer
  (E). Behaviour of **Phantom, Solflare, Backpack, Glow**, and the in-app browsers on iOS and
  Android. Do they:
  - modify the message: Lighthouse or other assertions, compute budget, priority fee?
  - refuse partially signed transactions or extra signers?
  - show a "malicious" warning (Blowfish or similar)?
  - declare and truly support v0 and v1?
  - add their own fees?

  What does each change do to R6 and to the user?
- **Hardware and special wallets.**
  - Ledger through these wallets: message size, blind-signing requirements for v0 with lookup tables.
  - Multisig and smart wallets (Squads, Swig), embedded wallets (Privy, Turnkey, Crossmint),
    Mobile Wallet Adapter. Which can sign first and hand back a partially signed transaction, and
    which break our flow?
- **Browser capability.** WebCrypto Ed25519 (non-extractable `generateKey`) support by browser and
  version, including iOS Safari and wallets' embedded webviews. What share of users can't create E?

### B6. RPC

- **The relays.** Helius (and the public endpoint): `simulateTransaction` with
  `replaceRecentBlockhash` and `accounts`; `sendTransaction` preflight and `maxRetries: 0`;
  `getSignatureStatuses` with and without history; `getFeeForMessage`; `getRecentPrioritizationFees`.
  Rate-limit responses and their shape.
- **A lying or lagging RPC.** What can it make Orientim do, read by read? We tabulate this in `SECURITY.md`
  ("One RPC provider"): is the table complete and correct? In particular `b0` (BR-01),
  lookup tables for v0, owners for R1, mint data for R7, the simulation used for `takerRent`.
- **Lag.** Commitment levels and staleness between reads in one prepare. Can the snapshot and the
  simulation disagree in a way that matters?

### B7. Hosting and the web page

- **Vercel and Next.js 16.** Serverless or fluid functions and their durations; `NEXT_PUBLIC_*`
  inlining; `proxy.ts` (formerly middleware); route segment config; how the ingress sets
  `x-vercel-forwarded-for` and whether a client can spoof it; per-instance memory (our rate limits,
  Jupiter cool-down); the Vercel firewall.
- **Page integrity.**
  - CSP with nonce and `strict-dynamic`; SRI coverage (7 of 8 scripts).
  - Reproducible builds and the release digest (`tools/build-digest.ts`, `tools/check-live.ts`).
  - What a compromised deploy, DNS or CDN can still do.
- **Supply chain.** Every dependency that runs in the page (`SECURITY.md` counts them): install
  scripts, maintainers, recent incidents in the Solana JS ecosystem.
- **Browser storage.** The per-token swap lock and history in localStorage: private windows, several
  devices, storage cleared mid-swap.

### B8. Agents, the API and the skill

- **How agents are built today.**
  - Frameworks: Solana Agent Kit, ElizaOS, GOAT, Coinbase AgentKit, Claude and OpenAI agents with
    tools or skills, the Agent Skills format and `npx skills`.
  - How they hold keys: local keypair, env var, remote signers with policy engines (Turnkey, Privy,
    Crossmint, Fireblocks, AWS KMS).
  - Can those signers partially sign a v0 message that has another signer? Do their policy engines
    let a user restrict signing to Orientim's transactions?
- **The API as a protocol.**
  - Authentication and key hashing.
  - The ticket: HMAC, `kid`, nonce, key id, owner, message hash, `lastValidBlockHeight`.
  - Replay across keys and across time; idempotency.
  - E derivation and the secret's rotation.
  - Serverless statelessness; limits per instance.
  - Error semantics.
  - Whether "Orientim signs only the hash it sealed" really enforces the fee, and every way around it:
    - the "free template": prepare, then rebuild without Orientim;
    - a stolen secret;
    - a stolen API key.
- **Custody and regulation.** Does holding E's derivation secret, and co-signing other people's
  transactions, change Orientim's custody or regulatory position? Research, not legal advice; say
  which jurisdictions you looked at.
- **The skill.**
  - Is `SKILL.md` correct, complete and safe for an autonomous agent?
  - Prompt injection through fields an agent will read: `message`, `route` labels, token names,
    error text. A compromised server or a hostile token could put instructions there.
  - Does `checkPrepared` catch a malicious server? What does it not check that an agent needs:
    independent instruction verification, the programs invoked, `W_out`'s owner?
  - Is the confirm loop correct?

### B9. Market, MEV and economics

- Sandwiching within 0.5% or 3%, Jito bundles and tips, and whether a landing strategy matters for
  users of a shared relay.
- Route quality under our constraints: fewer accounts, exclusions, and one transaction.
- The comparison between the protected and the unrestricted route: both from the same aggregator.
- Fee economics at 0.2% against current competitors: wallets' in-app swap fees, trading bots and
  terminals, Jupiter's own fees.

For each boundary, finish with: **"What Orientim assumes here, and whether it holds."**

---

## 4. Phase 2: audit the code against the research

Map every assumption from Phase 1 to the code that relies on it, and verify it. At minimum:

| Area | Where | What to establish |
| --- | --- | --- |
| **Isolation** | `packages/verifier/src/verify.ts` R1–R7, `parse.ts` | Every account and instruction shape an honest compile produces passes; everything else fails. Look for an instruction the parser accepts too loosely, an account role it does not check, a lookup-table path that hides an account, a Token-2022 extension it misreads, an ordering it does not enforce. |
| **The floor** | `compiler.ts`, `swap.ts` (`strictMinimumOutput`, `routeFloor`, `quotedMinimum`, `slippageFor`, `isCurveRoute`, `acceptedMinOut`), `SwapApp.tsx` | Is there any path, on the page or the API, where the enforced minimum ends below what the user or agent accepted, or where they sign without having seen it? |
| **`b0`** | `swap.ts` snapshot, build-ahead reuse (`outputBalanceUnchanged`), `swapLock.ts` | Every way `W_out` can change between the read and execution, and what each does to guarantee 4. |
| **Rent and E** | `measureTakerRent`, `withTakerRent`, R4, R6 | Can a route make E end with lamports or accounts that a third party later benefits from? Can the funding exceed what is shown? |
| **Fee** | policy, `feeFor`, `treasuryCannotReceive`, fee-account existence, `ORIENTIM_API_FEE_BPS` | Any path to a fee above what the user saw, to the wrong destination, or silently dropped. |
| **Wallet return** | `verifyWalletReturn`, `countersignProtectedSwap` | Byte identity, signature check, E slot empty. Any wallet behaviour from B5 that should pass but fails, or the reverse. |
| **Send and outcome** | `sendAndConfirm`, `sendOnce`, `refusedBeforeBroadcast`, `revertedOnPrice`, `outcomeNotice` | "No funds moved" is said only when proven. Are the proof boundaries sound for Helius and for the public RPC? |
| **Relays** | `rpcProxy.ts`, `jupiterProxy.ts`, `iconProxy.ts`, `rateLimit.ts` | Allowlists, SSRF, header trust, body limits, the kill switch, and what a malicious client can make the server do or pay for. |
| **Agent API** | `apps/web/lib/server/agent/*` | Every item in B8, plus input validation, error leakage, timing attacks, key id collisions, rate limits across instances, and `maxDuration`. |
| **Skill** | `skills/orientim-protected-swap/*` | Every item in B8. Run `examples/swap.ts --dry-run` against a local build. |
| **Page** | `SwapApp.tsx` | Every message the user sees: true, complete, and shown before signing when it matters. Costs, warnings, price impact, route gap, curve slippage, token tax, delegate removal, rent. |
| **Build and CI** | workflows, `tools/*` | What a malicious pull request or dependency could change without a test failing. |

Also check whether the tests test what they say: mutation-test a few rules (break R1, R5, R6, the
floor) and confirm a test fails each time.

---

## 5. Phase 3: scenarios

Walk through each one, on the page **and** through the agent API where it applies. For each, say what
the system does, what the user or agent sees, whether the guarantee holds, and what a professional
system would do.

**Tokens and routes**

- SOL↔USDC; USDC→USDT; a tiny amount (dust, below rent); a huge amount (no route fits).
- A Token-2022 token with a transfer fee, as input and as output.
- PYUSD or USDG (issuer delegate); a token with a transfer hook; a token frozen by default.
- A Pump.fun curve buy and sell; a curve completing mid-swap; a PumpSwap buy with first-time rent.
- A route through an intermediate Token-2022 mint.
- A token with no Jupiter route; a token that only trades on HumidiFi.

**The user's accounts**

- `W_out` missing, existing, with a delegate, with a close authority, frozen, with a CPI guard,
  memo-required.
- `W_in` with a delegate.
- A wallet short of SOL for rent and fees.
- A treasury with no account for the input token; a SOL fee into a treasury wallet that does not
  exist yet.

**Wallets**

- Phantom desktop and mobile, Solflare, Backpack, Ledger via Phantom.
- A wallet that modifies the message; one that signs and sends by itself; one that returns an
  unsigned transaction; one that takes minutes.
- The user switches account mid-flow.

**Network and services**

- Jupiter answers 429, times out, returns a malformed or malicious route, or quotes another pair.
- The RPC answers 429, lies about `b0` or lookup tables, or lags.
- Congestion (priority fee capped by R4), expiry, a transaction seen but not confirmed.
- The kill switch flipped mid-swap.

**Concurrency**

- Two tabs; two devices on the same wallet.
- **An agent calling prepare twice in parallel for the same owner and output token.** The API has
  no per-token lock like the page's (decision A). Does the second swap's `b0 + minOut` check count
  the first swap's output, and what then protects the agent? We suspect a gap here: confirm or refute.
- Build-ahead racing the click.
- Two finalizes of one ticket; finalize after expiry; finalize with another API key.

**Adversarial**

- A malicious DEX or pool inside the route.
- A compromised Jupiter; a compromised Orientim server (page and API); a compromised dependency.
- A phishing clone of Orientim.
- A malicious agent trying to drop the fee.
- A third party with a stolen API key, a stolen ticket, or the stolen server secret.
- A hostile token whose name or metadata carries instructions for an agent.

Add every scenario we forgot.

---

## 6. Phase 4: hunt for what nobody asked about

With the research and the scenarios done, spend real time on the unknown unknowns:

- **Assumptions.** List every assumption, stated or implicit, that the guarantee rests on. For each,
  ask what happens if it is false.
- **Parser edges.** Look for places where two components parse the same bytes differently: our
  parser against the runtime, our decimals against the mint, our route labels against the programs,
  a wallet against the Wallet Standard.
- **Time.** Look for anything that depends on timing: blockhash windows, the 20-second build-ahead,
  the 45-second question timeout, lock expiry, ticket lifetime, secret rotation, rate-limit windows.
- **Upgrades.** Look for anything that depends on a program or API not changing: Token, Token-2022,
  ATA, Jupiter, Pump, Lighthouse, wallets. Who can change each, and how would we notice?
- **Money in every direction.** Follow every lamport and every token unit in each variant,
  including rent, withheld fees, dust left in any account, the route rent and the priority fee, and
  prove none can end anywhere unintended.
- **Degradation.** For each feature ask how it degrades under load, and whether it degrades safely
  (fails closed) or silently (fails open).
- **Words.** For each message the user or an agent reads, ask whether it can be false.

---

## 7. What to deliver

1. **Research report**, per boundary B1–B9: the facts, with sources and dates, and "what Orientim
   assumes here, and whether it holds".
2. **Compatibility matrix**: one row per external behaviour our code depends on:
   - the external behaviour;
   - the source;
   - our assumption;
   - the file and line;
   - the verdict: holds, broken or unproven;
   - the test that proves it, or the one to add.
3. **Findings**, most severe first. Each with:
   - an ID;
   - a severity: Critical (loss of user funds beyond the guarantee), High (guarantee or fee
     broken under realistic conditions), Medium, Low or Info;
   - the boundary;
   - the preconditions;
   - a proof of concept or a precise argument;
   - the impact on guarantee items 1–4, the fee, availability or what the user is told;
   - a recommended fix;
   - the regression test to add.
4. **Scenario table** from Phase 3, with the observed or reasoned behaviour and a verdict for each.
5. **Answers to the seven questions** in `API-AGJENTET.md` section 9, and to section 9 of `AUDIT.md`.
6. **Documentation errors**: every claim in our documents that is false, stale or too strong.
7. **What we should have asked**: the questions this prompt missed.
8. **Pre-launch checklist**, ordered: what must change before real users, and what can wait.

Be direct. If something is fine, say so briefly and move on. Spend the space on what is not.
