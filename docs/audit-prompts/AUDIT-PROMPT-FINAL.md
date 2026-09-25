# Master prompt: research and compatibility audit of Bound Protected Swap

You are a senior Solana engineer. Before Bound Protected Swap meets real users and real agents, we
want a **research audit, not a test run**. We have already tested our code heavily (the list is in
section 2). What we have not done well enough is look outward: at how Solana, wallets, tokens,
Jupiter, Pump.fun, RPC providers and agents actually work today (September 2026), and then read our
code against that and ask: **will this work, for everyone it should work for, and did we leave
anything out?**

Your job, in this order:

1. **Study the outside world.** How a swap transaction is built, signed, landed and confirmed today.
   How wallets treat a transaction with two signers. Which tokens and token features exist and are
   traded. How Jupiter and Pump.fun behave and change. How prices and blockhashes go stale, and how
   good products refresh them. How agents trade and hold their keys. How others solve the problem
   Bound solves.
2. **Read our code against what you learned.** For each area, is Bound compatible? Will it work
   reliably? Where will it break, refuse, or lose a user or a fee?
3. **Find what we missed.** Situations, tokens, wallets, behaviours or upcoming changes that the code
   and the documents do not account for.
4. **Suggest.** Better and simpler ways to do what we do, where your research supports them.

---

## 0. Rules

- **Do not run anything.** No `npm install`, no tests, no builds, no scripts, no local servers, no
  simulations, no API keys, no transactions. Do not write test files. Reading the repository
  (cloning it is fine) and reading public sources is the whole job.
- **If you think something needs a test,** describe the test precisely: what to run, on what state,
  and what result would prove or disprove your concern. We will run it.
- **Primary sources first:** official documentation, SIMDs and the Solana repositories, program
  source and IDLs, changelogs and release notes, wallet and SDK repositories and their issues,
  explorers (looking up an account or a transaction counts as reading). Blogs, forums and social
  posts are leads, not evidence.
- **Label every statement:**
  - **sourced:** a primary source says so; give the URL and the date you read it;
  - **in the code:** give `file:line`;
  - **inferred:** your reasoning only; say what would confirm it.
- **Say plainly what you could not confirm.** An honest "unknown" is more useful to us than a guess.
- **Our documents are claims, not facts:** `SECURITY.md`, `AUDIT.md` (section 0r lists the latest
  changes), `AGENT-API.md`, `API-AGJENTET.md`, `README.md`,
  `skills/bound-protected-swap/SKILL.md`. Where a document and the code disagree, the code is what
  runs: report the disagreement.
- Earlier audits were run by a session of the same model that wrote the code, so they were not
  independent. Do not assume they were right.

---

## 1. What Bound is

Jupiter chooses where to trade; Bound decides what authority that trade gets.

- The swap instruction receives a one-time key **E** and temporary token accounts holding exactly
  the approved amount, never the wallet **W**.
- W signs first with `signTransaction` (no send). Bound checks that what W returned is byte for byte
  what it verified, and E signs last.
- There is no Bound program on chain. The fee is 0.2% of the input, paid in the input token, inside
  the same transaction.
- The guarantee is in `SECURITY.md` ("Guarantee"). The verifier's seven rules are in `README.md`;
  the load-bearing ones are R6 (the signers are exactly W and E) and R1 (W never inside the external
  instruction), in `packages/verifier/src/verify.ts`.
- Three shapes: A (token → SOL), B (SOL → token), C (token → token). Transactions are v0, or v1
  behind a flag.
- Two ways in: the page (`apps/web`), and the agent API with its skill (`/api/v1/prepare` and
  `/api/v1/finalize`; the agent's own verifier in `skills/bound-protected-swap`).

**Recent changes** (`AUDIT.md` section 0r), each one worth reading closely:

| Area | What changed |
| --- | --- |
| Jupiter | The verifier reads the arguments of Jupiter's `route_v2` and `shared_accounts_route_v2` and refuses any other Jupiter instruction, a platform fee, positive slippage, a tolerance above 0.5% (3% with the Pump curve program), a quote below the minimum, or more input than E's account holds |
| Pump.fun | The per-buyer account each Pump market opens (PDA `["user_volume_accumulator", E]`) is closed at the end with Pump's `close_user_volume_accumulator`, and its lamports go on to W |
| Agents | The skill bundles the full verifier and checks every swap on the agent's own RPC before signing. The API seals W's output balance in the ticket and re-checks it at finalize |
| Relays | `/api/rpc` sends and simulates only Bound-shaped transactions |
| Outcomes | "Failed" only at confirmed; "expired" only against the finalized block height |
| Fees | Network-fee limit 0.0005 SOL by default, never above 0.001 SOL |
| Lookup tables | Bound's own accounts are never loaded from a lookup table |

**How the page keeps prices and transactions fresh today** (`apps/web/components/SwapApp.tsx`, top
of file):
- The quote refreshes every 20 s, 3 times on its own; after that the user must ask. A quote older
  than 45 s cannot be used.
- The swap is built ahead of the click. That build is used only if it is less than 20 s old and
  nothing changed.
- If a question to the user (price moved, costs) stays open more than 15 s, the swap is rebuilt.
- When Jupiter or the RPC answer "busy", the page waits 30 s before building ahead again.
- The minimum is never lowered silently. If the market moved beyond the tolerance, the user is asked.
- Bound reads the blockhash itself (`getLatestBlockhash` at confirmed) at the end of prepare. Its
  lifetime ends the swap; there is no re-send with a new blockhash.
- Agents get a ticket from `prepare` that is valid until the blockhash expires. They must verify,
  sign and `finalize` within that window.

**Decisions made on purpose.** Challenge them only with a new argument from your research:
- no on-chain program;
- the fee inside the transaction. The swap is fee-free when the treasury has no account for the
  input token, and the fee is never waived to make a route fit;
- no cap per swap, never split across transactions;
- one RPC provider;
- slippage 0.5%, and 3% on a Pump.fun bonding curve;
- HumidiFi excluded;
- v1 transactions behind a flag;
- a skill for agents, not an SDK or an MCP server.

**Rules the owner has set:**
- every Solana token should be swappable, unless Bound cannot isolate it safely;
- the page stays simple;
- Bound is authority protection, not a DEX or a router.

**Known and open.** Not new findings, but tell us if your research changes them:
- no real-wallet test yet;
- Jupiter and Helius on keyless or public tiers during development;
- treasury multisig, firewall rules and upgrade watching not done yet.

---

## 2. The repository

`github.com/intopic/bound` at `main`: TypeScript, `@solana/kit`, Next.js 16, deployed on Vercel.

| Path | What |
| --- | --- |
| `packages/core` | Constants and limits; policy (intent → accounts, fee, shape, route rent and refund); compiler (v0/v1) |
| `packages/verifier` | `parse.ts` (exact instruction shapes), `verify.ts` (the rules, Jupiter arguments, the Pump close), `wallet.ts`, `certificate.ts` |
| `packages/solana` | Chain reads, simulation, send and confirm, retries, the one-time key |
| `packages/jupiter` | Jupiter client; `swap.ts`, the whole pipeline from quote to countersign |
| `apps/web/components/SwapApp.tsx` | The page's flow, refresh logic and every message a user reads |
| `apps/web/lib/server/*` | Relays, rate limits, the agent API (`agent/api.ts`, `ticket.ts`, `config.ts`) |
| `skills/bound-protected-swap` | `SKILL.md`, `examples/swap.ts`, `src/verify.ts` (bundled into `lib/bound-verify.mjs`) |

**Already tested by us. Do not repeat these; read them if useful:**
- about 380 unit, property and mutation tests, plus fuzzing;
- mainnet simulations: 30 token pairs on v0 and v1, runtime attacks, minimum-output checks, large
  amounts, Token-2022 transfer-fee tokens, issuer stablecoins, Pump curve and PumpSwap buys and
  sales, Jupiter's on-chain floor;
- a malicious swap program executed against the real transaction in a Solana VM (CI);
- browser tests of the page, including Jupiter and RPC refusing with 429;
- agent dry runs against the API.

What we have not tested is the outside world we have not thought of. That is what we want from you.

---

## 3. Part 1: study the outside world

For each topic, learn how it works today and answer the questions. Keep the notes short: what we
need to know, with the source.

### A. The Solana transaction today

- How a swap transaction should be built today:
  - v0 and v1 formats;
  - lookup tables;
  - size, account and compute limits;
  - compute budget and priority fees (and how v1 changes them);
  - signer order and the fee payer.
- How transactions land today: leaders, staked connections, Jito and other relays, re-broadcasting,
  what makes a transaction drop.
- Blockhash lifetime in practice, and durable nonces.
- Rent today and the rent changes still to come.
- Every SIMD or feature activated in 2025–2026, or scheduled, that changes how a transaction like
  Bound's behaves: account locking, CPI privileges, duplicate accounts, size, fees, the classic
  Token program's rewrite (p-token), Token-2022 upgrades.

### B. Freshness: how to refresh so neither the user nor Bound loses

This is one of the most important questions for us.

- How long is a Jupiter quote and a built transaction good for, in practice, for different kinds of
  tokens (majors, stablecoins, long-tail, Pump.fun curves)?
- How fast do prices move relative to the refresh intervals in section 1?
- How do Jupiter's own interface, Phantom's swap, Solflare, and other well-built swap products:
  - refresh quotes;
  - handle "price moved";
  - rebuild before blockhash expiry;
  - retry or re-send after expiry?
- What does each way of losing cost, and who pays it?
  - **The user loses:** a failed swap that still pays fees, a stale minimum, too many questions, a
    swap that expires while the wallet is open.
  - **Bound loses:** a swap that never lands (no fee), wasted Jupiter and RPC calls against rate
    limits and credits, a user who leaves.
- What is the right refresh and rebuild strategy for:
  - the page;
  - the build ahead of the click;
  - an agent between `prepare` and `finalize`?
- Should Bound ever re-send with a new blockhash? What is safe, given that W signs a specific
  message?

### C. Tokens

- The classic Token program today, including the p-token rewrite: anything that changes the
  behaviour Bound relies on (transfers, closes, self-transfers, revokes).
- Every Token-2022 extension that exists today, including those added in 2025–2026. For each, what
  it can do during a swap, and whether Bound's allowlist (`AUDIT.md` section 0f, `verify.ts`)
  handles it correctly.
- The tokens people actually trade on Solana today, by volume and by count: majors, stablecoins
  (USDC, USDT, PYUSD, USDG and others), LSTs, memecoins, Pump.fun tokens, tokenized stocks and
  other RWAs, Token-2022 launches. Which of them would Bound refuse, and why? The owner's rule is
  that every token should be swappable, so every refusal needs a reason.
- Account states that matter: frozen, delegated, close authority, memo-required, CPI Guard,
  permanent delegate, default-frozen, pausable, scaled UI amount.

### D. Jupiter

- Swap API v2 `/build` today:
  - what it returns;
  - which instructions and formats it can return (routes, shared accounts, exact-out, token ledger,
    Token-2022 routes, multi-hop);
  - what the fields Bound drops (`otherInstructions`, `setupInstructions`, tips) can carry.
- The on-chain program:
  - the layouts of `route_v2` and `shared_accounts_route_v2` from the deployed IDL or source;
  - how the slippage check is measured;
  - who can upgrade the program and how often it changes.
- The API's direction:
  - deprecations announced;
  - Ultra against the Swap API;
  - rate limits and plans;
  - how Jupiter recommends third parties integrate;
  - whether anything announced would break Bound.
- How Bound would notice a format change before users do. The verifier refuses unknown formats, so
  a change stops every swap.

### E. Pump.fun

- The bonding curve and PumpSwap today:
  - buy and sell instructions;
  - fees;
  - cashback and creator rewards;
  - the fee programs added in 2026;
  - migration from curve to PumpSwap.
- `close_user_volume_accumulator` in both programs:
  - the accounts it takes and what it checks;
  - where the lamports go;
  - whether it can fail or be blocked (an account created earlier by someone else for E, unclaimed
    rewards, cashback coins);
  - whether the upgrade authority can change it.
- Other launchpads with similar per-buyer accounts (Bonk.fun, Raydium LaunchLab, Moonshot, Meteora
  DBC and the like). Does Bound pay or leave behind a similar cost there?

### F. Wallets

- The Wallet Standard today: `solana:signTransaction`, `solana:signAndSendTransaction`, versions,
  v0 and v1 support.
- For each of Phantom (extension and mobile), Solflare, Backpack, Ledger (through a wallet), OKX,
  Glow, Coinbase Wallet and any wallet with real Solana share:
  - Does it sign a transaction that needs a second signature it does not hold, and return it
    unsent?
  - Does it change the message (Lighthouse assertions, added priority fees, reordered
    instructions)? If it does, Bound refuses the swap.
  - What warnings does it show for such a transaction?
- Mobile: Mobile Wallet Adapter, in-app browsers, deep links.
- Embedded wallets (Phantom embedded, Privy, Dynamic, Magic, Web3Auth) and smart or multisig
  wallets (Squads, Swig): which can use Bound, which cannot, and what the page should say.

### G. RPC and confirmation

- What Bound's outcome messages rely on:
  - preflight refusals;
  - `getSignatureStatuses` with and without history;
  - commitment levels and `minContextSlot`;
  - nodes lagging behind load balancers;
  - re-broadcasting.
- Helius specifically: sending, rate limits, credits per method, staked sending.
- What well-built products do to land swaps under congestion, within a fee cap.

### H. Agents

- How agents trade on Solana today: Solana Agent Kit, GOAT, ElizaOS, Coinbase AgentKit, Jupiter's
  agent tooling, Agent Skills and `npx skills`, and others you find.
- How agents hold keys:
  - local keypairs;
  - remote signers and policy engines (Turnkey, Privy server wallets, Crossmint, Fireblocks, cloud
    KMS);
  - agent wallets from wallet companies.

  Can each of them sign one of two signers and return the transaction unsent? Can their policy
  engines express "only sign Bound-shaped transactions"?
- What agent developers expect from a swap API: request and response shapes, idempotency, errors,
  timing.
- Agent-specific risks: prompt injection through token names or metadata, a compromised skill
  bundle, an agent that skips verification.

### I. How others solve the same problem

- Transaction simulation and warnings in wallets (Blowfish-style), Lighthouse assertions, Jupiter's
  own protections, intent and solver systems, delegate and spending-limit approaches (Squads),
  session keys.
- Is there a simpler way to give the same guarantee: the swap can touch only what was approved,
  and the minimum holds? If so, what does it cost, and what does it lose?

---

## 4. Part 2: read the code against the research

For each area, write a short **compatibility table**: what the world does (sourced), what Bound does
(`file:line`), and a verdict. The verdict is one of:
- works;
- works with a limit (say which);
- refuses (say whether that is correct);
- breaks;
- unknown (say what would decide it).

- **Transactions:** does `packages/core` build what the runtime and the wallets expect today, and
  what they will expect after the scheduled changes? Is v1 correct against the final specification?
- **The verifier's rules:** are they complete against what you found? Does the world allow something
  (an instruction, an account state, an extension, a program behaviour) that the rules never
  consider? Are there rules that refuse legitimate swaps for no safety reason?
- **Tokens:** go through the traded tokens you found. For each group: swappable, refused (why), or
  swappable with a condition. Pay attention to Token-2022 and to the newest launches.
- **Jupiter:** which responses Bound accepts and refuses, and what happens to users on the day
  Jupiter changes a format or deprecates an endpoint.
- **Pump.fun:** is the route refund built exactly as the programs expect? What happens on a Pump
  upgrade?
- **Wallets:** a table of the wallets you researched: works, refuses (why), unknown. What the user
  sees in each case.
- **Freshness:** compare the page's intervals and rebuild rules (section 1), and the agent ticket's
  lifetime, with your findings in 3B. Where do users or Bound lose today? Give your recommended
  intervals and rules, with the reasoning.
- **Confirmation and messages:** does every outcome message claim only what the RPC semantics you
  researched can prove?
- **The agent API and the skill:** compared with how agents actually work (3H), can a real agent
  integrate from `SKILL.md` alone? Which key setups are left out?
- **Speed, by reading:** from the code, count the round trips on the critical path (Jupiter calls,
  RPC calls, simulations) for each kind of route, and compare with what others do. Say which could
  be removed or run in parallel **without weakening a check**. Do not measure; count.

---

## 5. Part 3: what did we leave out?

List everything the code and the documents do not account for: situations, token types, wallet
behaviours, network conditions, upcoming changes, agent setups, legal or operational facts that
change the design.

For each, say:
- what happens today, read from the code;
- how likely it is and who it affects;
- what we should do.

Use these as a starting checklist, not a limit:
- **Tokens:** a new Token-2022 extension; a token whose issuer can pause or claw back; a hop through
  a Token-2022 mint; dust; an amount too large for one transaction.
- **Pump:** a curve completing mid-swap; a cashback coin; E's Pump account already existing.
- **Accounts:** W's output account missing, delegated, frozen or memo-required; the treasury's
  account frozen or missing; a wallet short of SOL.
- **Wallets:** a wallet that changes the message; one that signs and sends by itself; a slow one;
  an account switch mid-swap.
- **Network:** congestion with the fee at its cap; a transaction seen but never confirmed; a lagging
  or lying RPC; Jupiter slow, refusing or malformed.
- **Parallel:** two tabs or two devices swapping into the same token; many agents at once; a ticket
  finalized twice or after expiry.
- **Adversarial:** a malicious DEX; a compromised Jupiter API or Bound server; a phishing clone; an
  agent dropping the fee; a stolen API key or secret; hostile token metadata aimed at an agent.

---

## 6. Part 4: suggestions

Where your research shows a better or simpler way, propose it, ordered by value against effort. For
each give:
- what to change;
- the evidence;
- the effort;
- the risk of changing and the risk of not changing;
- the test we should run to confirm it.

Look especially for:
- **Simpler designs** that keep the same guarantee. Also say what could be removed.
- **Freshness and landing:** fewer failed or expired swaps, fewer questions to the user, within the
  fee cap.
- **Coverage:** more tokens and wallets working safely.
- **Robustness to upstream changes:** Jupiter formats, Pump upgrades, wallet behaviour, SIMDs.
- **What agents need** to adopt Bound.
- **Cost:** fewer calls per swap, and fee paths that leak.

---

## 7. What to deliver

1. **Research notes,** by topic A–I: what we need to know, each point sourced and dated. Short.
2. **Compatibility tables** from Part 2: transactions, rules, tokens, Jupiter, Pump.fun, wallets,
   freshness, confirmation, agents, round trips.
3. **Freshness recommendation:** intervals and rebuild rules for the page, the build ahead and
   agents, with reasoning.
4. **Findings,** most severe first. Each with:
   - an ID;
   - a severity: Critical (user funds beyond the guarantee), High (the guarantee or the fee broken,
     or a large group of users or tokens that cannot swap), Medium, Low or Info;
   - the area;
   - the source and the code line;
   - the impact;
   - a fix;
   - **the test we should run** to confirm it (you do not run it).
5. **What we left out,** from Part 3.
6. **Suggestions,** ordered, from Part 4.
7. **Documentation errors.**
8. **Verdict,** by area: will it work? Answer "sure", "likely", "unknown" or "no" for:
   - the page with the main wallets;
   - the page on mobile;
   - the tokens people trade;
   - Pump.fun;
   - agents with local keys;
   - agents with remote signers;
   - behaviour when Jupiter or the network changes.

   Give the reason for each.

Be direct. Where something is right, say so in one line and move on; spend the space on what is not.
