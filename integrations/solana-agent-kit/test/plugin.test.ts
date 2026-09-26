/**
 * The plugin inside a real Solana Agent Kit, against Orientim's real agent API handlers and a fake
 * chain (the harness of apps/web/test/skillExample.test.ts): the agent's own wallet class signs, the
 * AI frameworks' tools call the action, and every way a swap should not go ahead is refused before
 * anything is sent.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { address, getPublicKeyFromAddress, getSignatureFromTransaction, getTransactionDecoder, verifySignature } from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import type { Transaction } from '@solana/web3.js';
import {
  createLangchainTools, createOpenAITools, createVercelAITools, executeAction, KeypairWallet, SolanaAgentKit,
} from 'solana-agent-kit';
import type { BaseWallet, Config } from 'solana-agent-kit';
import { ataOf, WSOL_MINT } from '@orientim/core';
import { BONK, DEX, fakeJupiter, fakeRpc, fundedAccounts, mint, POOL, tokenAccount, USDC } from '../../../packages/jupiter/test/fakes.ts';
import type { Account } from '../../../packages/jupiter/test/fakes.ts';
import { agentFinalize, agentPrepare } from '../../../apps/web/lib/server/agent/api.ts';
import type { AgentDeps } from '../../../apps/web/lib/server/agent/api.ts';
import { keyChallenge, keyIssue } from '../../../apps/web/lib/server/agent/access.ts';
import type { AccessDeps } from '../../../apps/web/lib/server/agent/access.ts';
import { ORIENTIM_TREASURY } from '../../../skills/orientim-protected-swap/lib/orientim-verify.mjs';
import OrientimPlugin, { createOrientimPlugin, fromBaseUnits, SOL_MINT, swapSchema, toBaseUnits } from '../src/index.ts';
import type { OrderBook, OrderRecord, OrientimPluginOptions, PendingStore, Signed } from '../src/index.ts';

const SHARED = Symbol.for('@orientim/plugin-solana-agent-kit/shared');

const API = 'http://orientim.test';
const KEY = 'ori_plugin_test_key_000000000001';
const KEY_SECRET = new Uint8Array(32).fill(21);
const TREASURY = address(ORIENTIM_TREASURY);

/** Jupiter as the agent reaches it itself, over HTTP; `better` bps above what Orientim's server was quoted. */
const jupiterAnswer = async (url: string, better = 0, change: (a: Record<string, unknown>) => Record<string, unknown> = a => a) => {
  const q = new URL(url).searchParams;
  const r = await fakeJupiter().build({
    inputMint: address(q.get('inputMint')!), outputMint: address(q.get('outputMint')!), amount: BigInt(q.get('amount')!),
    taker: address(q.get('taker')!), slippageBps: Number(q.get('slippageBps')), maxAccounts: Number(q.get('maxAccounts')),
  });
  return Response.json(change(better ? { ...r, outAmount: String((BigInt((r as { outAmount: string }).outAmount) * BigInt(10_000 + better)) / 10_000n) } : r as Record<string, unknown>));
};

/**
 * Orientim and the chain, for a wallet holding USDC; the agent's RPC sees each swap confirm, after
 * `slowLooks` looks that find nothing yet.
 */
async function orientimFor(
  owner: string, slowLooks = 0, edit?: (prepared: Record<string, unknown>) => Record<string, unknown>, better = 0,
  jupiter?: (a: Record<string, unknown>) => Record<string, unknown>, mints?: (m: Map<string, Account>, owner: string) => Promise<void> | void,
) {
  const accounts = new Map<string, Account>([
    [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
    [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [POOL, { owner: DEX, data: new Uint8Array(300) }],
    [await ataOf(TREASURY, USDC), tokenAccount(TREASURY, USDC)],
    ...await fundedAccounts(address(owner), USDC),
  ]);
  await mints?.(accounts, owner);
  const sent: string[] = [];
  const rpc = fakeRpc(accounts, { sent });
  const deps: AgentDeps = {
    rpc, jupiter: fakeJupiter(), secrets: [new Uint8Array(32).fill(3)],
    keys: new Map([[createHash('sha256').update(KEY).digest('hex'), 'plugin-test']]), keySecrets: [KEY_SECRET],
    feeBps: 30n, treasury: TREASURY, excludeDexes: [], maxNetworkFeeLamports: 200_000n, disabled: false, v1: false, perMinute: 1_000,
  };
  const access: AccessDeps = {
    rpc: { getBalance: () => ({ send: async () => ({ value: 50_000_000n }) }) } as unknown as AccessDeps['rpc'],
    keySecrets: [KEY_SECRET], minLamports: 10_000_000n,
  };
  const calls: string[] = [];
  const prepared: Record<string, unknown>[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/api/v1/prepare')) prepared.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (url.startsWith('https://api.jup.ag/')) return jupiterAnswer(url, better, jupiter);
    const req = new Request(url, init);
    if (url.includes('/api/v1/keys/challenge')) return keyChallenge(req, access);
    if (url.endsWith('/api/v1/keys')) return keyIssue(req, access);
    if (!url.endsWith('/api/v1/prepare')) return agentFinalize(req, deps);
    const res = await agentPrepare(req, deps);
    // A server that lies: its answer changed on the way.
    return edit && res.ok ? Response.json(edit(await res.json() as Record<string, unknown>)) : res;
  }) as typeof fetch;
  let looks = 0;
  const agentRpc = {
    ...rpc,
    getSignatureStatuses: () => ({ send: async () => ({ value: [++looks <= slowLooks ? null : { confirmationStatus: 'confirmed', err: null }] }) }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { sent, calls, prepared, fetchImpl, agentRpc };
}

/** A real Agent Kit with its own keypair wallet (or `wrap` around it), and the plugin. */
type AgentOptions = {
  config?: Config; plugin?: OrientimPluginOptions; wrap?: (w: BaseWallet, kp: Keypair) => BaseWallet; slowLooks?: number;
  edit?: (prepared: Record<string, unknown>) => Record<string, unknown>;
  /** The market the agent sees is this many bps better than what Orientim's server quotes. */
  better?: number;
  /** Jupiter's answer to the agent, changed. */
  jupiter?: (a: Record<string, unknown>) => Record<string, unknown>;
  /** The chain's mints and accounts, changed. */
  mints?: (m: Map<string, Account>, owner: string) => Promise<void> | void;
};
async function agentWith(opts: AgentOptions = {}) {
  const kp = Keypair.generate();
  const b = await orientimFor(kp.publicKey.toBase58(), opts.slowLooks, opts.edit, opts.better, opts.jupiter, opts.mints);
  const again = (plugin: OrientimPluginOptions = {}) => {
    const keypairWallet = new KeypairWallet(kp, 'http://127.0.0.1:1');
    const wallet = opts.wrap ? opts.wrap(keypairWallet, kp) : keypairWallet;
    const p = createOrientimPlugin({ apiUrl: API, rpc: b.agentRpc, fetchImpl: b.fetchImpl, pollMs: 1, acceptInMemoryState: true, ...plugin });
    return new SolanaAgentKit(wallet, 'http://127.0.0.1:1', opts.config ?? { OTHER_API_KEYS: { ORIENTIM_API_KEY: KEY } }).use(p);
  };
  /** `again`: the same wallet in another copy of the plugin, as a second process or server would have it. */
  return { agent: again(opts.plugin), again, kp, ...b };
}

const USDC_FOR_SOL = { inputMint: USDC, outputMint: SOL_MINT, inputAmount: 1 };

describe('whole tokens and base units', () => {
  it('turns an amount into base units, rounding down, never up', () => {
    expect(toBaseUnits(0.1, 9)).toBe(100_000_000n);
    expect(toBaseUnits('0.1', 9)).toBe(100_000_000n);
    expect(toBaseUnits(1e-7, 9)).toBe(100n);
    expect(toBaseUnits(1.23456789, 6)).toBe(1_234_567n);
    expect(toBaseUnits(12, 0)).toBe(12n);
    expect(toBaseUnits(0.30000000000000004, 1)).toBe(3n);
  });

  it('rounds a minimum up, never down (independent audit, ORI-05)', () => {
    expect(toBaseUnits(0.9, 0, 'up')).toBe(1n);
    expect(toBaseUnits('995000000.9', 0, 'up')).toBe(995_000_001n);
    expect(toBaseUnits('1.0000001', 6, 'up')).toBe(1_000_001n);
    expect(toBaseUnits('1.0000000', 6, 'up')).toBe(1_000_000n);
    expect(toBaseUnits(2.5, 6, 'up')).toBe(2_500_000n);
  });

  it('refuses what is not an amount, or is below the smallest unit', () => {
    for (const bad of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 'abc', '1e5', '', '0.0000000001']) {
      expect(() => toBaseUnits(bad, 9)).toThrow(/Nothing was prepared/);
    }
  });

  it('turns base units back into whole tokens', () => {
    expect(fromBaseUnits('100000000', 9)).toBe('0.1');
    expect(fromBaseUnits('1', 6)).toBe('0.000001');
    expect(fromBaseUnits(0n, 6)).toBe('0');
    expect(fromBaseUnits('1000000', 6)).toBe('1');
  });
});

describe('a swap through the plugin', () => {
  it('prepares, checks, signs with the agent\'s wallet, sends once and reports in whole tokens', async () => {
    const { agent, kp, sent } = await agentWith();
    const r = await agent.methods.orientimSwap(agent, USDC_FOR_SOL);
    expect(r.outcome).toBe('confirmed');
    expect(r.amounts.amountIn).toBe('1000000');
    expect(r.inputAmount).toBe('1');
    expect(r.amounts.feeBps).toBe('30');
    expect(r.explorer).toBe(`https://solscan.io/tx/${r.signature}`);
    expect(sent).toHaveLength(1);
    // The wallet's own signature, over the exact message that was checked.
    const tx = getTransactionDecoder().decode(Buffer.from(sent[0], 'base64'));
    const W = address(kp.publicKey.toBase58());
    expect(await verifySignature(await getPublicKeyFromAddress(W), tx.signatures[W]!, tx.messageBytes)).toBe(true);
  });

  it('refuses a wallet that changes the transaction, and one that does not sign: nothing is sent', async () => {
    const changing = await agentWith({
      wrap: (w, kp) => Object.assign(Object.create(Object.getPrototypeOf(w)), w, {
        async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
          (tx as VersionedTransaction).message.recentBlockhash = Keypair.generate().publicKey.toBase58();
          (tx as VersionedTransaction).sign([kp]);
          return tx;
        },
      }),
    });
    await expect(changing.agent.methods.orientimSwap(changing.agent, USDC_FOR_SOL)).rejects.toThrow(/changed the transaction/);
    expect(changing.sent).toHaveLength(0);

    const silent = await agentWith({
      wrap: w => Object.assign(Object.create(Object.getPrototypeOf(w)), w, {
        signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => tx,
      }),
    });
    await expect(silent.agent.methods.orientimSwap(silent.agent, USDC_FOR_SOL)).rejects.toThrow(/no (valid )?signature/);
    expect(silent.sent).toHaveLength(0);
  });

  it('takes one swap per wallet at a time: two at once run one after the other', async () => {
    // The first one takes a while to confirm: the second must wait for it, not stand down.
    const { agent, sent } = await agentWith({ slowLooks: 40 });
    const [a, b] = await Promise.all([agent.methods.orientimSwap(agent, USDC_FOR_SOL), agent.methods.orientimSwap(agent, USDC_FOR_SOL)]);
    expect([a.outcome, b.outcome]).toEqual(['confirmed', 'confirmed']);
    expect(a.signature).not.toBe(b.signature);
    // Two transactions (the slow one is sent again while it waits: the same one lands at most once).
    const signatures = new Set(sent.map(w => getSignatureFromTransaction(getTransactionDecoder().decode(Buffer.from(w, 'base64')))));
    expect([...signatures].sort()).toEqual([a.signature, b.signature].sort());
  });

  it('refuses before anything is prepared: the same token, an address that is not a token, signOnly', async () => {
    const { agent, calls } = await agentWith();
    await expect(agent.methods.orientimSwap(agent, { ...USDC_FOR_SOL, outputMint: USDC })).rejects.toMatchObject({ code: 'same-token' });
    await expect(agent.methods.orientimSwap(agent, { ...USDC_FOR_SOL, outputMint: 'not-a-mint' })).rejects.toMatchObject({ code: 'invalid-mint' });
    await expect(agent.methods.orientimSwap(agent, { ...USDC_FOR_SOL, outputMint: Keypair.generate().publicKey.toBase58() }))
      .rejects.toMatchObject({ code: 'not-a-token' });
    const signOnly = await agentWith({ config: { signOnly: true, OTHER_API_KEYS: { ORIENTIM_API_KEY: KEY } } });
    await expect(signOnly.agent.methods.orientimSwap(signOnly.agent, USDC_FOR_SOL)).rejects.toMatchObject({ code: 'sign-only' });
    expect([...calls, ...signOnly.calls].filter(u => u.includes('/api/v1/'))).toEqual([]);
  });
});

describe('the API key', () => {
  it('without one, the wallet signs Orientim\'s key message once; the key is kept and handed over', async () => {
    const onApiKey = vi.fn();
    const signed: string[] = [];
    const { agent, calls } = await agentWith({
      config: {},
      plugin: { onApiKey },
      wrap: w => Object.assign(Object.create(Object.getPrototypeOf(w)), w, {
        signMessage: async (m: Uint8Array) => (signed.push(new TextDecoder().decode(m)), w.signMessage(m)),
      }),
    });
    expect((await agent.methods.orientimSwap(agent, USDC_FOR_SOL)).outcome).toBe('confirmed');
    expect((await agent.methods.orientimSwap(agent, USDC_FOR_SOL)).outcome).toBe('confirmed');
    expect(signed).toHaveLength(1);
    expect(signed[0]).toContain('Get an Orientim API key for this wallet.');
    expect(onApiKey).toHaveBeenCalledTimes(1);
    expect(onApiKey.mock.calls[0][0].key).toMatch(/^ori_w1\./);
    expect(calls.filter(u => u.endsWith('/api/v1/keys'))).toHaveLength(1);
  });

  it('with autoKey off and no key, stops before signing anything', async () => {
    const signMessage = vi.fn();
    const { agent, calls } = await agentWith({
      config: {}, plugin: { autoKey: false },
      wrap: w => Object.assign(Object.create(Object.getPrototypeOf(w)), w, { signMessage }),
    });
    await expect(agent.methods.orientimSwap(agent, USDC_FOR_SOL)).rejects.toMatchObject({ code: 'no-api-key' });
    expect(signMessage).not.toHaveBeenCalled();
    expect(calls.filter(u => u.includes('/api/v1/'))).toEqual([]);
  });
});

describe('the action in the AI frameworks', () => {
  it('is one tool, ORIENTIM_PROTECTED_SWAP, in the default plugin as in a configured one', () => {
    expect(OrientimPlugin.actions.map(a => a.name)).toEqual(['ORIENTIM_PROTECTED_SWAP']);
    expect(OrientimPlugin.name).toBe('orientim');
  });

  it('runs through Vercel AI and LangChain, and answers with success and the signature', async () => {
    const { agent, sent } = await agentWith();
    const input = { outputMint: SOL_MINT, inputMint: USDC, inputAmount: 1 };
    const vercel = Object.values(createVercelAITools(agent, agent.actions))[0] as unknown as { execute: (p: unknown, o: unknown) => Promise<Record<string, unknown>> };
    const v = await vercel.execute(input, { toolCallId: '1', messages: [] });
    expect(v).toMatchObject({ status: 'success', outcome: 'confirmed', inputAmount: '1' });
    const [langchain] = createLangchainTools(agent, agent.actions);
    const l = JSON.parse(await langchain.invoke(input)) as Record<string, unknown>;
    expect(l).toMatchObject({ status: 'success', outcome: 'confirmed' });
    expect(sent).toHaveLength(2);
  });

  it('builds for OpenAI\'s agents, where every field is required and "none" is null', async () => {
    const { agent, sent } = await agentWith();
    const [tool] = createOpenAITools(agent, agent.actions) as unknown as { name: string; parameters: { required: string[]; properties: Record<string, { type: unknown }> } }[];
    expect(tool.name).toBe('ORIENTIM_PROTECTED_SWAP');
    expect(tool.parameters.required.sort()).toEqual(['inputAmount', 'inputMint', 'outputMint', 'slippageBps']);
    expect(tool.parameters.properties.inputMint.type).toEqual(['string', 'null']);
    // What such a model sends: null for a field it leaves out.
    const r = await executeAction(agent.actions[0], agent, { outputMint: SOL_MINT, inputAmount: 1, inputMint: USDC, slippageBps: null });
    expect(r).toMatchObject({ status: 'success', outcome: 'confirmed' });
    expect(sent).toHaveLength(1);
    // A null input is SOL: SOL for SOL is refused before anything is prepared.
    const sol = await executeAction(agent.actions[0], agent, { outputMint: SOL_MINT, inputAmount: 1, inputMint: null, slippageBps: null });
    expect(sol).toMatchObject({ status: 'error', code: 'same-token' });
  });

  it('answers a refusal as an error the model can relay, with Orientim\'s code', async () => {
    const { agent } = await agentWith();
    const bad = await executeAction(agent.actions[0], agent, { outputMint: USDC, inputAmount: -1 });
    expect(bad).toMatchObject({ status: 'error' });
    const same = await agent.actions[0].handler(agent, { outputMint: USDC, inputMint: USDC, inputAmount: 1 });
    expect(same).toMatchObject({ status: 'error', code: 'same-token' });
    const invalid = await agent.actions[0].handler(agent, { outputMint: USDC, inputAmount: 'lots' });
    expect(invalid).toMatchObject({ status: 'error', code: 'invalid-input' });
  });

  it('keeps the schema the frameworks read', () => {
    expect(swapSchema.safeParse({ outputMint: USDC, inputAmount: 1 }).success).toBe(true);
    expect(swapSchema.safeParse({ outputMint: USDC, inputAmount: 1, inputMint: null, slippageBps: null }).success).toBe(true);
    expect(swapSchema.safeParse({ outputMint: USDC, inputAmount: 0 }).success).toBe(false);
  });
});

describe('the independent audit of 26 September (ORI)', () => {
  const unsettled = { slowLooks: 1e9, plugin: { maxWaitMs: 40 } };

  it('ORI-01: a number that is not one is refused before the wallet signs; nothing is sent', async () => {
    const { agent, sent } = await agentWith({
      edit: p => ({ ...p, amounts: { ...(p.amounts as Record<string, unknown>), quotedOut: 'not-a-number' } }),
    });
    await expect(agent.methods.orientimSwap(agent, USDC_FOR_SOL)).rejects.toThrow(/malformed: amounts\.quotedOut/);
    const tool = await agent.actions[0].handler(agent, { outputMint: SOL_MINT, inputMint: USDC, inputAmount: 1 });
    expect(tool).toMatchObject({ status: 'error' });
    expect(sent).toHaveLength(0);
  });

  it('ORI-02: a swap that may still land stops every copy of the plugin in the process, not only its own', async () => {
    const { agent, again, sent } = await agentWith(unsettled);
    expect((await agent.methods.orientimSwap(agent, USDC_FOR_SOL)).outcome).toBe('unknown');
    const sends = sent.length;
    const second = again({ maxWaitMs: 40 });
    await expect(second.methods.orientimSwap(second, USDC_FOR_SOL)).rejects.toMatchObject({ code: 'swap-unsettled' });
    expect(sent).toHaveLength(sends);
  });

  it('ORI-02: with stateDir, a restarted process finds the swap that may still land and sends nothing new', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'orientim-plugin-'));
    const { agent, again, sent } = await agentWith({ ...unsettled, plugin: { maxWaitMs: 40, stateDir } });
    expect((await agent.methods.orientimSwap(agent, USDC_FOR_SOL)).outcome).toBe('unknown');
    const sends = sent.length;
    const g = globalThis as unknown as Record<symbol, unknown>;
    const before = g[SHARED];
    delete g[SHARED]; // a new process: nothing in memory
    try {
      const restarted = again({ maxWaitMs: 40, stateDir });
      await expect(restarted.methods.orientimSwap(restarted, USDC_FOR_SOL)).rejects.toMatchObject({ code: 'swap-unsettled' });
      expect(sent).toHaveLength(sends);
    } finally {
      g[SHARED] = before;
    }
  });

  it('ORI-02: a store of your own is the one used, so servers that share it share the guard', async () => {
    const inner = new Map<string, Signed>();
    const orders = new Map<string, OrderRecord>();
    const store: PendingStore & OrderBook = {
      put: async s => void inner.set(s.signature, s), remove: async sig => void inner.delete(sig), list: async () => [...inner.values()],
      order: async id => orders.get(id) ?? null, recordOrder: async (id, r) => void orders.set(id, r),
      claimOrder: async (id, r) => (orders.has(id) ? false : (orders.set(id, r), true)),
    };
    const { agent, again, sent } = await agentWith({ ...unsettled, plugin: { maxWaitMs: 40, store } });
    expect((await agent.methods.orientimSwap(agent, { ...USDC_FOR_SOL, id: 'order-1' })).outcome).toBe('unknown');
    expect(inner.size).toBe(1);
    expect(orders.get('order-1')?.state).toBe('pending');
    const g = globalThis as unknown as Record<symbol, unknown>;
    const before = g[SHARED];
    delete g[SHARED]; // another server: only the store is shared
    try {
      const elsewhere = again({ maxWaitMs: 40, store });
      await expect(elsewhere.methods.orientimSwap(elsewhere, USDC_FOR_SOL)).rejects.toMatchObject({ code: 'swap-unsettled' });
    } finally {
      g[SHARED] = before;
    }
    expect(sent.filter((w, i) => sent.indexOf(w) === i)).toHaveLength(1);
  });

  it('ORI-02: without stateDir or store, the plugin says once that swaps are kept only in memory', async () => {
    const g = globalThis as unknown as Record<symbol, unknown>;
    const before = g[SHARED];
    delete g[SHARED];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { again } = await agentWith();
      again({ acceptInMemoryState: false });
      again({ acceptInMemoryState: false });
      again({ acceptInMemoryState: false, stateDir: mkdtempSync(join(tmpdir(), 'orientim-plugin-')) });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/stateDir.*store/);
    } finally {
      warn.mockRestore();
      g[SHARED] = before;
    }
  });

  it('ORI-03: the slippage tolerance is capped by the owner, not the model', async () => {
    const { agent, sent } = await agentWith();
    const tool = (slippageBps: number) => agent.actions[0].handler(agent, { outputMint: SOL_MINT, inputMint: USDC, inputAmount: 1, slippageBps });
    expect(await tool(800)).toMatchObject({ status: 'error', code: 'slippage-above-limit' });
    expect(await tool(5_000)).toMatchObject({ status: 'error', code: 'invalid-input' });
    await expect(agent.methods.orientimSwap(agent, { ...USDC_FOR_SOL, slippageBps: 1_500 })).rejects.toMatchObject({ code: 'slippage-above-limit' });
    const strict = (await agentWith({ plugin: { maxSlippageBpsCap: 100 } })).agent;
    await expect(strict.methods.orientimSwap(strict, { ...USDC_FOR_SOL, slippageBps: 200 })).rejects.toMatchObject({ code: 'slippage-above-limit' });
    expect(() => createOrientimPlugin({ maxSlippageBpsCap: 20_000 })).toThrow(/maxSlippageBpsCap/);
    expect(() => createOrientimPlugin({ maxPriceImpactBps: -1 })).toThrow(/maxPriceImpactBps/);
    expect(sent).toHaveLength(0);
    // Within the cap, the swap goes ahead, built at that tolerance.
    expect(await tool(300)).toMatchObject({ status: 'success', outcome: 'confirmed' });
  });

  it('ORI-04: only a missing tolerance takes the default; anything else that is not one is refused', async () => {
    const { agent, sent } = await agentWith();
    for (const bad of [0, 5, Number.NaN, 2.5]) {
      await expect(agent.methods.orientimSwap(agent, { ...USDC_FOR_SOL, slippageBps: bad }), String(bad)).rejects.toMatchObject({ code: 'invalid-input' });
    }
    expect(sent).toHaveLength(0);
    expect((await agent.methods.orientimSwap(agent, USDC_FOR_SOL)).outcome).toBe('confirmed');
  });

  it('the same as the page: a thin market is refused before anything is prepared; the owner may allow more', async () => {
    const thin = (answer: Record<string, unknown>) => ({ ...answer, priceImpactPct: '0.08' });
    const { agent, sent, calls } = await agentWith({ jupiter: thin });
    const r = await agent.actions[0].handler(agent, { outputMint: SOL_MINT, inputMint: USDC, inputAmount: 1 });
    expect(r).toMatchObject({ status: 'error', code: 'price-impact-high' });
    expect(String(r.message)).toMatch(/^Price impact is 8\.00%: .*Nothing was sent/);
    expect(calls.filter(u => u.endsWith('/api/v1/prepare'))).toEqual([]);
    const allowed = (await agentWith({ jupiter: thin, plugin: { maxPriceImpactBps: 1_000 } })).agent;
    expect((await allowed.methods.orientimSwap(allowed, USDC_FOR_SOL)).outcome).toBe('confirmed');
    expect(sent).toHaveLength(0);
  });

  it('the same as the page: notes about the tokens reach the model, and the message says what happened', async () => {
    const { agent } = await agentWith();
    const plain = await agent.actions[0].handler(agent, { outputMint: SOL_MINT, inputMint: USDC, inputAmount: 1 });
    expect(plain.warnings).toEqual([]);
    expect(String(plain.message)).toMatch(/^Swapped 1 for at least [\d.]+ of the output token; the swap could use only 1\.$/);
    // Selling a token whose issuer can freeze balances: said to the model, as the page says it to a person.
    const noted = await agentWith({
      mints: async (m, owner) => {
        const d = new Uint8Array(82);
        d[44] = 5;
        new DataView(d.buffer).setUint32(46, 1, true);
        m.set(BONK, { owner: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data: d });
        for (const [k, v] of await fundedAccounts(address(owner), BONK)) m.set(k, v);
        // A sale into SOL pays its fee in SOL, to the treasury's own wallet.
        m.set(TREASURY, { owner: address('11111111111111111111111111111111'), data: new Uint8Array(0) });
      },
    });
    const r = await noted.agent.actions[0].handler(noted.agent, { outputMint: SOL_MINT, inputMint: BONK, inputAmount: 1 });
    expect(r).toMatchObject({ status: 'success', warnings: [`${BONK.slice(0, 4)}…${BONK.slice(-4)} has a freeze authority: its issuer can freeze your balance`] });
    expect(String(r.message)).toMatch(/Token notes: .* has a freeze authority/);
    // USDC keeps its authorities by design and is never noted.
    const usdc = await agentWith({
      mints: m => {
        const d = new Uint8Array(82);
        d[44] = 6;
        new DataView(d.buffer).setUint32(0, 1, true);
        new DataView(d.buffer).setUint32(46, 1, true);
        m.set(USDC, { owner: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data: d });
      },
    });
    expect((await usdc.agent.methods.orientimSwap(usdc.agent, USDC_FOR_SOL)).warnings).toEqual([]);
  });

  it('ORI-05: a minimum in whole tokens is rounded up to the next base unit, never down', async () => {
    const { agent, prepared } = await agentWith();
    // A tenth of a lamport: rounded down it would be no minimum at all.
    expect((await agent.methods.orientimSwap(agent, { ...USDC_FOR_SOL, minOutput: '0.0000000001' })).outcome).toBe('confirmed');
    expect(prepared.at(-1)?.minOut).toBe('1');
  });

  it('ORI-06: an RPC that does not answer stops the swap in time, and frees the wallet for the next one', async () => {
    const { agent, again, agentRpc } = await agentWith();
    const hanging = {
      ...agentRpc,
      getMultipleAccounts: () => ({
        send: ({ abortSignal }: { abortSignal: AbortSignal }) => new Promise((_, reject) => abortSignal.addEventListener('abort', () => reject(abortSignal.reason))),
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    const stuck = again({ rpc: hanging, requestTimeoutMs: 50 });
    const started = Date.now();
    await expect(stuck.methods.orientimSwap(stuck, USDC_FOR_SOL)).rejects.toMatchObject({ code: 'rpc-unavailable' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await agent.methods.orientimSwap(agent, USDC_FOR_SOL)).outcome).toBe('confirmed');
  });

  it('ORI-07: a settled swap whose record could not be removed is said as such, and nothing new is sent', async () => {
    const inner = new Map<string, Signed>();
    const store: PendingStore & OrderBook = {
      put: async s => void inner.set(s.signature, s), remove: async () => { throw new Error('disk is read-only'); }, list: async () => [...inner.values()],
      order: async () => null, recordOrder: async () => {}, claimOrder: async () => true,
    };
    const { agent, sent } = await agentWith({ plugin: { store } });
    const first = await agent.methods.orientimSwap(agent, USDC_FOR_SOL);
    expect(first.outcome).toBe('confirmed');
    expect(first.bookkeepingError).toMatch(/read-only/);
    const sends = sent.length;
    await expect(agent.methods.orientimSwap(agent, USDC_FOR_SOL)).rejects.toMatchObject({ code: 'record-not-updated' });
    await expect(agent.methods.orientimSwap(agent, USDC_FOR_SOL)).rejects.toThrow(new RegExp(`${first.signature}\\) ended confirmed`));
    expect(sent).toHaveLength(sends);
  });

  it('ORI-08: a token account is not a mint; the model is told the minimum, not an amount received', async () => {
    const { agent, kp } = await agentWith();
    const account = await ataOf(address(kp.publicKey.toBase58()), USDC);
    await expect(agent.methods.orientimSwap(agent, { ...USDC_FOR_SOL, outputMint: account })).rejects.toMatchObject({ code: 'not-a-token' });
    const r = await agent.actions[0].handler(agent, { outputMint: SOL_MINT, inputMint: USDC, inputAmount: 1 });
    expect(r.message).toMatch(/^Swapped 1 for at least [\d.]+ of the output token/);
  });
});
