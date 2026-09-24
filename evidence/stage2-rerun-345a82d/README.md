# Stage 2 re-run on `345a82d`

Run on 2026-09-24 in a cloud container. Nothing was signed, sent or deployed.

- **SHA:** `345a82d8590319b967ede3f65bbc8e18b3ae7e44`, working tree clean. That is **not** `ea3accd`, the
  commit the fuzz report was written against: `8e1c3af` and `345a82d` sit on top of it and change
  the verifier, `packages/solana`, `packages/jupiter` and `apps/web/lib/server/agent/api.ts`. The swap
  fuzz is therefore run at both commits with the same seed.
- **Seeds:** `fc-seed.setup.ts` fixes fast-check's seed (`BOUND_FC_SEED`) and prints it. Note that
  the fixtures also draw fresh keys (`generateKeyPairSigner`), so a seed fixes the shapes, not the keys.

## Results

| Run | Result | Log |
| --- | --- | --- |
| `npm run typecheck` | pass | `results/typecheck-HEAD.log` |
| `npm test` (seed 20260924) | 495/495 | `results/unit-HEAD.log`, `.junit.xml` |
| `node tools/build-skill.ts --check` | pass | `results/build-skill-check-HEAD.log` |
| Existing agent/API, skill, send tests | 126/126 | `results/agent-api-existing-HEAD.log` |
| `npm run test:fuzz`, `extensions.test.ts` (200,000 cases/property) | **4/4 properties fail: "Test timed out in 5000ms"** | `results/fuzz-HEAD-345a82d.log` |
| Same file, `--testTimeout=3600000`, seeds 20260924, 1, 777777 | 4/4 properties pass, 2.4M cases, no counterexample | `results/fuzz-HEAD-extensions-notimeout.log` |
| `npm run test:fuzz`, `property.test.ts` (100,000 cases/property), `345a82d`, seed 20260924 | 3/3 properties pass, 300,000 cases, 45 min | `results/fuzz-HEAD-345a82d.log`, `.junit.xml` |
| `npm run test:fuzz` at `ea3accd` (only `property.test.ts` existed), seed 20260924 | 3/3 properties pass, 300,000 cases, 45 min | `results/fuzz-ea3accd.log`, `.junit.xml` |
| GitHub Actions Fuzz run 36059366291 on `345a82d` | **failure**, the same four timeouts | `results/FAILURES.md` |

The `extensions.test.ts` failure is the harness, not the verifier: its synchronous properties carry
no timeout of their own, so vitest's default 5 s applies to 16–32 s of work. `npm run test:fuzz`,
and so `fuzz.yml`, is red on `345a82d` for that reason alone (`results/FAILURES.md`, F-01).

What these runs show: the verifier's properties hold on the shapes and attacks the generators
produce. They say nothing about the agent/API server, recovery under faulty RPCs, or anything the
engineer's harness and adversarial tests cover; see below.

## Reproduce

```sh
npm ci
BOUND_FC_SEED=20260924 npx vitest run packages/verifier/test/property.test.ts packages/verifier/test/extensions.test.ts \
  --mode fuzz -c evidence/stage2-rerun-345a82d/fc-seed.vitest.config.ts --reporter=verbose
# the matrix without the 5 s default timeout
BOUND_FC_SEED=20260924 npx vitest run packages/verifier/test/extensions.test.ts \
  --mode fuzz -c evidence/stage2-rerun-345a82d/fc-seed.vitest.config.ts --testTimeout=3600000
```

## Agent API harness (written here)

The engineer's `agent-api-fuzz.test.ts` is not in the repository, so a harness of its own was
written: `harness/agent-api-fuzz.harness.ts`, property tests (fast-check) over `/api/v1/prepare`,
`/api/v1/finalize` and the skill (lock, pending store, orders, `bound-verify`), against the fake
chain and Jupiter the unit tests use. It is **not** the engineer's harness and its results do not
stand in for theirs. It runs outside `npm test` (a failing property is a finding, not a broken build):

```sh
BOUND_FC_SEED=20260924 npx vitest run -c evidence/stage2-rerun-345a82d/harness/vitest.config.ts            # 25 cases per property
BOUND_FC_SEED=20260924 npx vitest run -c evidence/stage2-rerun-345a82d/harness/vitest.config.ts --mode fuzz # 1,000 (B: 4,000; M-01: 8,000)
```

HEAD is now `8f90ffb`: this branch with `origin/main` at `0c5565d` merged in, which carries the
owner's Stage 2 fixes (`2055db7`, AUDIT.md 0zc). The same harness was run on `345a82d` and `ea3accd`
(product code at that commit, `packages/jupiter/test/fakes.ts` from HEAD so the fake world is the
same), to check that each property catches what it claims to.

| Property | HEAD `8f90ffb` | `345a82d` | `ea3accd` |
| --- | --- | --- | --- |
| A1 prepare: any body, key or header: no 500, no send | pass (1,000) | pass | pass |
| A2 prepare: a 200 is exactly its message, unsigned, sealed to key and wallet, fee ≤ 1% | pass (1,000; 1,000 × 200) | pass | pass |
| H-01 prepare: a 200 leaves nothing under E; cashback refused | pass (1,000; 278 built with rent, all closed) | **fails**: rent (1,346,200) left under E, with cashback and when the close does not fit (8 accounts of padding) | **fails**, same |
| B finalize: changed ticket, message, signature, key, wire: nothing sent; anything sent is canonical | pass (4,000) | pass | pass |
| C finalize repeated under faults: one transaction, nothing after landing, while paused or when unreadable | pass (1,000 sequences, 3,412 calls) | pass | pass |
| D secret rotation | pass (500) | pass | pass |
| M-01 lock: one holder; a superseded worker never frees its successor | pass (8,000 sequences) | **fails**: A stale, B takes over, A releases B's lock, C acquires | **fails**, same |
| H-02 swaps started together: at most one transaction | pass (500 races) | **fails**: 2 transactions | **fails**, same |
| M-02 a call that never answers: ends in time, ≤ 1 transaction, no throw after a send | pass (1,000) | **fails**: hangs on the check's `simulateTransaction` | **fails**, same |
| M-03 bookkeeping fails (store injected): the answer keeps the chain's outcome | pass (1,000; 734 sent) | not testable (no store to inject into) | not testable |
| M-03 via the file system (ENOSPC on remove) | pass | **fails**: `sent: false` after a confirmed swap | **fails**, same |
| **E5** `bound-verify prepare`/`recover` answer a result when the state directory fails | **fails** | fails | fails |

Two defects of the harness itself were found and fixed while writing it, before these runs: the
lock property had no timeout of its own (the same mistake as F-01), and a changed message with an
unknown version byte was refused by kit in the harness before it reached the API.

What the harness does not cover: the page (M-04 and the page side of H-01 and M-02), Bound's server
RPC transport timeout (a real HTTP transport, not a fake), and anything about the real chain,
Jupiter or wallets: the fakes answer the way the tests' authors expect the chain to.

## Not run here

- The engineer's harness (`agent-api-fuzz.test.ts`), the 8 adversarial tests and the report's
  commands: those files are not in the repository.
- Read-only mainnet simulations: the container's network policy refuses `api.mainnet-beta.solana.com`,
  `api.jup.ag` and `lite-api.jup.ag`.
- T6 (`npm run cpi`): `cargo build-sbf` cannot be installed (`release.anza.xyz` and GitHub releases refused).
