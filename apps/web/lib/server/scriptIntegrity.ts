import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { preload } from 'react-dom';

/**
 * Subresource integrity for the chunks of a page's client components.
 *
 * `experimental.sri` puts a hash on the scripts Next writes itself (the bootstrap chunks and the
 * polyfills), but not on the chunks of client components: React writes those tags while it streams
 * the page, and Next does not give it their hashes. React does copy the integrity of an earlier
 * preload of the same URL onto the tag it writes, so a page that preloads its own chunks with their
 * hashes, before anything else of it is rendered, gets the hash onto those tags too. The hashes are
 * the ones Next writes for each page at build time, next to its build manifest.
 *
 * Next's chunk for the layout (router, error boundaries) is written before any page code runs, so
 * it stays without a hash; the build digest covers it (SECURITY.md).
 */

type IntegrityManifest = Record<string, string>;
type BuildManifest = { rootMainFiles?: string[]; polyfillFiles?: string[] };

/** The page's script chunks that Next does not sign itself, as [URL, integrity]. */
export function chunksToSign(integrity: IntegrityManifest, build: BuildManifest): [string, string][] {
  const signedByNext = new Set([...(build.rootMainFiles ?? []), ...(build.polyfillFiles ?? [])]);
  return Object.entries(integrity)
    .filter(([file]) => file.startsWith('static/chunks/') && file.endsWith('.js') && !signedByNext.has(file))
    .map(([file, hash]) => [`/_next/${file}`, hash]);
}

const loaded = new Map<string, [string, string][]>();

function load(page: string): [string, string][] {
  let chunks = loaded.get(page);
  if (!chunks) {
    chunks = [];
    // Only a production build writes the manifests; `next dev` leaves the tags as they are.
    if (process.env.NODE_ENV === 'production') {
      try {
        const dir = join(/* turbopackIgnore: true */ process.cwd(), '.next', 'server', 'app', page);
        const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
        chunks = chunksToSign(read('subresource-integrity-manifest.json'), read('build-manifest.json'));
      } catch {
        // No manifest: the page still works, its chunks just carry no hash (the browser test says so).
      }
    }
    loaded.set(page, chunks);
  }
  return chunks;
}

/**
 * Call first thing in a page, before its first `await`, so the preloads reach React before the tags
 * for the page's chunks are written. `page` is the page's path under `app/`: 'page',
 * 'diagnostic/page'. The preload itself is never sent: the script tag replaces it.
 */
export function signPageChunks(page: string) {
  for (const [src, integrity] of load(page)) preload(src, { as: 'script', integrity });
}
