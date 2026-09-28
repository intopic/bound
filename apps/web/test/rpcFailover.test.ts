/**
 * The backup RPC (RPC_URL_FALLBACK): asked only when the main one is down, rate-limited or failing,
 * and for a send, trusted only when it answers with a success.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerRpc } from '../lib/server/rpcFailover.ts';

const MAIN = 'https://main.rpc.test/';
const BACKUP = 'https://backup.rpc.test/';
const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result });
const refused = () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Blockhash not found' } });
const down = () => { throw new TypeError('fetch failed'); };

/** An RPC that never answers: the request ends only when its signal does. */
const hangs = (init?: RequestInit) => new Promise<Response>((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
});

type Answer = (init?: RequestInit) => Response | Promise<Response>;

/** fetch, answered per host; returns the list of hosts asked, in order. */
function network(main: Answer, backup: Answer) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    asked.push(u.startsWith(MAIN) ? 'main' : 'backup');
    return u.startsWith(MAIN) ? main(init) : backup(init);
  }));
  return asked;
}

/** Milliseconds a call took. */
async function timed<T>(f: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now();
  const out = await f();
  return [out, Date.now() - start];
}

afterEach(() => vi.unstubAllGlobals());

describe('the agent API RPC with a backup', () => {
  it('reads go to the backup when the main RPC is down', async () => {
    const asked = network(down, () => ok({ context: { slot: 1 }, value: 42 }));
    const rpc = createServerRpc(MAIN, BACKUP);
    const { value } = await rpc.getBalance('11111111111111111111111111111111' as never).send();
    expect(value).toBe(42n);
    expect(asked).toEqual(['main', 'backup']);
  });

  it('a send takes the backup only when it succeeds', async () => {
    network(down, () => ok('5igSignature'));
    expect(await createServerRpc(MAIN, BACKUP).sendTransaction('AA==' as never, { encoding: 'base64' }).send()).toBe('5igSignature');

    network(down, () => refused());
    await expect(createServerRpc(MAIN, BACKUP).sendTransaction('AA==' as never, { encoding: 'base64' }).send()).rejects.toThrow(/fetch failed/);
  });

  const QUICK = { totalMs: 300, attemptMs: 200, minSendMs: 150 };
  const balance = () => ok({ context: { slot: 1 }, value: 42 });

  it('the main RPC and the backup share one deadline', async () => {
    const asked = network(hangs, balance);
    const [{ value }, ms] = await timed(() => createServerRpc(MAIN, BACKUP, QUICK).getBalance('11111111111111111111111111111111' as never).send());
    expect(value).toBe(42n);
    expect(asked).toEqual(['main', 'backup']);
    expect(ms).toBeGreaterThanOrEqual(190);

    network(hangs, hangs);
    const start = Date.now();
    await expect(createServerRpc(MAIN, BACKUP, QUICK).getBalance('11111111111111111111111111111111' as never).send()).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(QUICK.totalMs + 80);
  });

  it('a send is not started on the backup with too little time left', async () => {
    const asked = network(hangs, () => ok('5igSignature'));
    await expect(createServerRpc(MAIN, BACKUP, QUICK).sendTransaction('AA==' as never, { encoding: 'base64' }).send()).rejects.toThrow();
    expect(asked).toEqual(['main']);
  });

  it('a rate-limited backup stops retrying at the deadline', async () => {
    network(down, () => new Response('busy', { status: 429 }));
    const start = Date.now();
    await expect(createServerRpc(MAIN, BACKUP, { totalMs: 400, attemptMs: 200, minSendMs: 150 })
      .getBalance('11111111111111111111111111111111' as never).send()).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(480);
  });

  it('a 4xx from the main RPC is its answer, not an outage', async () => {
    const asked = network(() => new Response('bad', { status: 400 }), () => ok({ context: { slot: 1 }, value: 1 }));
    await expect(createServerRpc(MAIN, BACKUP).getBalance('11111111111111111111111111111111' as never).send()).rejects.toThrow();
    expect(asked).toEqual(['main']);
  });
});
