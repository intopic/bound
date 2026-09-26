# Master prompt: engineering review of Orientim Protected Swap (read, reason, report)

You are a principal engineer who knows Solana, DeFi and AI agents well. We are asking for the
highest-level review you can give of **Orientim Protected Swap**, done entirely by reading and
reasoning. We want to know:

- whether the system is safe in every case;
- whether it fits the ecosystem as it really works today (September 2026);
- whether the agent skill and API will work for real agents;
- where we made things more complicated than they need to be;
- whether there is a real market and need for what we built.

**You may not run anything and you may not write code.** You read, you research, you reason, and
you report. Where something should change, describe the change in words. Where something should be
tested, describe the test; we run it.

Go through every detail. For each part of the system ask three questions:
- What is it for?
- What could break it?
- Is there a simpler way?

If something would make our system easier to build, run or explain, tell us, even if we did not ask.

---

## 0. Rules

- **Nothing is run.** No installs, builds, tests, scripts, local servers, simulations, RPC calls that
  build or send transactions, and no API keys.
- **Reading is the whole job:**
  - cloning and reading the repository;
  - public documentation, specifications and SIMDs;
  - program source and IDLs;
  - wallet, SDK and agent-framework repositories and their issues;
  - explorers (looking up an account or a transaction counts as reading).
- **No code in the report.** Describe changes precisely in words: the file, the function, what
  changes and why.
- **Label every statement:**
  - **sourced:** a primary source says so; give the link and the date you read it;
  - **in the code:** give `file:line`;
  - **reasoned:** the steps of your reasoning, and what would confirm it.
- **Say "unknown" when you do not know.** Keep facts apart from opinions.
- **Do not trust earlier audits.** They were run by a session of the same model that wrote the code,
  so they were not independent. Our documents are claims to check, not facts: `SECURITY.md`,
  `AUDIT.md` (sections 0r, 0s and 0t hold the latest changes), `AGENT-API.md`, `API-AGJENTET.md`,
  `README.md`, `skills/orientim-protected-swap/SKILL.md`.
- **Be direct.** Where something is right, say so in one line and move on. Spend the space on what is
  wrong, risky, unclear or more complicated than it should be.

---

## 1. What Orientim is today

Repository: `github.com/intopic/bound` at `main` (TypeScript, `@solana/kit`, Next.js 16, Vercel).

**The idea.** Jupiter chooses where to trade; Orientim decides what authority that trade gets.
- The one untrusted instruction, Jupiter's route, receives a one-time key **E** and temporary token
  accounts holding exactly the approved amount. It never receives the wallet **W**.
- W signs first with `signTransaction` (no send). Orientim checks that what came back is byte for byte
  what it verified, and E signs last.
- There is no Orientim program on chain. The verifier's seven rules (R1–R7) decide what may be signed.
  The load-bearing ones are:
  - R6: the signers are exactly W and E;
  - R1: W never appears inside the external instruction.

**What it guarantees** (`SECURITY.md`, "Guarantee"):
- the route can move at most the approved amount;
- nothing is approved, reassigned or left behind;
- at least the minimum arrives, or the whole transaction reverts.

The minimum is enforced twice:
- Orientim's own check after the swap;
- Jupiter's own floor, which the verifier requires to be measured on the account the output must
  reach (W's output account, or E's temporary account for SOL).

**The fee.** 0.2%, inside the same transaction, taken the way Jupiter takes its own:
- in SOL first, then USDC, then USDT, on whichever side of the swap they are;
- otherwise in the input token, if the treasury holds it;
- otherwise the swap is free.

On the output side, the fee is 0.2% of the enforced minimum and is paid after the minimum is checked.
The minimum shown to users and agents is what the wallet keeps after it. See `AUDIT.md` section 0t.

**Pump.fun.** Its markets open a per-buyer account in E's name:
- Orientim measures that rent in simulation and sends E exactly that much;
- after the swap, it closes the account and returns the rent to W, when the account holds exactly
  its rent.

**Freshness.**
- A transaction lives 150 blocks: about 41 seconds at the block times measured in September 2026.
- The page reuses a transaction it built early, or keeps one after asking the user a question, only
  while at least 100 blocks are left.
- The API returns `blocksLeft`.

**Agents.**
- An API with two calls: `/api/v1/prepare` and `/api/v1/finalize`.
  - It is stateless: tickets are sealed with a MAC, and E is derived on the server from a secret and a
    nonce.
- A skill (`skills/orientim-protected-swap`). Before the wallet signs, it runs the full verifier on the
  agent's own RPC. It also:
  - requires a price floor the agent got itself (`ownMinimum` asks Jupiter directly);
  - simulates the transaction so that E ends with nothing;
  - refuses to finalize with too few blocks left.

**Upstream changes.**
- A Jupiter instruction the verifier cannot read stops swaps with its own error (`route-format`).
- `tools/canary.ts` builds and simulates three swaps on mainnet state. Its scheduled workflow is off
  for now.

**Decisions made on purpose.** Challenge them only with a new argument:
- no on-chain program;
- the fee inside the transaction, at 0.2% (the owner's decision), taken like Jupiter's;
- one RPC provider;
- slippage 0.5%, and 3% on a Pump.fun bonding curve;
- HumidiFi excluded;
- v0 transactions, with v1 only for a route too big for v0, behind a flag;
- a skill for agents, not an SDK or an MCP server;
- tokenized stocks not now: the focus is agents and secure crypto swaps;
- no cap per swap.

**Known and open** (operations, not findings):
- no real-wallet test yet;
- keyless Jupiter and the public RPC during development;
- the treasury wallet and its USDC and USDT accounts to be funded and opened;
- treasury multisig;
- GitHub Actions blocked by billing, so the malicious-program test (T6) and CI do not run for now;
- canary off;
- the repository is private.

**Already tested by us** (do not ask for these again; read them if useful):
- about 400 unit, property and mutation tests, plus a 100,000-case fuzz of the verifier;
- mainnet simulations:
  - 30 pairs on v0 and v1;
  - runtime attacks;
  - minimum checks;
  - large amounts;
  - transfer-fee tokens;
  - issuer stablecoins;
  - Pump.fun curve and PumpSwap buys and sales;
  - Jupiter's floor and where it is measured;
  - the fee's side for each kind of pair;
- a malicious swap program executed against the real transaction in a Solana VM;
- browser tests of the page;
- agent dry runs.

| Path | What |
| --- | --- |
| `packages/core` | Constants, policy (intent → accounts, fee and its side, rent), compiler (v0/v1) |
| `packages/verifier` | `parse.ts` (exact shapes), `verify.ts` (the rules, Jupiter's arguments and destination, the Pump close, the fee), `certificate.ts` |
| `packages/solana` | Chain reads, simulation, send and confirm, retries, the one-time key |
| `packages/jupiter` | Jupiter client; `swap.ts`, the whole pipeline from quote to countersign |
| `apps/web/components/SwapApp.tsx` | The page: flow, refresh rules, every message a user reads |
| `apps/web/lib/server/*` | Relays and their shape filter, rate limits, the agent API (`agent/`) |
| `skills/orientim-protected-swap` | `SKILL.md`, `examples/swap.ts`, `src/verify.ts` (bundled into `lib/orientim-verify.mjs`) |
| `tools/`, `tests/`, `.github/workflows` | Canary, release digest, live check, keys; the tests above; CI |

---

## 2. Understand the ecosystem first

Before judging the code, learn how the world around it works now. Keep the notes short and sourced.

**Solana transactions today:**
- v0 and v1 formats;
- size and account limits;
- compute budget and priority fees;
- how transactions land (staked connections, Jito, re-broadcasting);
- blockhash lifetime at current slot times;
- durable nonces;
- rent;
- the SIMDs activated or scheduled in 2025–2026 that touch a transaction like Orientim's (fees,
  Alpenglow, account limits, slot times).

**Token programs:**
- the classic Token program as rewritten (p-token);
- Token-2022 and every extension, including the newest;
- account states: frozen, delegated, memo-required, CPI Guard.

**Jupiter:**
- Swap API v2 `/build` and `/order`;
- the on-chain program, its route instructions and how its floor is measured;
- its fee model;
- how often it changes, and how integrators hear about it.

**Pump.fun:** the bonding curve and PumpSwap, the per-buyer account, cashback, fees, migration, and
how often its programs change.

**Wallets:**
- the Wallet Standard;
- how Phantom, Solflare, Backpack, Ledger and others treat a transaction that needs a second
  signature, and whether they modify it;
- mobile;
- embedded and smart wallets.

**RPC:** confirmation semantics, lagging nodes, what providers offer, what they cost.

**Agents, in depth.** This is where we most need your research:
- How are trading agents built and run today? Look at frameworks, skills, MCP servers and hosted
  agent platforms.
- How do they hold keys? Local keypairs, remote signers and policy engines, human approval.
- How do they choose a swap route? What do they already use?
- What goes wrong for them in practice: prompt injection, malicious tokens and metadata, compromised
  tools or plugins, lost keys, drained wallets. Give real incidents where you can find them.
- What would make an agent developer trust, adopt and keep using a protected swap?

---

## 3. Security review by reasoning

Try to break Orientim on paper. For every path, work out what an attacker controls, what they gain, and
which rule stops them, citing the line.

**Who can be the attacker:**
- a malicious or buggy DEX inside a Jupiter route;
- a compromised or lying Jupiter API;
- a lying or lagging RPC;
- a compromised Orientim server or relay;
- a stolen API key, ticket or server secret;
- a wallet that modifies what it signs;
- a malicious token (Token-2022 extensions, hooks, delegates, metadata aimed at an agent);
- a front-runner;
- another swap into the same token at the same moment;
- a phishing copy of the page.

**Look especially at the newest code**, which has had the least review:
- **The fee on the output** (`AUDIT.md` 0t). The fee is paid by W after the swap: SOL for a sale into
  SOL, USDC or USDT from W's output account. Can it ever take more than 0.2% of what arrived? Can it
  be moved, repeated or redirected? Is its order relative to the minimum check exactly right? Look at
  the rounding in `minimumForReceived` and `outputFeeFor`, and at the rule that the treasury wallet
  must exist.
- **Jupiter's destination check** (`jupiterDestination`): the account positions it reads, and every
  form of route it could meet.
- **The skill's own floor** (`ownMinimum`). It asks Jupiter for the price, and so does Orientim. If
  Jupiter itself is wrong or compromised, what protects the agent? Is 2% (5% on a curve) the right
  margin?
- **The skill's simulation that E ends with nothing.** What can it not see?
- **The Pump refund:**
  - an account that already exists;
  - cashback;
  - a program upgrade;
  - the size limit.
- **The API:**
  - the ticket;
  - the HMAC and the derivation of E;
  - secret rotation;
  - idempotency;
  - the re-check of the output balance;
  - rate limits;
  - the relay's shape filter.
- **Freshness:** the block rules, and what happens when the wallet returns late.

**A case table.** Build it: each case, the expected behaviour (from the code), and a verdict of
safe, degraded (say how) or broken. Cover:
- the variants SOL → token, token → SOL and token → token;
- v0 and v1;
- the classic Token program and Token-2022;
- the Pump curve and PumpSwap;
- the fee on the input, on the output, or none;
- the page and the API.

---

## 4. The agents and the skill

- Read `SKILL.md`, `AGENT-API.md` and `examples/swap.ts` as an agent would. Could a language-model
  agent follow them correctly with no help? Where would it go wrong, skip a step, or be talked out
  of a check?
- Which key setups work, and which do not:
  - local keypairs;
  - remote signers that sign one of two signers;
  - human approval inside about 40 seconds;
  - smart accounts.
- **Agent-specific risks:**
  - hostile strings in token names, route labels and error messages;
  - an agent that skips the verification;
  - a tampered skill bundle;
  - a leaked API key;
  - an agent running many swaps at once.
- **What developers expect from a swap API:**
  - response shapes;
  - errors that say whether to retry;
  - idempotency;
  - latency;
  - clear pricing (fee, minimum, and which token the fee is in).
  Where does Orientim fall short?
- **What would make agents adopt it:** integrations, packaging, examples, distribution. Is a skill
  alone enough, or is something else needed? Give evidence, not taste.

---

## 5. Complexity and simplification

- **Where did we make things more complicated than they need to be?** Name the file and the
  function, why it is complex, and what a simpler version would look like with the same guarantee.
  Look especially at:
  - the pipeline (`packages/jupiter/src/swap.ts`);
  - the page (`SwapApp.tsx`);
  - the rent measurement and route repair;
  - the ticket system;
  - the relay filter;
  - two languages of documents;
  - the number of integration scripts.
- **What could be removed** without weakening a guarantee?
- **Ideas that would make Orientim easier** to build, operate, explain or sell:
  - features of Jupiter, wallets or providers we are not using;
  - standard components that replace custom ones;
  - fewer calls per swap;
  - simpler rules the verifier could enforce instead of complex ones.
  For each idea give:
  - the benefit;
  - the cost;
  - the risk;
  - what it would replace.

---

## 6. Market and need

- **Who needs Orientim, and how badly?**
  - users afraid of drainers and malicious approvals;
  - autonomous agents and bots with hot wallets;
  - wallets and apps that could integrate it;
  - funds and treasuries.
  Find evidence: losses to drainers and malicious swap tooling, agent adoption and incidents, what
  people pay today for safety.
- **Competitors and substitutes:**
  - wallet simulation and warnings;
  - Jupiter's own products;
  - trading bots;
  - policy engines (Turnkey, Privy and others);
  - smart accounts (Squads, Swig);
  - Lighthouse-style assertions.
  What does each protect, what does it cost, and where is Orientim better or worse?
- **Positioning:**
  - Is "the swap can only touch what you approved" understood and valued?
  - What is the sharpest one-sentence pitch for agents?
  - Which first customers make sense?
- **Business:**
  - Is 0.2%, taken like Jupiter's, sustainable after RPC and Jupiter costs?
  - Where does revenue still leak?
  - What does one incident cost the product?
- **Risks:**
  - regulation of a fee-taking swap interface;
  - dependency on Jupiter;
  - reputation;
  - concentration on memecoins.

---

## 7. What to deliver (a report, nothing else)

1. **Summary (one page).** The five biggest risks, the five biggest simplifications, and a verdict per
   area:
   - the page;
   - the API;
   - the skill;
   - Pump.fun;
   - the fee;
   - behaviour under upstream changes.

   Each verdict is one of: safe / likely / unknown / not.
2. **Ecosystem notes,** short and sourced.
3. **Security findings,** most severe first. Each with:
   - an ID;
   - a severity: Critical (funds beyond the guarantee), High (the guarantee or the fee broken, or a
     large group of users unable to swap), Medium, Low or Info;
   - the attacker and the preconditions;
   - the reasoning path, with `file:line`;
   - the impact;
   - the fix, in words;
   - the test we should run.
4. **The case table** from section 3.
5. **The agent review** from section 4.
6. **Simplifications and ideas,** ordered by value against effort, including what to remove.
7. **Market and need analysis.**
8. **Documentation errors.**
9. **Questions for the owner:** decisions only the owner can make, each with your recommendation.

Be direct and concrete. We would rather read "this is wrong because…" than "consider reviewing…".
