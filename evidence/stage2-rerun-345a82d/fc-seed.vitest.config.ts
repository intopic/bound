import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The default config, run from the repository root, plus a setup file that fixes and prints
// fast-check's seed:  BOUND_FC_SEED=20260924 npx vitest run <files> -c evidence/stage2-rerun-345a82d/fc-seed.vitest.config.ts
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: { setupFiles: [fileURLToPath(new URL('./fc-seed.setup.ts', import.meta.url))] },
});
