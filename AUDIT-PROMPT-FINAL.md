# Master prompt: final engineering audit of Bound Protected Swap

You are a senior engineer auditing **Bound Protected Swap** before it meets real users and real
agents. Your job has three parts, and all three matter equally:

1. **Verify.** Prove, with research and experiments, that what Bound has built is correct: that
   every assumption it makes about Solana, the token programs, Jupiter, Pump.fun, wallets, RPC
   providers, hosting and agent frameworks is true today (September 2026), and that the code does
   what its documents say.
2. **Audit deeply.** Swaps, the agent API and skill, speed, load, parallel use, security,
   reliability, cost, and the quality of the code. Measure where you can.
3. **Suggest.** Wherever research shows a simpler, faster, cheaper or safer way to do the same
   thing, propose it, with the evidence, the cost of changing and the risk of not changing.

A previous research-first audit (FA-01 to FA-16) was run by a session of the same model that wrote
the code, so it was not independent, and all of its findings have since been fixed. **Treat those
fixes as new, unreviewed code**: that is where new bugs are most likely to be.

Our documents are claims to test, not facts: `AUDIT.md` (section 0r lists the latest fixes),
`SECURITY.md`, `AGENT-API.md`, `API-AGJENTET.md`, `README.md`, `skills/bound-protected-swap/SKILL.md`.
Where a document and the code disagree, the code is what runs: report the disagreement.

---

## 0. How to work

- **Evidence first.** Every finding and every "this is correct" needs one of these:
  - a test or proof of concept you ran;
  - a simulation on mainnet state;
  - a measurement;
  - a quoted line of our code together with a quoted primary source;
  - an argument a reader can check step by step.

  Label each statement **verified** (you ran or read it), **sourced** (a primary source says so)
  or **inferred** (reasoning only).
- **Primary sources.** On-chain program data and deployed source, official docs, SIMDs, IDLs,
  changelogs, explorers. Blogs and forums are leads, not evidence. Give a URL and a date for every
  external fact, and say plainly what you could not confirm.
- **Measure, don't estimate.** For speed, load and cost, report numbers with how you got them:
  - where: local, public RPC or a paid provider, keyless or keyed Jupiter;
  - how many runs;
  - the median and the worst case.
- **Safety.**
  - No mainnet transaction with real funds, and no load against Jupiter, RPC providers or wallets
    beyond ordinary use.
  - Simulation on mainnet state (`sigVerify: false`) and local validators or litesvm are fine.
  - Throwaway API keys only (`node tools/agent-key.ts`), deleted afterwards.
  - Never put a key or a secret in a report.
- **Don't stop at the first answer.** Every check that passes rests on an assumption; name it and
  test that too. Do this across:
  - variants A/B/C;
  - v0 and v1 transactions;
  - both token programs;
  - both Pump markets;
  - the page and the API.

---

## 1. What Bound is, now

Jupiter chooses where to trade; Bound decides what authority that trade gets.

- The swap instruction receives a one-time key **E** and temporary token accounts holding exactly
  the approved amount, never the wallet **W**.
- W signs first. Bound verifies what W returned byte for byte, and E signs last.
- There is no Bound program on chain.
- The fee is 0.2% of the input, in the input token.

The guarantee is in `SECURITY.md` ("Guarantee"). The load-bearing rules are R6 (signers are
exactly W and E) and R1 (W never inside the external instruction), `packages/verifier/src/verify.ts`.

**Changes since the last audit** (`AUDIT.md` section 0r), each one to be verified and attacked:

| Area | What changed |
| --- | --- |
| Jupiter | The verifier reads Jupiter's `route_v2` / `shared_accounts_route_v2` arguments. It refuses any other Jupiter instruction, a platform fee, positive slippage, a tolerance above 0.5% (3% with the curve program), a quote below the minimum, or more in than E_in holds |
| Pump.fun | The account each Pump market opens for the buyer (PDA `["user_volume_accumulator", E]`) is closed at the end of the swap with Pump's `close_user_volume_accumulator`, signed by E, and its lamports go on to W. This is the one instruction of a market's program that Bound itself places |
| Agents | The skill bundles the full verifier (`skills/bound-protected-swap/lib/bound-verify.mjs`, built by `tools/build-skill.ts`, checked in CI). The agent verifies on its own RPC before signing. The API seals W_out's balance in the ticket and re-checks it at finalize |
| Relays | `/api/rpc` sends and simulates only Bound-shaped transactions (`apps/web/lib/server/boundShape.ts`) |
| Outcomes | "Failed" only at confirmed; "expired" only against the finalized height; frozen accounts reported as such |
| Fees | Default network-fee limit 0.0005 SOL; the page and the API say when the priority fee is capped |
| Lookup tables | Bound's own accounts are never loaded from a lookup table |
| CI | Actions pinned by commit; T6 on every push to main; a second runner image must reproduce the digest |

**Decisions made on purpose** (challenge them only with a new argument):
- no on-chain program;
- the fee inside the transaction, fee-free when the treasury has no account for the input token,
  never waived to make a route fit;
- no cap per swap, never split across transactions;
- one RPC provider;
- slippage 0.5%, and 3% on a Pump.fun bonding curve;
- ask the user from a 0.5% gap to the open market;
- HumidiFi excluded;
- v1 transactions behind a flag;
- a swap built ahead of the click;
- E derived server-side for the API;
- a skill, not an SDK or MCP.

**Known and open** (verify, but these are not new findings):
- no real-wallet test yet;
- Jupiter and Helius on keyless or public tiers during development;
- operations still to do: treasury multisig, firewall rules, the paused-deployment runbook
  rehearsal, upgrade watching;
- the repository is private.

---

## 2. The repository

`github.com/intopic/bound` at `main`: TypeScript, Node 24, `@solana/kit` 8, Next.js 16, deployed on
Vercel.

| Path | What |
| --- | --- |
| `packages/core` | Constants and ceilings; policy (intent → accounts, fee, variant, route rent and refund); compiler (v0/v1) |
| `packages/verifier` | `parse.ts` (exact instruction shapes), `verify.ts` (R1–R7, Jupiter arguments, the Pump close), `wallet.ts`, `certificate.ts` |
| `packages/solana` | Snapshot reads, simulation, `sendAndConfirm`, `sendOnce`, retrying transport, `createEphemeral` |
| `packages/jupiter` | Jupiter client; `swap.ts`, the pipeline: quote levels, rent probe, route refund, repair, verify, fee, countersign |
| `apps/web/components/SwapApp.tsx` | The page's whole flow and every message a user reads |
| `apps/web/lib/server/*` | Relays (RPC with the shape filter, Jupiter, icons), rate limits, the agent API (`agent/api.ts`, `ticket.ts`, `config.ts`) |
| `skills/bound-protected-swap` | `SKILL.md`, `examples/swap.ts` (`checkPrepared`, `confirm`), `src/verify.ts` → `lib/bound-verify.mjs` |
| `tests/cpi` | T6: a malicious swap program in litesvm (CI only) |
| `tests/integration` | `mainnet.ts` (T4/T1/T5), `pump.ts --market curve` or `amm` (T14/T13), `jupiter-floor.ts`, `pump-accumulator.ts`, `large.ts`, `transfer-fee.ts`, `thresholds.ts` |
| `tests/e2e` | Edge: `smoke.ts`, `busy.ts`, `pump-card.ts` |
| `tools` | Build digest, live check, agent keys, skill bundle |
| `.github/workflows` | CI, T6, release digest, live check |

**Run:**
- `npm ci && npm run typecheck && npm test`, and `npm run test:fuzz`;
- `node tests/integration/<file>.ts` for each integration test;
- `npm run build && npm run start -w @bound/web`, then each file in `tests/e2e`;
- the agent API locally: set `BOUND_API_SECRET` and `BOUND_API_KEYS` from `tools/agent-key.ts`,
  then `node skills/bound-protected-swap/examples/swap.ts ... --dry-run`.

---

## 3. Phase 1: verify by research and experiment

Build a **verification ledger**: one row for each claim Bound depends on, with its source or
experiment and a verdict (holds, broken, unproven). At least the claims below; add every one you
find in the code.

**Solana and the token programs**
- Signer and writable privileges in CPI.
- Duplicate account loading.
- v0 lookup-table stability.
- v1 transactions:
  - the message config and its limits;
  - that ComputeBudget instructions are no-ops in v1.
- Blockhash lifetime, and whether durable nonces can be used against Bound.
- Current rent, and the SIMD-0437 steps still to come.
- The self-transfer balance check in the classic Token program (p-token) and in Token-2022. Who
  can upgrade each, and when they last did.
- Every Token-2022 extension, including those added in 2025–2026, against Bound's allowlist.
- CPI Guard and memo-required accounts; frozen accounts.

**Jupiter**
- The exact layout of `route_v2` and `shared_accounts_route_v2`, from the deployed program's IDL or
  source, not only from observed data.
- Whether `/swap/v2/build` ever answers with another instruction: exact-out, token ledger,
  Token-2022 routes, multi-hop through taxed mints, large amounts.
- That its slippage check measures this instruction's output, whatever the destination held
  (`tests/integration/jupiter-floor.ts` shows it once; repeat it on other routes and variants).
- What `otherInstructions`, `tipInstruction` and `setupInstructions` can carry that Bound drops.
- How often the program is upgraded, and how Bound would notice a format change. The verifier now
  refuses unknown formats, so a change stops every swap.

**Pump.fun (curve and PumpSwap)**
- `close_user_volume_accumulator` from both IDLs and from the deployed programs:
  - the accounts it takes and the checks it makes;
  - where the lamports go;
  - whether it can fail or be blocked (cashback coins, unclaimed rewards, an account created
    earlier by someone else for E);
  - whether an upgrade authority can change it.
- Whether the per-buyer rent and the curve's growth (132,080 lamports) are still what Bound
  measures.
- Buys and sells on both markets.
- Migration mid-route.
- The Pump fee and cashback programs that appeared in 2026.

**Wallets**
- `solana:signTransaction` with a second, unsigned signer: behaviour of Phantom (extension and
  mobile), Solflare, Backpack and Ledger through them.
- Lighthouse or other changes to the message; warnings; v0/v1 support.
- Embedded wallets, smart and multisig wallets (Squads, Swig), and Mobile Wallet Adapter.

**RPC**
- The semantics Bound's outcome proofs rely on: preflight refusals, `getSignatureStatuses` with
  and without history, commitment levels, `minContextSlot`, lagging nodes behind load balancers.
- The Helius specifics: sending, rate-limit answers, credits per method.

**Hosting**
- Vercel and Next.js 16:
  - environment changes only on redeploy;
  - function duration and concurrency, fluid compute;
  - per-instance memory;
  - `x-vercel-forwarded-for`;
  - the firewall;
  - instant rollback and promotion (the runbook in SECURITY.md relies on them).
- CSP and SRI in this Next version.
- The reproducible build.

**Agents**
- How agents are built today: frameworks, the Agent Skills format, `npx skills`, Jupiter's own agent
  tooling.
- How their keys are held: local keypairs, and remote signers with policy engines (Turnkey,
  Privy, Crossmint, Fireblocks, KMS). Can those signers sign one key of a transaction with two
  signers and return it unsent?
- Whether an agent following `SKILL.md` can actually use Bound end to end. Try it with at least
  one real agent setup.

**Build and supply chain**
- Whether rolldown's bundle is deterministic across machines and versions.
- What `lib/bound-verify.mjs` contains, and whether an agent can check it against the source.
- Dependency risk in everything that runs in the page, the server and the skill.

---

## 4. Phase 2: the engineering audit

### A. Swap correctness (the page)

Walk the full flow in `SwapApp.tsx` and `swap.ts` for every variant and token type:
- the quote;
- the build ahead of the click and when it is reused;
- the questions asked (price moved, route gap, price impact, costs before the wallet);
- the wallet;
- the balance re-check after signing;
- countersigning, sending and confirming;
- the history.

Establish:
- whether any path lets the enforced minimum fall below what the user saw;
- whether any path lets a cost appear that was not shown;
- whether any message can be false.

Check the new route-refund path: what the user is told, and what happens in the fallback.

### B. The agent API and the skill

- **The protocol:** authentication, the ticket, E's derivation and rotation, idempotency, the
  balance re-check, the error codes, the rate limits, and the JSON every field is serialised to.
- **The skill's verification:** list every policy field and say which ones the agent pins to its
  own intent, which ones the verifier re-derives from the chain, and which ones remain the
  server's word.
  - Try to build an answer that passes `checkPrepared` and still harms the agent. Use every field
    of the policy, lookup tables served by the agent's own RPC, the Pump close, the route refund,
    the Jupiter arguments, and the treasury when it is not pinned.
- **The confirm loop and outcome reporting:** errors, retries, re-broadcast, expiry.
- **Documentation against behaviour:** does `AGENT-API.md` describe exactly what the API does?
- **Usability:** could a developer or an agent integrate from `SKILL.md` alone? What is missing?

### C. Speed

Measure, with numbers, for the page and for the API, on the public tiers and, if you can, on a
paid RPC and a keyed Jupiter:
- time to the first quote;
- the build ahead of the click;
- click to wallet (with and without the build ahead);
- prepare and finalize;
- send to confirmation.

Also:
- Count the Jupiter calls, RPC calls and simulations per swap, by kind of route. Pump routes now
  run up to four simulations.
- Find the critical path and say what could be cut, parallelised or cached **without weakening a
  check**.
- Report how close transactions come to their size limits (a v0 curve buy with the refund is about
  1,159 of 1,232 bytes), and what that means for route availability.

### D. Load and parallel use

Analyse, and where possible simulate, what happens:
- **Many users at once:**
  - the shared Jupiter key and RPC account;
  - per-instance rate limits and Jupiter cool-downs on Vercel;
  - cold starts;
  - the cost of the relay's shape filter.
- **Many swaps from one user or agent at once:**
  - into the same token (the page's lock, the API's balance re-check, the window between the
    re-check and landing);
  - into different tokens;
  - from several devices.
- **Many agents at once:** prepare and finalize interleaved across instances; tickets finalized on
  other instances; secret rotation mid-flight; a key revoked mid-flight.
- **Changes during traffic:**
  - the kill switch;
  - a Jupiter program or API change;
  - a Pump upgrade;
  - a Token-2022 upgrade;
  - an RPC provider degrading.

  For each, what users and agents see, and whether it fails closed.

### E. Security: hunt the regressions

For each change in section 1, try to break it. At least:
- **A lying server against the agent:** policy fields, lookup tables, the route refund, the
  Jupiter arguments.
- **The route refund:**
  - an attacker who learns E's address (the page's build ahead, or the API's `temporaryAuthority`)
    and pre-creates or funds E's Pump account before the swap lands;
  - cashback accruing into it;
  - a Pump program upgrade.
- **The Jupiter arguments:** a format Bound misreads; a legitimate route Bound now refuses.
- **The relay filter:** a Bound-shaped transaction that is useful to an attacker; one that
  makes the page fail.
- **The ticket's balance check:** a race between the re-check and landing; an output of SOL
  (variant A) that has no W_out.
- **The masking of Bound's own accounts in lookup tables:** does it ever produce a message the
  runtime refuses, or one larger than before?

### F. Reliability and operations

- The runbook for pausing and revoking.
- The release digest and the live check.
- CI gating.
- What is monitored today and what is not: Jupiter format changes, program upgrades, error rates,
  spend.
- What an operator sees when something goes wrong, and how fast they can act.

### G. Code quality and simplicity

- Complexity hotspots: `swap.ts`, `verify.ts`, `SwapApp.tsx`.
- Duplicated logic: several compiled-message decoders, test fakes, shape knowledge in three
  places.
- Dead or temporary code (`/diagnostic`, research scripts).
- Test quality:
  - run a mutation pass on `verify.ts`, `parse.ts`, `compiler.ts`, `swap.ts`, `boundShape.ts` and
    the skill's check;
  - report what survives.
- Documentation drift.

### H. Cost and economics

- The cost of one swap in RPC credits and Jupiter calls, at current Helius and Jupiter prices.
- The fixed monthly cost.
- The volume at which the 0.2% fee covers it.
- Where revenue leaks: fee-free paths, such as sales of tokens the treasury has no account for,
  which is most memecoins. What that means for agents and bots.

---

## 5. Phase 3: scenarios

For each, say what the system does, what the user or agent sees, whether the guarantee and the fee
hold, and how long it takes. Do it on the page and through the API. Add every scenario we missed.

- **Tokens:**
  - SOL↔USDC;
  - USDC→USDT;
  - dust;
  - an amount too large for one transaction;
  - a Token-2022 token with a transfer fee, in and out;
  - PYUSD or USDG;
  - a token with a hook;
  - a token frozen by default;
  - a hop through a Token-2022 mint.
- **Pump:**
  - a curve buy and a curve sale;
  - a curve that grows;
  - a curve completing mid-swap;
  - a PumpSwap buy and sale;
  - a cashback coin;
  - E's Pump account already existing.
- **Accounts:**
  - W_out missing, delegated, with a close authority, frozen, memo-required;
  - a treasury account that is frozen, or missing;
  - a wallet short of SOL.
- **Wallets:**
  - Phantom, Solflare, Backpack, Ledger;
  - a wallet that changes the message;
  - one that signs and sends by itself;
  - one that is slow;
  - an account switch.
- **Network:**
  - Jupiter 429, timeout, malformed or malicious;
  - RPC 429, lagging, lying;
  - congestion with the fee at its cap;
  - a transaction seen but not confirmed.
- **Parallel:**
  - two tabs;
  - two devices;
  - two agent swaps into one token;
  - a hundred agents at once;
  - build ahead racing the click;
  - two finalizes of one ticket;
  - finalize on another instance or after expiry.
- **Adversarial:**
  - a malicious DEX;
  - a compromised Jupiter API, Bound server, dependency or skill bundle;
  - a phishing clone;
  - an agent dropping the fee;
  - a stolen API key, ticket or server secret;
  - hostile token metadata aimed at an agent.

---

## 6. Phase 4: suggestions

Propose improvements where your research supports them. Order them by value against effort. For
each give:
- what to change;
- the evidence;
- the cost to build;
- the risk of changing and the risk of not changing;
- how to test it.

Look especially for:
- **Simpler designs** that keep the same guarantee.
- **Speed:** fewer round trips, better caching, a landing strategy within the fee cap.
- **Cost:** fewer calls per swap, cheaper plans, leaks in the fee.
- **Robustness to upstream changes:** Jupiter formats, Pump upgrades, wallet behaviour.
- **What agents need:** a published verifier package, remote-signer policy templates, examples
  for common frameworks.
- **What could be removed.**

---

## 7. What to deliver

1. **Verification ledger:** every claim, its source or experiment, a verdict.
2. **Findings,** most severe first. Each with:
   - an ID;
   - a severity: Critical (user funds beyond the guarantee), High (the guarantee or the fee broken
     under realistic conditions), Medium, Low or Info;
   - the area;
   - the preconditions;
   - a proof or a precise argument;
   - the impact;
   - a fix;
   - the regression test to add.
3. **Performance report:** measured latencies, calls per swap, size headroom, load behaviour,
   with method and numbers.
4. **Cost model:** per swap and per month, with the prices used.
5. **Scenario table** from section 5.
6. **Suggestions,** ordered, as in section 6.
7. **Documentation errors.**
8. **Readiness scorecard:** a go or no-go for the page (small alpha), the page (open launch), the
   agent API (private beta) and the agent API (open). Give the exact conditions each needs.

Be direct. Where something is right, say so in one line and move on; spend the space on what is not.
