/**
 * The backup RPC (RPC_URL_FALLBACK): asked only when the main one is down, rate-limited or failing,
 * and for a send, trusted only when it answers with a success.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { proxyRpc } from '../lib/server/rpcProxy.ts';
import { createServerRpc } from '../lib/server/rpcFailover.ts';
import { getBase64EncodedWireTransaction } from '@solana/kit';
import { compileProtectedSwap } from '@orientim/core';
import { LIFETIME, scenario } from '../../../packages/verifier/test/fixtures.ts';

let n = 0;
const request = (method: string, params: unknown[] = []) =>
  new Request('http://orientim.test/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vercel-forwarded-for': `198.51.100.${++n % 250}-failover-${n}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
const MAIN = 'https://main.rpc.test/';
const BACKUP = 'https://backup.rpc.test/';
const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result });
const refused = () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Blockhash not found' } });
const down = () => { throw new TypeError('fetch failed'); };

/** fetch, answered per host; returns the list of hosts asked, in order. */
function network(main: () => Response, backup: () => Response) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const u = String(url instanceof Request ? url.url : url);
    asked.push(u.startsWith(MAIN) ? 'main' : 'backup');
    return u.startsWith(MAIN) ? main() : backup();
  }));
  return asked;
}

afterEach(() => vi.unstubAllGlobals());

/** An Orientim transaction: the relay sends nothing else (FA-06). */
async function swapWire() {
  const s = await scenario();
  const { transaction } = compileProtectedSwap({
    policy: s.policy, swapInstruction: s.swapIx, intermediates: s.intermediates, version: 0, lifetime: LIFETIME,
    computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n, lookupTables: s.lookupTables, outputBalanceBefore: s.wOutBalance,
  });
  return [getBase64EncodedWireTransaction(transaction), { encoding: 'base64' }];
}

describe('the page relay with a backup RPC', () => {
  it('a healthy main RPC answers alone; the backup is never asked', async () => {
    const asked = network(() => ok(5), () => ok(6));
    const res = await proxyRpc(request('getBalance'), MAIN, BACKUP);
    expect(await res.json()).toMatchObject({ result: 5 });
    expect(asked).toEqual(['main']);
  });

  it('a main RPC that is down, rate-limited or failing hands the read to the backup', async () => {
    for (const main of [down, () => new Response('busy', { status: 429 }), () => new Response('oops', { status: 503 })]) {
      const asked = network(main, () => ok(6));
      const res = await proxyRpc(request('getBalance'), MAIN, BACKUP);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ result: 6 });
      expect(asked).toEqual(['main', 'backup']);
    }
  });

  it('an answer from the main RPC, even an error, is not an outage: the backup is not asked', async () => {
    const asked = network(() => refused(), () => ok(6));
    const res = await proxyRpc(request('getBalance'), MAIN, BACKUP);
    expect(await res.json()).toMatchObject({ error: { code: -32002 } });
    expect(asked).toEqual(['main']);
  });

  it('a send the main RPC did not answer takes the backup success', async () => {
    network(down, () => ok('5igSignature'));
    const res = await proxyRpc(request('sendTransaction', await swapWire()), MAIN, BACKUP);
    expect(await res.json()).toMatchObject({ result: '5igSignature' });
  });

  it('a refusal from the backup never replaces the main answer to a send: it may have been broadcast', async () => {
    const params = await swapWire();
    network(down, () => refused());
    const res = await proxyRpc(request('sendTransaction', params), MAIN, BACKUP);
    expect(res.status).toBe(504);
    expect(res.headers.get('x-orientim-not-forwarded')).toBeNull();

    network(() => new Response('busy', { status: 429 }), () => refused());
    expect((await proxyRpc(request('sendTransaction', params), MAIN, BACKUP)).status).toBe(429);
  });

  it('both down: a 504 that does not claim nothing was sent', async () => {
    network(down, down);
    const res = await proxyRpc(request('getBalance'), MAIN, BACKUP);
    expect(res.status).toBe(504);
    expect(res.headers.get('x-orientim-not-forwarded')).toBeNull();
  });

  it('without a backup, the main RPC alone, as before', async () => {
    const asked = network(down, () => ok(6));
    expect((await proxyRpc(request('getBalance'), MAIN)).status).toBe(504);
    expect(asked).toEqual(['main']);
  });
});

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

  it('a 4xx from the main RPC is its answer, not an outage', async () => {
    const asked = network(() => new Response('bad', { status: 400 }), () => ok({ context: { slot: 1 }, value: 1 }));
    await expect(createServerRpc(MAIN, BACKUP).getBalance('11111111111111111111111111111111' as never).send()).rejects.toThrow();
    expect(asked).toEqual(['main']);
  });
});
