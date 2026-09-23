/**
 * Which chunks a page signs itself: the page's own scripts, and none of the ones Next already signs.
 * A polyfill preloaded here would be downloaded by every modern browser for nothing.
 */
import { describe, expect, it } from 'vitest';
import { chunksToSign } from '../lib/server/scriptIntegrity.ts';

describe('chunksToSign', () => {
  const build = {
    rootMainFiles: ['static/chunks/main.js', 'static/chunks/turbopack-runtime.js'],
    polyfillFiles: ['static/chunks/polyfill.js'],
  };
  const integrity = {
    'static/chunks/main.js': 'sha384-main',
    'static/chunks/turbopack-runtime.js': 'sha384-runtime',
    'static/chunks/polyfill.js': 'sha384-polyfill',
    'static/chunks/page-a.js': 'sha384-a',
    'static/chunks/page-b.js': 'sha384-b',
    'static/chunks/styles.css': 'sha384-css',
    'static/media/icon.svg': 'sha384-icon',
  };

  it('returns the page chunks with their hashes, as the URLs React writes', () => {
    expect(chunksToSign(integrity, build)).toEqual([
      ['/_next/static/chunks/page-a.js', 'sha384-a'],
      ['/_next/static/chunks/page-b.js', 'sha384-b'],
    ]);
  });

  it('leaves out bootstrap chunks, polyfills, stylesheets and media', () => {
    const urls = chunksToSign(integrity, build).map(([url]) => url);
    for (const skipped of ['main.js', 'turbopack-runtime.js', 'polyfill.js', 'styles.css', 'icon.svg']) {
      expect(urls.some(url => url.endsWith(skipped))).toBe(false);
    }
  });

  it('signs nothing when there is no manifest content', () => {
    expect(chunksToSign({}, {})).toEqual([]);
  });
});
