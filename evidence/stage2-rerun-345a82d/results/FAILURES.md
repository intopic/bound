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
