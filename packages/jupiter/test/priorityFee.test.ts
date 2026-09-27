import { describe, expect, it, vi } from 'vitest';
import type { Address } from '@solana/kit';
import { heliusPriorityFee } from '../src/priorityFee.ts';

const POOL = 'So11111111111111111111111111111111111111112' as Address;
const answer = (body: unknown, status = 200) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

describe("Helius's priority estimate", () => {
  it('asks for level High on the swap\'s writable accounts, and rounds the float up', async () => {
    const fetchImpl = answer({ jsonrpc: '2.0', id: 1, result: { priorityFeeEstimate: 120_000.4 } });
    expect(await heliusPriorityFee('https://rpc.test', fetchImpl as typeof fetch)([POOL])).toBe(120_001n);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ method: 'getPriorityFeeEstimate', params: [{ accountKeys: [POOL], options: { priorityLevel: 'High' } }] });
  });

  it('anything but a number is no estimate: the pipeline falls back to recent fees', async () => {
    for (const fetchImpl of [
      answer({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }),
      answer({ jsonrpc: '2.0', id: 1, result: { priorityFeeEstimate: 'lots' } }),
      answer({ jsonrpc: '2.0', id: 1, result: { priorityFeeEstimate: -5 } }),
      answer('busy', 429),
      vi.fn(async () => { throw new TypeError('fetch failed'); }),
    ]) {
      expect(await heliusPriorityFee('https://rpc.test', fetchImpl as unknown as typeof fetch)([POOL])).toBeNull();
    }
  });
});
