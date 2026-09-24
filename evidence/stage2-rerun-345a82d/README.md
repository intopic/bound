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

## Not run here

- The engineer's harness (`agent-api-fuzz.test.ts`), the 8 adversarial tests and the report's
  commands: those files are not in the repository.
- Read-only mainnet simulations: the container's network policy refuses `api.mainnet-beta.solana.com`,
  `api.jup.ag` and `lite-api.jup.ag`.
- T6 (`npm run cpi`): `cargo build-sbf` cannot be installed (`release.anza.xyz` and GitHub releases refused).
