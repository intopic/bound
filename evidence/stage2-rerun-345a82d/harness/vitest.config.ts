import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Runs only the agent API harness, from the repository root, with fast-check's seed fixed and printed.
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  test: {
    include: ['evidence/stage2-rerun-345a82d/harness/*.harness.ts'],
    setupFiles: [fileURLToPath(new URL('../fc-seed.setup.ts', import.meta.url))],
  },
});
