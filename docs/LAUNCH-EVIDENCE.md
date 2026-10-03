# Launch evidence

The five things to prove before the agent API is opened to everyone, and where each proof is. A
criterion is met only when every row under it says **proven**; **pending** rows name what is left.

## 1. The release, end to end

The mainnet simulation matrix (`tools/sim/matrix.sim.ts`, `.github/workflows/sim-matrix.yml`) runs
real mainnet state to the last check before signing, with the agent's own routes. Its summary
names every case that is not a pass, every market Orientim promises and every side of the fee that
it did not prove that run, and whose routes built each swap.

| What | Where | Status |
| --- | --- | --- |
| SOL/USDC and the major pairs, sizes from $1 to $5M | matrix: repeat, sizes, pairs, majors, whales, giants, more-tokens | proven: run 37082912774 (skill 1.10.0; 1.10.1 changes only the handling of an early refusal): 736 cases, 606 passed, 119 refused for a stated reason, 11 untested (no holder, Jupiter busy, a route failing in the check twice), 0 to look at; up to $5M (SOL → USDC, impact 0.48%); 606 × 9 rules read apart, 0 broken; time per pass median 5.6 s, 95th 22.6 s |
| The Pump.fun curve and PumpSwap | matrix: pump; the canary, every six hours | the curve proven (run 37082912774 (skill 1.10.0; 1.10.1 changes only the handling of an early refusal), 2 passes); PumpSwap proven by the canary's review (run 37080045238): in the matrix the graduated tokens it picked were routed through other markets |
| The agent's routes, and the fall back to Orientim's | matrix: every case (`own_routes=1`), and fallback (routes understated 100 times) | proven: run 37082912774 (skill 1.10.0; 1.10.1 changes only the handling of an early refusal): the agent's routes built 603 passes, Orientim's after the agent's were not used 3, fallback 3 of 4 passed (the fourth: the price moved) |
| The fee on the input, on the output, and in SOL | matrix analysis, "The fee's side in the passes"; `agentApi.test.ts`, "the fee on the output, exactly as documented" | proven: tests; run 37082912774 (skill 1.10.0; 1.10.1 changes only the handling of an early refusal): input 286, output 252, in SOL 68 passes |
| A dishonest server | matrix: tamper (8 changes on 14 real transactions) | proven: run 37082912774 (skill 1.10.0; 1.10.1 changes only the handling of an early refusal): 96 changes on 12 real transactions, 96 refused, 0 missed |
| An early refusal of the agent's own | "the agent's own refusal while the first round is still out is not left unhandled" (the matrix found 17 unhandled rejections in run 37082912774; fixed in 1.10.1) | proven (test) |
| Timeouts and `429` | `skillExample.test.ts`: "Jupiter that does not answer in time is busy", "Jupiter's rate limit is waited out", "swaps sharing one Jupiter key wait", "still busy after four asks" | proven (tests) |
| Expiry | "a status node behind the finalized view keeps the outcome unknown; a covering one proves expiry", "right after its lifetime, the same silence does prove it expired", the archive tests | proven (tests) |
| Interruption and recovery | "what a stopped run kept is settled by its own signature on the next start", "a stopped run leaves the order pending; recovery settles it", "finalize asked again while a stopped run still holds the lock" | proven (tests); pilot pending |
| The same order again | "an order that confirmed is not prepared again", "orientim-verify: prepare refuses an order that already swapped (exit 5)", "two runs of one order" | proven (tests); pilot pending |
| Several workers | "one worker per wallet", "two workers retrying an order whose last attempt expired: only one sends it", "an abandoned marker is taken by one worker only" | proven (tests); pilot pending |

## 2. One budget for the whole preparation

| What | Where | Status |
| --- | --- | --- |
| Own quote, routes, retries, 429 pauses, the fee-in-SOL quote and the checks share 110 s and 48 asks | `prepareChecked` (skill 1.9.4) | proven |
| The 49th ask is never sent; no round restarts the budget | "one budget for the whole preparation: the 49th ask of Jupiter is never sent" | proven (test) |
| The fall back to Orientim's routes runs in the time left and stops unsigned | "the fall back to Orientim's own routes runs within the time the preparation has left" | proven (test) |
| Spent before signing, nothing is signed | "a preparation past its time stops before signing" | proven (test) |

## 3. The integration contract

| What | Where | Status |
| --- | --- | --- |
| The fee by its side, the output's on the guaranteed minimum; the client route checked within 1% | developers page, "Fees and limits" and "Your own Jupiter key"; `AGENT-API.md`, "Fee" | proven (a test holds the page to it) |
| `ownRoutes` moves Jupiter's requests; the RPC's use said apart | developers page and `AGENT-API.md`, "Who asks what" | proven (test) |
| `sent` and `unknown` are not final | developers page, "Results and recovery"; `AGENT-API.md`, "Finalize" | proven (test) |
| No order database; what a direct client keeps and runs | developers page; `AGENT-API.md`, "Direct API integration contract" | proven (test) |
| A new developer can integrate, restarts included, from the quickstart | developers page, "Quickstart" step 5 and "On every start" | pending: one integration by someone new, unaided |

## 4. Monitoring and operations

| What | Where | Status |
| --- | --- | --- |
| Health, the deployed commit and its CI, the skill served | `monitor.yml`, every ten minutes | proven: run 37080387875 (health ok in 738 ms, build 4a88976 on main, its CI passed, the skill served is the source's) |
| Upstream programs and swaps on mainnet state | `canary.yml`, every six hours; `upstream-review.yml` after a redeploy | proven: the first run caught Jupiter, the Pump.fun curve and PumpSwap redeployed; the review (run 37080045238: Jupiter's floor, 7 swaps of 7, PumpSwap and the curve included) passed and the deploys are recorded |
| The site against its release | `live-check.yml`, every six hours | on (run 37080390469 passed: the deployed commit has no release tag yet, so nothing to compare); a tag on a deployed commit makes it compare |
| Errors, latency, quotas, falls back to Orientim's routes | the `orientim.*` events (`docs/OPERATORS.md`, "What the logs count") | proven (tests); dashboards are the operator's |
| Limits across instances | a firewall rate-limit rule on `/api/v1/` | **pending: the operator's approval** |
| Pause, revoke a key, roll back | `docs/OPERATORS.md`, "Drills" | **pending: the operator's drills** |

## 5. The pilot

| What | Where | Status |
| --- | --- | --- |
| The plan | `docs/PILOT.md` | ready |
| The check | `tools/pilot-report.ts` (tested in `pilotReport.test.ts`) | ready |
| 100 confirmed swaps over three days, every exercise done, no failure | the operator's pilot | **pending** |
