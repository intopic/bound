/**
 * What the package ships: dist/ as `import` and `require` load it, each the whole plugin, with the
 * agent's own copies of @solana/web3.js and zod left outside.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  const built = spawnSync(process.execPath, ['build.ts'], { encoding: 'utf8' });
  expect(built.status, built.stderr).toBe(0);
}, 60_000);

describe('dist', () => {
  it('loads with import and with require, each the whole plugin', async () => {
    // Built by beforeAll, so not there for the type check.
    const esm = await import(new URL('../dist/index.js', import.meta.url).href);
    const cjs = createRequire(import.meta.url)('../dist/index.cjs');
    for (const m of [esm, cjs]) {
      expect(m.default.name).toBe('orientim');
      expect(Object.keys(m.default.methods).sort()).toEqual(['orientimApiKey', 'orientimSwap']);
      expect(m.default.actions[0].name).toBe('ORIENTIM_PROTECTED_SWAP');
      expect(typeof m.createOrientimPlugin).toBe('function');
      expect(m.toBaseUnits(0.5, 9)).toBe(500_000_000n);
    }
  });

  it('leaves @solana/web3.js, zod, @solana/kit and the Agent Kit to the agent\'s project', () => {
    for (const file of ['dist/index.js', 'dist/index.cjs']) {
      const code = readFileSync(file, 'utf8');
      expect(code).not.toMatch(/class VersionedTransaction\b/);
      expect(code).not.toMatch(/class ZodType\b/);
      expect(code).toMatch(/["']@solana\/web3\.js["']/);
      expect(code).toMatch(/["']zod["']/);
    }
  });
});
