/**
 * Builds the plugin into dist/: one file for `import` and one for `require`, with the skill's swap
 * and verifier bundled in. What the agent's project already has stays outside: @solana/kit (a
 * dependency), and solana-agent-kit, @solana/web3.js and zod, which must be the agent's own copies
 * (the Agent Kit tells a zod schema and a transaction by their class).
 *
 *   node build.ts
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { rolldown } from 'rolldown';

const EXTERNAL = ['@solana/kit', '@solana/web3.js', 'zod', 'solana-agent-kit'];
const external = (id: string) => id.startsWith('node:') || EXTERNAL.some(e => id === e || id.startsWith(`${e}/`));
const banner = '// @orientim/plugin-solana-agent-kit: built by build.ts; do not edit.';

mkdirSync('dist', { recursive: true });
const bundle = await rolldown({ input: 'src/index.ts', external, platform: 'node', logLevel: 'warn' });
for (const [format, file] of [['esm', 'index.js'], ['cjs', 'index.cjs']] as const) {
  const { output } = await bundle.generate({ format, banner, exports: 'named' });
  const code = output[0].code;
  // The skill's command-line guard reads import.meta.url; a `require` build must not carry it.
  if (format === 'cjs' && /import\.meta/.test(code)) throw new Error('dist/index.cjs mentions import.meta');
  writeFileSync(`dist/${file}`, code);
}
await bundle.close();
copyFileSync('types/index.d.ts', 'dist/index.d.ts');
copyFileSync('types/index.d.ts', 'dist/index.d.cts');
console.log('dist/index.js, dist/index.cjs, dist/index.d.ts, dist/index.d.cts');
