# Failing cases

## F-01: `npm run test:fuzz` red on `345a82d`, harness timeout only

Seed 20260924, `extensions.test.ts`, 200,000 cases per property. All four fail with
`Error: Test timed out in 5000ms` and **no counterexample**:

| Property (line) | Duration |
| --- | --- |
| a set of entries is accepted exactly when none of them is refused… (63) | 24.3 s |
| every combination of the entries a swap can live with is accepted (77) | 32.5 s |
| an entry hidden after an empty slot is refused… (86) | 16.1 s |
| an area cut short is refused, wherever the cut falls (99) | 19.5 s |

The same four fail identically in GitHub Actions, Fuzz run 36059366291 on `345a82d`
(https://github.com/intopic/bound/actions/runs/36059366291, conclusion `failure`).

Re-run with `--testTimeout=3600000` at seeds 20260924, 1 and 777777: 12/12 pass, 2.4M cases
(`fuzz-HEAD-extensions-notimeout.log`). Cause: the properties are synchronous and, unlike those in
`property.test.ts`, pass no timeout to `it`, so vitest's 5 s default applies.

No property of the swap fuzz produced a counterexample at either commit.

## E5 (new, low): `bound-verify prepare` and `recover` throw when the state directory fails

Found by the agent API harness (`harness/agent-api-fuzz.harness.ts`, properties E5 and F/E5), on
HEAD `8f90ffb` and on `345a82d` and `ea3accd` alike. Minimal case, seed 20260924:
`{"list":[0]}` (the first `store.list()` fails, ENOSPC) with `prepare`, and the same with `recover`.

`runCli` calls `store.list()` and `store.order()` in `prepare`, and `recoverPending(store, …)` in
`recover`, outside any `try`; the error leaves `runCli`, `main()` rejects, and `bound-verify` exits
with a stack trace instead of JSON on stdout. Nothing is sent (the property checks it), so funds are
not at risk; a bot that parses stdout gets no answer it can read. `finalize` is not affected: its
reads are inside the `try` that answers `sent: false` / `unknown`.

Fix: wrap the store reads in `prepare` and all of `recover` so they answer
`{ code: 1, output: { ok: false, sent: false, error } }` (prepare) and
`{ code: 3, output: { ok: false, error } }` (recover: the outcome of what is kept is unknown).
Regression: E5 and F/E5 in the harness turn green; add both as unit tests in `skillExample.test.ts`.

## The Stage 2 findings, re-checked with the harness

H-01, H-02, M-01, M-02 and M-03 each fail at `345a82d` and `ea3accd` and pass at HEAD
(`harness-345a82d.log`, `harness-ea3accd.log`, `harness-HEAD.log`, `harness-fuzz-HEAD*.log`).
Counterexamples at `345a82d`, seed 20260924:

- H-01: `[pad 0, rent 1346200, cashback 1, curve]` → 200 without the close; `[pad 8, rent 1346200,
  cashback 0, curve]` → 200 without the close (the route too wide for it).
- H-02: two `protectedSwap` of one wallet started together → two transactions sent.
- M-01: `acquire(1), age, acquire(0), release(1), acquire(1)` → worker 1 holds again while 0 does.
- M-02: the agent's `simulateTransaction` never answers → the swap waits past 15 s (the guard).
- M-03: the record's removal fails after a confirmed swap → `{"ok":false,"sent":false,…}`.
