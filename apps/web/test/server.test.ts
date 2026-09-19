/**
 * The server-side controls from both reviews (B-05, B-06, B-08, C-04, C-07, C-08): they must hold
 * for direct API calls, not only for requests made by Bound's own page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { iconHostAllowed, proxyIcon, sniffImage } from '../lib/server/iconProxy.ts';
import { proxyBuild } from '../lib/server/jupiterProxy.ts';
import { clientKey, rateLimited } from '../lib/server/rateLimit.ts';
import { LOOKUP_METHODS, proxyRpc } from '../lib/server/rpcProxy.ts';

let n = 0;
const uniqueIp = () => `203.0.113.${++n % 250}-${n}`;
const rpcRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://bound.test/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vercel-forwarded-for': uniqueIp(), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const upstreamOk = () => vi.fn(async () => Response.json({ jsonrpc: '2.0', id: 1, result: 'ok' }));

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BOUND_DISABLED;
  delete process.env.BOUND_CLIENT_IP_HEADER;
});

describe('B-06, C-04: the client key comes only from the header the ingress overwrites', () => {
  const key = (headers: Record<string, string>) => clientKey(new Request('http://bound.test/', { headers }));

  it('on Vercel (default) it reads x-vercel-forwarded-for and ignores every other header', () => {
    expect(key({ 'x-vercel-forwarded-for': '198.51.100.7', 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' })).toBe('198.51.100.7');
  });

  it('behind Cloudflare, a client-sent x-vercel-forwarded-for cannot mint a new identity (C-04)', () => {
    process.env.BOUND_CLIENT_IP_HEADER = 'cf-connecting-ip';
    expect(key({ 'cf-connecting-ip': '198.51.100.8', 'x-vercel-forwarded-for': 'spoofed-1' })).toBe('198.51.100.8');
    expect(key({ 'cf-connecting-ip': '198.51.100.8', 'x-vercel-forwarded-for': 'spoofed-2' })).toBe('198.51.100.8');
  });

  it('X-Forwarded-For, written by the client, is never used', () => {
    expect(key({ 'x-forwarded-for': 'spoofed, 198.51.100.9' })).toBe('unidentified');
  });

  it('requests without the configured header share one bucket (limited, not unlimited)', () => {
    expect(key({})).toBe('unidentified');
  });

  it('a window counts every request of the same key', () => {
    const k = `test:${uniqueIp()}`;
    for (let i = 0; i < 5; i++) expect(rateLimited(k, 5)).toBe(false);
    expect(rateLimited(k, 5)).toBe(true);
  });
});

describe('RPC proxy', () => {
  it('forwards allowlisted methods, including getFeeForMessage and the rent query', async () => {
    const upstream = upstreamOk();
    vi.stubGlobal('fetch', upstream);
    for (const method of ['getFeeForMessage', 'getMinimumBalanceForRentExemption']) {
      const res = await proxyRpc(rpcRequest({ jsonrpc: '2.0', id: 1, method, params: [] }), 'https://rpc.test');
      expect(res.status).toBe(200);
    }
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('refuses other methods and batches', async () => {
    const upstream = upstreamOk();
    vi.stubGlobal('fetch', upstream);
    expect((await proxyRpc(rpcRequest({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [] }), 'https://rpc.test')).status).toBe(403);
    expect((await proxyRpc(rpcRequest([{ jsonrpc: '2.0', id: 1, method: 'getBalance' }]), 'https://rpc.test')).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('C-07: the body limit counts bytes, not characters', async () => {
    const upstream = upstreamOk();
    vi.stubGlobal('fetch', upstream);
    // 40,000 two-byte characters: under 64 KiB of characters, 80,000 bytes on the wire.
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: ['ë'.repeat(40_000)] });
    expect(body.length).toBeLessThan(64 * 1024);
    expect((await proxyRpc(rpcRequest(body), 'https://rpc.test')).status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('an upstream that does not answer becomes a 504, not a hanging request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); }));
    expect((await proxyRpc(rpcRequest({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [] }), 'https://rpc.test')).status).toBe(504);
  });

  it('the second RPC answers only the reads that lookup tables need', async () => {
    const upstream = upstreamOk();
    vi.stubGlobal('fetch', upstream);
    const call = (method: string) => proxyRpc(rpcRequest({ jsonrpc: '2.0', id: 1, method, params: [] }), 'https://rpc2.test', LOOKUP_METHODS);
    expect((await call('getMultipleAccounts')).status).toBe(200);
    expect((await call('sendTransaction')).status).toBe(403);
    expect((await call('simulateTransaction')).status).toBe(403);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('B-05: the kill switch refuses sendTransaction on the server, with a 4xx (never forwarded)', async () => {
    process.env.BOUND_DISABLED = '1';
    const upstream = upstreamOk();
    vi.stubGlobal('fetch', upstream);
    const res = await proxyRpc(rpcRequest({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: ['AA=='] }), 'https://rpc.test');
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('B-06: sendTransaction has its own limit per client, sized for re-broadcasts', async () => {
    vi.stubGlobal('fetch', upstreamOk());
    const ip = uniqueIp();
    const send = () =>
      proxyRpc(rpcRequest({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: ['AA=='] }, { 'x-vercel-forwarded-for': ip }), 'https://rpc.test');
    for (let i = 0; i < 60; i++) expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
  });
});

describe('Jupiter build proxy', () => {
  const build = (query: string) =>
    proxyBuild(new Request(`http://bound.test/api/jupiter/build?${query}`, { headers: { 'x-vercel-forwarded-for': uniqueIp() } }));

  it('B-05: the kill switch refuses new builds on the server', async () => {
    process.env.BOUND_DISABLED = '1';
    const upstream = upstreamOk();
    vi.stubGlobal('fetch', upstream);
    expect((await build('inputMint=a&wrapAndUnwrapSol=false')).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses payer and SOL wrapping (D12)', async () => {
    const upstream = upstreamOk();
    vi.stubGlobal('fetch', upstream);
    expect((await build('inputMint=a&payer=b&wrapAndUnwrapSol=false')).status).toBe(400);
    expect((await build('inputMint=a&wrapAndUnwrapSol=true')).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('B-08: token icons are served from Bound, from listed hosts only', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  // Each test uses its own mint, because the proxy caches icon URLs per mint.
  const MINTS = [
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  ];
  const icon = (mint: string) =>
    proxyIcon(new Request(`http://bound.test/api/token-icon?mint=${mint}`, { headers: { 'x-vercel-forwarded-for': uniqueIp() } }));
  /**
   * Jupiter's token record for the mint that was asked for points at `iconUrl` (C-08: the record
   * must match the requested mint, or the proxy stops before the path under test). Every fetched
   * URL is recorded, so each test can assert which hosts were actually contacted.
   */
  const stubNetwork = (iconUrl: string, pages: Record<string, () => Response>) => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/tokens/v2/search')) {
        const mint = new URL(url).searchParams.get('query');
        return Response.json([{ id: mint, icon: iconUrl }]);
      }
      return pages[url]?.() ?? new Response('not found', { status: 404 });
    }));
    return seen;
  };

  it('host allowlist: HTTPS on a listed host only', () => {
    expect(iconHostAllowed(new URL('https://arweave.net/abc'))).toBe(true);
    expect(iconHostAllowed(new URL('https://bafy.ipfs.nftstorage.link/'))).toBe(true);
    expect(iconHostAllowed(new URL('http://arweave.net/abc'))).toBe(false);
    expect(iconHostAllowed(new URL('https://arweave.net:8443/abc'))).toBe(false);
    expect(iconHostAllowed(new URL('https://user:pw@arweave.net/abc'))).toBe(false);
    expect(iconHostAllowed(new URL('https://evilarweave.net/abc'))).toBe(false);
    expect(iconHostAllowed(new URL('https://arweave.net.evil.example/abc'))).toBe(false);
    expect(iconHostAllowed(new URL('https://169.254.169.254/latest/meta-data'))).toBe(false);
  });

  it('the served type comes from the bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('﻿ <svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml');
    expect(sniffImage(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull();
  });

  it('serves a listed icon with a locked-down CSP', async () => {
    const seen = stubNetwork('https://arweave.net/icon', {
      'https://arweave.net/icon': () => new Response(PNG, { headers: { 'content-type': 'application/octet-stream' } }),
    });
    const res = await icon(MINTS[0]);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(seen).toContain('https://arweave.net/icon');
  });

  it('never fetches a private-network URL from token metadata', async () => {
    const seen = stubNetwork('http://169.254.169.254/latest/meta-data', {});
    expect((await icon(MINTS[1])).status).toBe(404);
    expect(seen.some(u => u.includes('/tokens/v2/search'))).toBe(true); // the record was read…
    expect(seen.some(u => u.includes('169.254'))).toBe(false); // …and its URL refused
  });

  it('re-checks every redirect', async () => {
    const seen = stubNetwork('https://arweave.net/redirect', {
      'https://arweave.net/redirect': () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/admin' } }),
    });
    expect((await icon(MINTS[2])).status).toBe(404);
    expect(seen).toContain('https://arweave.net/redirect'); // the listed host was visited…
    expect(seen.some(u => u.includes('10.0.0.1'))).toBe(false); // …its redirect was not followed
  });

  it('follows a redirect that stays on listed hosts', async () => {
    const seen = stubNetwork('https://arweave.net/moved', {
      'https://arweave.net/moved': () => new Response(null, { status: 301, headers: { location: 'https://ipfs.io/ipfs/icon' } }),
      'https://ipfs.io/ipfs/icon': () => new Response(PNG),
    });
    expect((await icon(MINTS[3])).status).toBe(200);
    expect(seen).toContain('https://ipfs.io/ipfs/icon');
  });

  it('refuses a body that is not an image, and oversized bodies', async () => {
    let seen = stubNetwork('https://arweave.net/html', {
      'https://arweave.net/html': () => new Response('<html></html>', { headers: { 'content-type': 'image/png' } }),
    });
    expect((await icon(MINTS[4])).status).toBe(404);
    expect(seen).toContain('https://arweave.net/html');
    const big = new Uint8Array(600 * 1024);
    big.set(PNG);
    seen = stubNetwork('https://arweave.net/big', { 'https://arweave.net/big': () => new Response(big) });
    expect((await icon(MINTS[5])).status).toBe(404);
    expect(seen).toContain('https://arweave.net/big');
  });

  it('rejects a request that is not a mint address', async () => {
    const upstream = upstreamOk();
    vi.stubGlobal('fetch', upstream);
    expect((await icon('https%3A%2F%2Fevil.example%2Fx')).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});
