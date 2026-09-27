/** /api/health for uptime monitors, and /api/report: failures the page showed, logged without addresses. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkHealth } from '../lib/server/health.ts';
import { cleanReport, receiveReport, redact } from '../lib/server/report.ts';

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

describe('problem reports', () => {
  const W = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request('http://orientim.test/api/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vercel-forwarded-for': `192.0.2.${Math.floor(Math.random() * 250)}-${Math.random()}`, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('addresses and signatures are taken out, whatever field they are in', () => {
    expect(redact(`Swap ${SIG} from ${W} failed`)).toBe('Swap … from … failed');
    const r = cleanReport({ kind: 'error', title: `Failed for ${W}`, detail: `sig ${SIG}`, wallet: 'Phantom 25.1', pair: 'USDC → SOL' });
    expect(JSON.stringify(r)).not.toContain(W);
    expect(JSON.stringify(r)).not.toContain(SIG);
    expect(r).toMatchObject({ wallet: 'Phantom 25.1', pair: 'USDC → SOL' });
  });

  it('only known fields, cut to length; unknown ones (an amount, an address field) are dropped', () => {
    const r = cleanReport({ title: 'no route '.repeat(100), amount: '1000 USDC', owner: W, detail: 42 });
    expect(r).toEqual({ title: 'no route '.repeat(100).slice(0, 200) });
  });

  it('logs one line and stores nothing; refuses other sites, junk and floods', async () => {
    const log = vi.fn();
    expect((await receiveReport(post({ kind: 'error', title: "Couldn't build the swap" }), log)).status).toBe(204);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ type: 'orientim-problem', kind: 'error', title: "Couldn't build the swap" });

    expect((await receiveReport(post({ title: 'x' }, { 'sec-fetch-site': 'cross-site' }), log)).status).toBe(403);
    expect((await receiveReport(post('not json'), log)).status).toBe(400);
    expect((await receiveReport(post({ body: 'no title' }), log)).status).toBe(400);
    expect((await receiveReport(post({ title: 'x', detail: 'y'.repeat(5_000) }), log)).status).toBe(413);

    const ip = { 'x-vercel-forwarded-for': '192.0.2.77-flood' };
    for (let i = 0; i < 20; i++) expect((await receiveReport(post({ title: 't' }, ip), log)).status).toBe(204);
    expect((await receiveReport(post({ title: 't' }, ip), log)).status).toBe(429);
  });
});
