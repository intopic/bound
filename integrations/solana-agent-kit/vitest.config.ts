import { defineConfig } from 'vitest/config';

// The plugin's own tests, run here with its own dependencies (npm test in this folder).
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 } });
