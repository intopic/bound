/**
 * The skill's example (skills/bound-protected-swap/examples/swap.ts) is what agents will copy, so it
 * runs here end to end against the real agent API handlers, and its checks must catch a response
 * that is not what was asked for.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { address, generateKeyPairSigner } from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { ataOf, WSOL_MINT } from '@bound/core';
import { DEX, fakeJupiter, fakeRpc, mint, POOL, tokenAccount, USDC } from '../../../packages/jupiter/test/fakes.ts';
import type { Account } from '../../../packages/jupiter/test/fakes.ts';
import { agentFinalize, agentPrepare } from '../lib/server/agent/api.ts';
import type { AgentDeps } from '../lib/server/agent/api.ts';
import { checkPrepared, protectedSwap } from '../../../skills/bound-protected-swap/examples/swap.ts';
import type { Intent, Prepared } from '../../../skills/bound-protected-swap/examples/swap.ts';

const KEY = 'bnd_skill_example_test_key_0001';
const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

async function bound() {
  const accounts = new Map<string, Account>([
    [USDC, mint(6)], [WSOL_MINT, mint(9)],
    [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [POOL, { owner: DEX, data: new Uint8Array(300) }],
    [await ataOf(TREASURY, USDC), tokenAccount(TREASURY, USDC)],
  ]);
  const sent: string[] = [];
  const deps: AgentDeps = {
    rpc: fakeRpc(accounts, { sent }), jupiter: fakeJupiter(), secrets: [new Uint8Array(32).fill(3)],
    keys: new Map([[createHash('sha256').update(KEY).digest('hex'), 'skill-test']]),
    feeBps: 20n, treasury: TREASURY, excludeDexes: ['HumidiFi'], maxNetworkFeeLamports: 200_000n,
    disabled: false, v1: false, perMinute: 1_000,
  };
  // The API as the agent reaches it over HTTP.
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const req = new Request(url, init);
    return url.endsWith('/api/v1/prepare') ? agentPrepare(req, deps) : agentFinalize(req, deps);
  }) as unknown as typeof fetch;
  return { deps, sent, fetchImpl };
}

/** The agent's own RPC: the transaction confirms on the first look. */
const confirmingRpc = {
  getSignatureStatuses: () => ({ send: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }) }),
  getBlockHeight: () => ({ send: async () => 1n }),
  sendTransaction: () => ({ send: async () => 'sig' }),
} as unknown as Rpc<SolanaRpcApi>;

describe("the skill's example", () => {
  it('prepares, checks, signs as the wallet, finalizes and confirms', async () => {
    const b = await bound();
    const wallet = await generateKeyPairSigner();
    const result = await protectedSwap({
      apiUrl: 'http://bound.test', apiKey: KEY, rpc: confirmingRpc, wallet, fetchImpl: b.fetchImpl, pollMs: 1,
      intent: { inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000' },
    });
    expect(result.outcome).toBe('confirmed');
    expect(result.prepared.amounts.fee).toBe('2000');
    expect(b.sent).toHaveLength(1);
  });

  it('refuses to sign a response that differs from what was asked', async () => {
    const b = await bound();
    const wallet = await generateKeyPairSigner();
    const res = await b.fetchImpl('http://bound.test/api/v1/prepare', {
      method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ owner: wallet.address, inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000' }),
    });
    const honest = (await res.json()) as Prepared;
    const intent: Intent = { owner: wallet.address, inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000' };
    expect(await checkPrepared(honest, intent)).toEqual([]);

    const cases: [string, Prepared, Partial<Intent>][] = [
      ['a higher fee than accepted', honest, { maxFeeBps: 10 }],
      ['another amount', honest, { amountIn: '999999' }],
      ['another output token', honest, { outputMint: USDC }],
      ['another wallet', honest, { owner: (await generateKeyPairSigner()).address }],
      ['a minimum below the one asked for', honest, { minOut: String(10n ** 15n) }],
      ['a message that is not the one hashed', { ...honest, messageSha256: '0'.repeat(64) }, {}],
      ['a certificate for other amounts', { ...honest, certificate: { ...honest.certificate, input: { ...honest.certificate.input, totalDebit: '5' } } }, {}],
    ];
    for (const [name, prepared, change] of cases) {
      expect((await checkPrepared(prepared, { ...intent, ...change })).length, name).toBeGreaterThan(0);
    }
  });
});
