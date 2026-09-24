# Bound: Independent Security, Intent & End-to-End Compatibility Audit

You are an independent audit team with deep knowledge of Solana, token programs, wallets, RPC and
AI agents. You did not write this code. We are asking you to establish, with evidence, **what Bound
guarantees, whether the implementation keeps those guarantees, and for which real combinations of
swap, token, market, fee, transaction format, signer and client it works**.

A code review alone does not finish this work. The audit must connect five things:

**what the user asks for → what is built → what is signed → what executes → what is reported as the
result.**

No audit can promise every future case: Jupiter, the on-chain programs, wallets and RPCs keep
changing. What this audit can do is define exactly what is supported, prove it, and make sure that
everything unsupported is refused cleanly.

---

## How the audit runs: two stages

**Stage 1: independent review of the guarantees and the code.** Reading, research and reasoning.
Parts 1, 2, 3 and 8 (research), and the plans for parts 4 to 7. You may run the existing tests to
read their results, but do not change anything yet. Deliver the Stage 1 report and wait for the
owner's go-ahead.

**Stage 2: controlled verification of real behaviour and recovery.** Parts 4, 5, 6, 7, 8
(measurements) and 9. You write tests, reproductions and measurements, and run them. For every
finding you propose the fix and prove it.

Stage 1 of an earlier review was done by reading and reasoning only (see "Earlier reviews" below).
Treat its conclusions as claims to check, not as results. The people doing Stage 2 must be able to
disagree with Stage 1, including with you.

---

## 0. Rules of engagement

**Independence**
- Earlier audits of Bound were run by sessions of the same AI model that wrote the implementation.
  None of them was independent. Their findings and their "fixed" labels are claims.
- Our documents are claims too, not facts: `SECURITY.md`, `AUDIT.md` (sections 0u to 0x hold the
  latest changes), `AGENT-API.md`, `README.md`, `TESTIMI.md`, `skills/bound-protected-swap/SKILL.md`,
  and the Albanian design notes `API-AGJENTET.md`.
- Where you cannot establish something, write "unknown", and say what would settle it.

**Where you work**
- Clone `github.com/intopic/bound`. Write down the commit you audit (at the time of writing, `main`
  is `8c41f25`). Every statement in the report refers to that commit.
- Work in your own branch or fork. **Never push to `main`.** Tests, reproductions and fixes come as
  pull requests or patches; the owner reviews and merges them.
- Do not edit the audited commit to make a test pass. A test that needs a change of product code is
  a finding.

**Safety**
- Simulation first: mainnet simulation with `sigVerify: false` covers most runtime questions
  without signing anything.
- Real transactions are sent only for the compatibility checks that need them (real wallets, real
  landing): **only from test wallets the owner funds for the audit, with small amounts**.
- Never ask for, receive, print or store a private key, seed phrase, API key or server secret in the
  report, in chat or in a repository. The owner gives you access through their own channel. Keys are
  rotated after the audit.
- Never direct a test at anyone else's wallet or funds. Exchange wallets may be used as read-only
  fee payers in simulation, as our own tests do.
- If you find a vulnerability that could harm users of the live site, tell the owner privately at
  once. Do not wait for the report.

**Evidence.** Label every statement:
- **Proven:** a test or reproduction you ran. Give the command, the commit and the output.
- **In the code:** `file:line`.
- **Sourced:** a primary source (specification, program source, IDL, official documentation), with a
  link and the date you read it.
- **Reasoned:** your steps, and what would confirm them.

A guarantee that rests only on documentation counts as **not implemented**.

**Style.** Short sentences. Where something is right, say so in a line and move on.

---

## 1. What Bound is at the audited commit

Bound Protected Swap is a Solana dApp and an API for agents. TypeScript, `@solana/kit` 8,
Next.js 16, hosted on Vercel.

**The idea.** Jupiter chooses where to trade; Bound decides what authority the trade gets.
- The one untrusted instruction, Jupiter's route, receives a one-time key **E** and temporary token
  accounts holding exactly the approved amount. It never receives the wallet **W**.
- W signs first (sign only, no send). Bound checks the returned bytes are exactly what it verified;
  then E signs last. The transaction has exactly two signers.
- There is no Bound program on chain. A verifier with seven rules (R1–R7) decides what may be
  signed. R6 (the signers are exactly W and E, W pays) and R1 (W never appears inside the external
  instruction) are the load-bearing ones.
- Three shapes: A (token → SOL), B (SOL → token), C (token → token).

**The minimum.** Enforced twice:
- Bound's own check after the swap: a self-transfer of the output account's balance before plus
  the minimum;
- Jupiter's own floor (quote less tolerance). The verifier requires it to reach the whole minimum
  and to be measured on the account the output must reach (verifier 0.7.0 and later). When the user
  accepted more than the route's floor, the pipeline tightens the tolerance in Jupiter's instruction.

Tolerance is 0.5%, and 3% on a Pump.fun bonding curve.

**The fee: 0.3% on every swap** (the owner's final decision). It is inside the same transaction and
taken in this order:
1. In SOL, USDC or USDT when one of them is on either side and the treasury can receive it. On the
   input it is 0.3% of the amount, before the swap. On the output it is 0.3% of the enforced
   minimum, after the minimum check.
2. Otherwise in the input token, when the treasury has an account for it.
3. Otherwise **in SOL from the wallet** (`feeSide: 'sol'`, verifier 0.8.0). It is 0.3% of what the
   swap is worth in SOL, priced by a Jupiter quote asked for E when the swap is built. The verifier
   checks where this fee goes and when, not its price. The page shows it before the wallet opens,
   and the agent's check holds it to a price of the agent's own.
4. Fee-free only when the treasury can receive nothing (no wallet yet), or no price in SOL exists.

The fee is compiled into the page at build time. The verifier refuses anything above 1%.

**Pump.fun.** Its markets open a per-buyer account in E's name. Bound measures that rent in
simulation, funds E with exactly that, and closes the account at the end, returning the rent to W,
when the account holds exactly its rent. A bonding curve also keeps about 0.00013 SOL of every buy.

**Freshness.** A transaction lives 150 blocks, about 40 s in September 2026.
- The page opens the wallet only with at least 100 blocks left.
- The agent example finalizes only with at least 30 blocks left.

**Agents.** Two parts:
- **An API.** `/api/v1/prepare` and `/api/v1/finalize`. It is stateless: a ticket sealed with an
  HMAC, and E derived from a server secret and a nonce. Finalize reads the transaction's status
  first (its id is W's signature), so a repeated finalize answers for the same transaction and never
  invites a second swap.
- **A skill** (`skills/bound-protected-swap`). Its example (`examples/swap.ts`) runs Bound's full
  verifier on the agent's own RPC before signing. The check:
  - requires the agent's own price floor;
  - requires its own limit for a fee in SOL;
  - simulates that nothing stays under E, or in a Pump account in E's name;
  - caps non-refunded route rent (`maxRouteCostLamports`, 0.001 SOL by default);
  - refuses a fee above 0.3% by default.

  After signing it reads the outcome from the chain for its own signature, never from the server.

**Decisions made on purpose.** Challenge them only with a new argument:
- no on-chain program;
- one RPC provider;
- v0 transactions first, v1 only as a fallback behind a flag;
- a skill for agents, not an SDK or MCP server;
- tokenized stocks such as xStocks are refused by the Token-2022 rules (a program-controlled permanent
  delegate, scaled UI amounts), not by a category rule: there is no list of stock tokens;
- a Token-2022 allowlist;
- no cap per swap;
- stateless API;
- the fee rules above.

**Known and open** (operations, not findings):
- the real-wallet tests not done yet (Phantom, Solflare, Backpack, Ledger, mobile);
- the treasury wallet and its USDC and USDT accounts to be funded and opened;
- the treasury address still to be pinned in the skill;
- a paid RPC and a separate Jupiter key for the API;
- host firewall rules and spend alerts;
- the scheduled canary still off;
- legal advice.

**Earlier reviews.** Read their tables in `AUDIT.md`:
- the research and compatibility audit (section 0s);
- the read-only engineering review, findings H-01 to L-10 (section 0u);
- the fee decisions (0t, 0v, 0w, 0x).

**Tests that exist** (inventory them in Part 4 before adding any):

| What | Where | How to run |
| --- | --- | --- |
| Unit, property and mutation tests | `packages/*/test`, `apps/web/test` | `npm ci && npm test` (454 at `8c41f25`) |
| Type checks | root and `apps/web` | `npm run typecheck`; `npx tsc -p apps/web/tsconfig.json --noEmit` |
| Fuzz of the verifier, 100,000 cases per property | `packages/verifier/test/property.test.ts` | `npm run test:fuzz` |
| Mainnet simulations: T4 (30 pairs, v0 and v1), T1 (runtime attacks), T5 (minimum) | `tests/integration/mainnet.ts` | `node tests/integration/mainnet.ts` |
| Jupiter's floor, destination and tightening | `tests/integration/jupiter-floor.ts` | node, as above |
| Pump curve (T14) and PumpSwap (T13) | `tests/integration/pump.ts` | `--market curve` or `--market amm` |
| Large amounts, transfer-fee tokens, issuer stablecoins | `tests/integration/large.ts`, `transfer-fee.ts`, `issuer-stablecoins.ts` | node, as above |
| A malicious swap program in a Solana VM (T6) | `tests/cpi` | CI only (`.github/workflows/cpi.yml`) |
| Browser tests of the page | `tests/e2e/smoke.ts`, `busy.ts` | build and start `apps/web`, then node |
| Upstream canary: seven swaps, every kind of fee, v1, Pump | `tools/canary.ts` | `node tools/canary.ts` |

**Where things are**

| Path | What |
| --- | --- |
| `packages/core` | Constants; the policy (intent → accounts, fee side and amount, rent); the compiler (v0/v1) |
| `packages/verifier` | `parse.ts` (exact instruction shapes), `verify.ts` (the rules, Jupiter's arguments, floor and destination, the Pump close, the fee), `wallet.ts` (the returned bytes), `certificate.ts` |
| `packages/solana` | Chain reads, simulation, send and confirm, `sendOnce` |
| `packages/jupiter` | Jupiter client; `swap.ts`, the whole pipeline from quote to countersign, including the SOL pricing of the fee |
| `apps/web/components/SwapApp.tsx`, `apps/web/lib/client` | The page: flow, questions, freshness, lock, history, received amounts |
| `apps/web/lib/server` | Relays and their shape filter, rate limits, the agent API and tickets (`agent/`) |
| `skills/bound-protected-swap` | `SKILL.md`, `examples/swap.ts`, `src/verify.ts` (bundled into `lib/bound-verify.mjs` by `tools/build-skill.ts`) |
| `tools`, `.github/workflows` | Canary, release digest, live check, API keys; CI, fuzz, T6, release |

---

## 2. Part 1: the exact guarantees

Before reading the code in detail, write down what must always be true. At least these:

1. **Wallet outflow.** Only the authorised input leaves the wallet, plus the accepted fee and the
   accepted SOL costs (network fee, account deposits that return, a new output account's rent, rent
   a market keeps).
2. **Minimum.** The accepted minimum is what the user keeps after the fee.
3. **Authority.** The external route never obtains W's authority, nor any other access to W's
   accounts.
4. **Fee.** The fee has the authorised amount, token, destination and position in the transaction.
5. **Residue.** Every account, rent or right left behind after the swap is either forbidden or
   declared to the user.
6. **Retries.** Repeating a request after a lost answer never creates a second trade.
7. **Outcomes.** "Success", "failure", "expired" and "unknown" each have an exact meaning, and the
   page, the API and the skill use them the same way.

Add any other guarantee our documents claim. Then check each claim against the code.

**Product:** a guarantee map. For each guarantee, give:
- the code that enforces it (`file:line`);
- the test or proof that confirms it;
- the conditions it depends on (the RPC tells the truth, Jupiter's program behaves as specified, the
  page served is the audited one…).

A guarantee with no enforcing code, or with no proof, is marked as such.

---

## 3. Part 2: intent traced through the whole system

For every value that matters, follow its origin and every change it goes through:
- wallet, input and output mint, amount;
- minimum, fee (side, token, amount, price);
- rent and refund;
- transaction version;
- lifetime (blockhash, last valid block height).

Answer one question: **is the transaction that is signed still the one the user accepted?**

Include every place a value can change:
- quote refresh;
- the build ahead of the click;
- a rebuild after a question;
- the price-moved and costs-more dialogs;
- a change of fee side;
- the treasury wallet or an account becoming available;
- the SOL price used for a fee in SOL;
- a v1 fallback;
- the wallet's returned bytes.

Do this separately for the page and for the agent (API plus skill). A value shown to the user that
is not the value enforced is a finding.

---

## 4. Part 3: full code review and trust boundaries

Cover every component:
- compiler, verifier and parser;
- pipeline and Jupiter client;
- RPC helpers;
- relays and their filter;
- agent API, tickets and secret rotation;
- skill and its bundle;
- the page;
- build, release digest and package publication.

For each component, answer four questions:
1. What does it check?
2. What data does it trust?
3. What happens when that data is wrong, stale or changes between read and execution?
4. Which mechanism stops the loss, and where is it?

Write the exclusions down explicitly. For example, protection against a compromised Jupiter API is a
different claim from protection when the RPC also lies; state which combinations hold and which do
not.

---

## 5. Part 4: adversarial runtime audit of the transaction

Try to break it with concrete behaviour:
- **A malicious DEX** inside Jupiter's route that uses every account and authority it is given.
- **A smaller output, another destination, or a changed fee:** in Jupiter's arguments, in the policy
  or in the bytes.
- **A competing deposit** into the output account between the balance read and execution; a
  parallel swap into the same token.
- **Token changes between read and execution:** a delegate added, a hook set, an account frozen, a
  transfer fee changed.
- **Rent or cashback left under E**, including a Pump account that cannot be closed.
- **A wallet that changes the message**, adds a signature or drops one.
- **Size, compute, account-count and lookup-table limits,** and the v0 and v1 boundaries.
- **The fee in SOL:** a wrong or manipulated price, a treasury wallet appearing or disappearing, a
  pair that moves between fee sides.

First inventory the existing tests: what each proves, and against what (fake, simulation, VM,
mainnet). Then add tests only for the gaps and for the combinations nobody covered. A larger number
of tests is not a result; closed gaps are.

---

## 6. Part 5: the whole lifecycle and recovery

For us this is one of the most important parts. Interrupt the flow at every point, for the page and
for an agent using the skill:
- before signing;
- after W signs;
- after E signs;
- after sending, before the HTTP answer;
- after execution, before the client confirms;
- during a bot restart, a server secret rotation, or a change of RPC endpoint within the same
  provider;
- with an RPC that lags, answers errors, or reports stale status.

**The main proof:** after each interruption, the system either recovers the outcome of the same
transaction, or keeps it as "unknown". In no case does it automatically authorise a new swap while
the first one could still land.

This needs control over the order of events and over network failures (a proxy that drops or
delays answers, a fault-injecting RPC). Tests of normal answers are not enough.

---

## 7. Part 6: a real compatibility matrix

For every supported combination, give a documented result: **Proven** (with run and date),
**Refused cleanly**, or **Unknown**.

| Dimension | What to cover |
| --- | --- |
| Swap | SOL → token, token → SOL, token → token |
| Token | Classic SPL; Token-2022 and each allowed combination of extensions; refused extensions |
| Market | Ordinary routes, Pump curve, PumpSwap, cashback and rent cases |
| Fee | Input, output, SOL from the wallet, fee-free; availability changing (treasury wallet or account appearing) |
| Transaction | v0, v1, the v1 fallback, refusals for size and accounts |
| Signer | Local keypair, remote signer, wallet extension, mobile, hardware (Ledger) |
| Client | The page, the skill, a bot without AI |
| State | Existing or new accounts, balances that change, parallel swaps |

It is not enough that a wallet advertises `signTransaction`. Prove the concrete flow: two signers,
the wallet signs first and does not send, and the message comes back unchanged.

For an unsupported case, the correct result is a clear refusal. Adding support is not the goal.

---

## 8. Part 7: agents and bots

Integrate using only what a new customer receives: the public repository, `SKILL.md`,
`AGENT-API.md`, the example and an API key. Nothing from us beyond that.

Check whether:
- the example forces the verifier to run before any signature;
- the signer can be used while bypassing the verifier, and what the documents say about it;
- token names, metadata and error texts can steer the agent into other actions (prompt injection);
- the skill's bundle (`lib/bound-verify.mjs`) matches the audited source; rebuild it and compare;
- the economic floor has a clear origin and freshness;
- the bot keeps pending transactions durably and handles parallel swaps;
- the finalize answer is bound to the transaction the bot signed;
- a fee in SOL is held to the agent's own price;
- the treasury is pinned, and what happens while it is not.

An agent that follows the instructions nicely in a demo is not proof that the check cannot be
bypassed.

---

## 9. Part 8: research of current versions, and performance

**Research.** Produce a dated register of every version, program, IDL, wallet, SDK and behaviour Bound
relies on. At least:
- Solana runtime features and SIMDs in effect: v1 transactions, slot times, rent, fees;
- the classic Token program (p-token) and Token-2022, with all extensions;
- Jupiter Swap API and on-chain program: route instructions and how the floor is measured;
- Pump.fun curve and PumpSwap: instructions, per-buyer account, cashback, fees;
- the wallets in the matrix and their versions;
- `@solana/kit`;
- the RPC provider's behaviour.

Where documentation and implementation disagree, write it down and settle it by source or by test.

**Measurements.** Measure the phases separately:
- preparation;
- the agent's verification;
- signing;
- sending;
- confirmation.

Report the median and the slow cases (p90, p99, worst), not the fastest demo. Also report:
- the number of calls per swap (Jupiter, RPC);
- the cost per completed swap (network fee, rent kept, Jupiter and RPC usage);
- the share of abandoned preparations;
- the price difference against the direct alternative (the same trade through Jupiter without
  Bound).

---

## 10. Part 9: fixes, their verification, and monitoring after launch

The audit does not end with a list of problems. For every finding, give:
1. a counterexample or reproduction (Proven);
2. the change needed (a pull request or patch against the audited commit);
3. the proof that the change closes it: the reproduction now fails in the right way;
4. a check that the fix breaks no other guarantee: the full suite, and the guarantee map re-read.

Then:
- **Tie the audited version to what is published.** Map the audited commit to the release tag and
  the build digest (`release.yml`, `tools/build-digest.ts`, `live-check.yml`), and say how a user or
  agent can confirm they run the audited code.
- **Name the upstream changes that require a new review**, such as:
  - a new Jupiter route instruction or IDL change;
  - a Pump program upgrade;
  - a Token-2022 extension;
  - a wallet or `@solana/kit` major version;
  - a SIMD that changes fees or transaction formats.

  Say how the canary and CI should catch each one.

---

## 11. The final package

1. **The guarantee map** (Part 1), with the code and the proof for each guarantee.
2. **The threat model:** attackers, what each controls, what each can achieve, and which
   combinations are outside the guarantees (Part 3).
3. **The findings,** most severe first. For each: title, severity, the guarantee it breaks,
   preconditions, reproduction, fix, and proof of the fix.
4. **The compatibility matrix** (Part 6), with dates and runs.
5. **Performance and cost results** (Part 8).
6. **Known limitations:** what is not guaranteed, stated so a user or agent developer understands
   it.
7. **Verification after the fixes:** the commit that contains them, the suite, and the guarantee map
   re-checked.
8. **The version register and the list of upstream changes** that require a new review (Parts 8
   and 9).
9. **A one-page summary** for the owner: can this version be launched, for which cases, and what
   must happen first.

Deliver Stage 1 (items 1, 2, 3 as reasoned or proven, 8, and the test plan for Stage 2) first. Wait
for the go-ahead before Stage 2.
