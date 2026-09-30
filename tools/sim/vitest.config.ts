import { defineConfig } from 'vitest/config';

// The mainnet simulation matrix only (tools/sim/matrix.sim.ts): never part of `npm test`, which must
// not reach mainnet. Run by hand or by .github/workflows/sim-matrix.yml.
export default defineConfig({
  test: {
    include: ['tools/sim/**/*.sim.ts'],
    testTimeout: 4 * 60 * 60_000,
    hookTimeout: 60_000,
  },
});
