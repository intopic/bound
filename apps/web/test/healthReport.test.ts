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

describe('health of the agent API, as it runs', () => {
  const on = () => {
    process.env.ORIENTIM_API_SECRET = Buffer.alloc(32, 1).toString('base64');
    process.env.ORIENTIM_API_KEYS = `a:${'0'.repeat(64)}`;
    process.env.RPC_URL_AGENTS = 'https://agents.rpc.test/';
    process.env.JUPITER_API_KEY_AGENTS = 'agents-key';
  };
  afterEach(() => {
    for (const k of ['ORIENTIM_API_SECRET', 'ORIENTIM_API_KEYS', 'RPC_URL_AGENTS', 'JUPITER_API_KEY_AGENTS']) delete process.env[k];
  });
  const built = () => Response.json({ outAmount: '1500000', swapInstruction: { programId: 'x', accounts: [], data: '' } });
  /** fetch by host and path: the site's RPCs, the agent API's RPC, Jupiter's search and its build. */
  function world(agentsRpc: () => Response, build: () => Response, seen: string[] = []) {
    process.env.RPC_URL = 'https://main.rpc.test/';
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      seen.push(`${u.split('?')[0]} ${JSON.stringify((init?.headers ?? {}) as Record<string, string>)}`);
      if (u.startsWith('https://main.')) return height();
      if (u.startsWith('https://agents.')) return agentsRpc();
      return u.includes('/swap/v2/build') ? build() : tokens();
    }) as unknown as typeof fetch;
  }

  it("with the API off, it is not checked and not counted", async () => {
    const h = await checkHealth(world(down, down));
    expect(h.ok).toBe(true);
    expect(h.agents).toBeNull();
  });

  it("checks the API's own RPC and a swap Jupiter builds with the API's own key", async () => {
    on();
    const seen: string[] = [];
    const h = await checkHealth(world(height, built, seen));
    expect(h).toMatchObject({ ok: true, agents: { rpc: { ok: true }, build: { ok: true } } });
    expect(seen.some(s => s.startsWith('https://agents.rpc.test/'))).toBe(true);
    expect(seen.find(s => s.startsWith('https://api.jup.ag/swap/v2/build'))).toContain('agents-key');
    expect(JSON.stringify(h)).not.toMatch(/rpc\.test|agents-key|https?:/);
  });

  it("is down when the site's services answer but the API's RPC does not, or Jupiter answers without a swap", async () => {
    on();
    const down503 = () => new Response('no', { status: 503 });
    expect((await checkHealth(world(down, built))).ok).toBe(false);
    expect((await checkHealth(world(height, down503))).ok).toBe(false);
    expect((await checkHealth(world(height, () => Response.json({ error: 'no route' })))).ok).toBe(false);
    // The site's own checks still pass in each case: only the API's are down.
    const h = await checkHealth(world(down, built));
    expect(h).toMatchObject({ rpc: { ok: true }, jupiter: { ok: true }, agents: { rpc: { ok: false } } });
  });
});
