import { isAddress } from '@solana/kit';
import { serverConfig } from './config';
import { clientKey, fromAnotherSite, rateLimited } from './rateLimit';

/**
 * Token icons are fetched by Bound's server and served from Bound's own origin (audit B-08). The
 * page keeps `img-src 'self' data:`, so injected script cannot use images to send data out, and
 * hosts chosen by token creators never see users' IP addresses.
 *
 * The browser sends only a mint address. The icon URL comes from Jupiter's token record, only HTTPS
 * hosts on this list are fetched, and every redirect is checked again, so the server cannot be
 * pointed into a private network. Tokens whose icon lives elsewhere show a letter instead.
 */
const HOST_SUFFIXES = [
  'arweave.net', 'ipfs.io', 'cf-ipfs.com', 'dweb.link', 'w3s.link', 'nftstorage.link', 'mypinata.cloud',
  'pinata.cloud', 'ipfs.filebase.io', 'irys.xyz', 'raw.githubusercontent.com', 'static.jup.ag',
  'img.fotofolio.xyz', 'shdw-drive.genesysgo.net', 'storage.googleapis.com', 'coingecko.com',
  's2.coinmarketcap.com', 'i.imgur.com', 'metadata.jito.network', 'pyth.network',
];
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 5_000;
const iconUrls = new Map<string, string | null>();

export const iconHostAllowed = (url: URL) =>
  url.protocol === 'https:' &&
  (url.port === '' || url.port === '443') &&
  !url.username &&
  !url.password &&
  HOST_SUFFIXES.some(h => url.hostname === h || url.hostname.endsWith(`.${h}`));

/** The served type comes from the bytes, never from the upstream header. */
export function sniffImage(b: Uint8Array): string | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

async function iconUrlOf(mint: string): Promise<string | null> {
  if (iconUrls.has(mint)) return iconUrls.get(mint)!;
  const { jupiterApiKey } = serverConfig();
  const base = jupiterApiKey ? 'https://api.jup.ag/tokens/v2/search' : 'https://lite-api.jup.ag/tokens/v2/search';
  const res = await fetch(`${base}?${new URLSearchParams({ query: mint })}`, {
    headers: jupiterApiKey ? { 'x-api-key': jupiterApiKey } : {},
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null; // not cached: may be transient
  const list: unknown = await res.json();
  const icon = Array.isArray(list) ? (list as { id?: string; icon?: unknown }[]).find(t => t.id === mint)?.icon : undefined;
  const url = typeof icon === 'string' ? icon : null;
  if (iconUrls.size >= 5_000) iconUrls.clear();
  iconUrls.set(mint, url);
  return url;
}

async function readLimited(body: ReadableStream<Uint8Array>): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function fetchImage(start: string): Promise<{ type: string; body: Uint8Array } | null> {
  let url: URL;
  try {
    url = new URL(start);
  } catch {
    return null;
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!iconHostAllowed(url)) return null;
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'image/*' } });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) return null;
      url = new URL(next, url);
      continue;
    }
    if (!res.ok || !res.body || Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return null;
    const body = await readLimited(res.body);
    const type = body && sniffImage(body);
    return body && type ? { type, body } : null;
  }
  return null;
}

const notFound = () =>
  new Response(null, { status: 404, headers: { 'cache-control': 'public, max-age=3600' } });

export async function proxyIcon(req: Request): Promise<Response> {
  if (fromAnotherSite(req)) return new Response(null, { status: 403 });
  if (rateLimited(`icon:${clientKey(req)}`, 600)) return new Response(null, { status: 429 });
  const mint = new URL(req.url).searchParams.get('mint') ?? '';
  if (!isAddress(mint)) return new Response(null, { status: 400 });
  try {
    const source = await iconUrlOf(mint);
    const image = source ? await fetchImage(source) : null;
    if (!image) return notFound();
    return new Response(image.body as Uint8Array<ArrayBuffer>, {
      headers: {
        'content-type': image.type,
        'cache-control': 'public, max-age=86400, s-maxage=604800',
        // An SVG opened directly must not run script or load anything.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return notFound();
  }
}
