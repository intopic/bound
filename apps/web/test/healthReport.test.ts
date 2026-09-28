/** /api/health for uptime monitors. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkHealth } from '../lib/server/health.ts';

afterEach(() => {
  delete process.env.RPC_URL;
  delete process.env.RPC_URL_FALLBACK;
  delete process.env.ORIENTIM_DISABLED;
});

const height = () => Response.json({ jsonrpc: '2.0', id: 1, result: 312_000_000 });
const tokens = () => Response.json([{ id: 'So11111111111111111111111111111111111111112' }]);
const down = () => { throw new TypeError('fetch failed'); };

/** fetch by host: the main RPC, the backup, Jupiter. */
function hosts(main: () => Response, backup: () => Response, jupiter: () => Response) {
  process.env.RPC_URL = 'https://main.rpc.test/';
  process.env.RPC_URL_FALLBACK = 'https://backup.rpc.test/';
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    return u.startsWith('https://main.') ? main() : u.startsWith('https://backup.') ? backup() : jupiter();
  }) as unknown as typeof fetch;
}

describe('health', () => {
  it('up when an RPC and Jupiter answer', async () => {
    const h = await checkHealth(hosts(height, height, tokens));
    expect(h).toMatchObject({ ok: true, paused: false, rpc: { ok: true }, rpcFallback: { ok: true }, jupiter: { ok: true } });
  });

  it('the backup keeps it up while the main RPC is down; both down, or Jupiter down, is down', async () => {
    expect((await checkHealth(hosts(down, height, tokens))).ok).toBe(true);
    expect((await checkHealth(hosts(down, down, tokens))).ok).toBe(false);
    expect((await checkHealth(hosts(height, height, () => new Response('no', { status: 401 })))).ok).toBe(false);
    expect((await checkHealth(hosts(() => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -1 } }), down, tokens))).ok).toBe(false);
  });

  it('paused by the kill switch is said, not counted as down; no URL or key in the answer', async () => {
    process.env.ORIENTIM_DISABLED = '1';
    const h = await checkHealth(hosts(height, height, tokens));
    expect(h.ok).toBe(true);
    expect(h.paused).toBe(true);
    expect(JSON.stringify(h)).not.toMatch(/rpc\.test|https?:/);
  });
});
