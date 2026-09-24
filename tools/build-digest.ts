/**
 * One number for the code a browser actually runs.
 *
 * A user who visits Bound is trusting that the page served is the page that was audited. The only
 * way to make that checkable is to publish a digest of the built client assets and let anyone
 * rebuild from the same tag and compare. This computes that digest: every file under
 * `apps/web/.next/static`, hashed, sorted by path, hashed again.
 *
 * The HTML itself is not part of it — it carries a fresh CSP nonce on every request, so it differs
 * by design. What the HTML loads is pinned instead: subresource integrity (`experimental.sri`)
 * puts a hash of each script in the tag that loads it, so a browser refuses a modified one. That
 * catches assets changed on the way, or by a CDN, under an honest page; a host that serves its own
 * HTML can serve its own hashes with it (engineering review, section 8). What checks the host is
 * `live-check.yml` comparing the live assets with this digest, and an agent's own verifier.
 *
 *   node tools/build-digest.ts [--write]
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = 'apps/web/.next/static';
const OUT = 'apps/web/.next/build-digest.txt';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

let files: string[];
try {
  files = walk(ROOT);
} catch {
  console.error(`No build found at ${ROOT}. Run: npm run build`);
  process.exit(2);
}

// Sorted by the path the browser would request, so the digest does not depend on the file system.
const entries = files
  .map(path => ({
    name: relative(ROOT, path).split(sep).join('/'),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));

const manifest = entries.map(e => `${e.hash}  ${e.name}`).join('\n');
const digest = createHash('sha256').update(manifest).digest('hex');
const report = `${manifest}\n\nfiles: ${entries.length}\ndigest: ${digest}\n`;

if (process.argv.includes('--write')) {
  writeFileSync(OUT, report);
  console.log(`${entries.length} files → ${OUT}`);
}
console.log(digest);
