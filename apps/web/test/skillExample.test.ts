/**
 * The skill's example (skills/bound-protected-swap/examples/swap.ts) is what agents will copy, so it
 * runs here end to end against the real agent API handlers. Its check must hold against a server
 * that lies (review FA-01): every answer below is one a compromised server, relay or impostor URL
 * could send, and each must be refused before the wallet signs.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  address, appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage,
  decompileTransactionMessage, generateKeyPairSigner, getBase58Decoder, getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction, pipe, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, signBytes, SolanaError, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
} from '@solana/kit';
import type { Address, Instruction, KeyPairSigner, Rpc, SolanaRpcApi } from '@solana/kit';
import { getAssignInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
  AuthorityType, getApproveInstruction, getSetAuthorityInstruction, getTransferCheckedInstruction,
} from '@solana-program/token';
import { getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { ataOf, SYSTEM_PROGRAM, WSOL_MINT } from '@bound/core';
import { BONK, DEX, fakeJupiter, fakeRpc, fundedAccounts, mint, POOL, tokenAccount, USDC } from '../../../packages/jupiter/test/fakes.ts';
import type { Account } from '../../../packages/jupiter/test/fakes.ts';
import { agentFinalize, agentPrepare } from '../lib/server/agent/api.ts';
import type { AgentDeps } from '../lib/server/agent/api.ts';
import {
  acquireLock, BoundApiError, checkPrepared, confirm, createFileStore, protectedSwap, recoverPending, resolvePending,
  BoundOrderError, PendingSwapError, signerFromSignBytes, signerFromSignTransaction, SKILL_VERSION,
} from '../../../skills/bound-protected-swap/examples/swap.ts';
import type { OrderBook, Signed } from '../../../skills/bound-protected-swap/examples/swap.ts';
import { runCli } from '../../../skills/bound-protected-swap/src/cli.ts';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOUND_TREASURY, inputTransferFee, ownMinimum } from '../../../skills/bound-protected-swap/lib/bound-verify.mjs';
import { routeAccountFor } from '@bound/verifier';
import { JupiterError } from '../../../packages/jupiter/src/client.ts';
import type { JupiterClient } from '../../../packages/jupiter/src/client.ts';
import type { Intent, Prepared } from '../../../skills/bound-protected-swap/examples/swap.ts';

const KEY = 'bnd_skill_example_test_key_0001';
const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

/** Jupiter as the agent reaches it itself, over HTTP: the honest market. */
const jupiterAnswer = async (url: string, market: JupiterClient = fakeJupiter()) => {
  const q = new URL(url).searchParams;
  const r = await market.build({
    inputMint: address(q.get('inputMint')!), outputMint: address(q.get('outputMint')!), amount: BigInt(q.get('amount')!),
    taker: address(q.get('taker')!), slippageBps: Number(q.get('slippageBps')), maxAccounts: Number(q.get('maxAccounts')),
  });
  return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
};

/**
 * `market`: what Bound's server quotes from, which a compromised server chooses. `treasuryWallet`:
 * the treasury's wallet exists, so a sale into SOL pays its fee in SOL, out of the output.
 */
async function bound(opts: { market?: JupiterClient; treasuryWallet?: boolean; sendError?: unknown; treasuryUsdc?: boolean } = {}) {
  const wallet = await generateKeyPairSigner();
  const accounts = new Map<string, Account>([
    [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
    [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [POOL, { owner: DEX, data: new Uint8Array(300) }],
    ...(opts.treasuryUsdc === false ? [] : [[await ataOf(TREASURY, USDC), tokenAccount(TREASURY, USDC)] as [string, Account]]),
    ...await fundedAccounts(wallet.address, USDC),
    ...(opts.treasuryWallet ? [[TREASURY, { owner: SYSTEM_PROGRAM, data: new Uint8Array(0) }] as [string, Account]] : []),
  ]);
  const sent: string[] = [];
  const rpc = fakeRpc(accounts, { sent, sendError: opts.sendError });
  const deps: AgentDeps = {
    rpc, jupiter: opts.market ?? fakeJupiter(), secrets: [new Uint8Array(32).fill(3)],
    keys: new Map([[createHash('sha256').update(KEY).digest('hex'), 'skill-test']]),
    feeBps: 20n, treasury: TREASURY, excludeDexes: ['HumidiFi'], maxNetworkFeeLamports: 200_000n,
    disabled: false, v1: false, perMinute: 1_000,
  };
  // The API as the agent reaches it over HTTP.
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.startsWith('https://api.jup.ag/')) return jupiterAnswer(url);
    const req = new Request(url, init);
    return url.endsWith('/api/v1/prepare') ? agentPrepare(req, deps) : agentFinalize(req, deps);
  }) as unknown as typeof fetch;
  // The agent's own RPC reads the same chain; the transaction confirms on the first look.
  const agentRpc = {
    ...rpc,
    getSignatureStatuses: () => ({ send: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }) }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { wallet, deps, sent, fetchImpl, agentRpc, accounts };
}

// A floor of the agent's own is required (research audit F-02); 1 lets the other checks speak.
// The test deployment's treasury stands in for Bound's pinned one (named, as for another deployment).
const intentFor = (wallet: KeyPairSigner): Intent => ({ owner: wallet.address, inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', minOut: '1', treasury: TREASURY });

async function honestAnswer(b: Awaited<ReturnType<typeof bound>>): Promise<Prepared> {
  const res = await b.fetchImpl('http://bound.test/api/v1/prepare', {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ owner: b.wallet.address, inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000' }),
  });
  return (await res.json()) as Prepared;
}

const sha = async (bytes: Uint8Array) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes as BufferSource)).toString('hex');

/**
 * What a lying server sends: its own instruction list, compiled for the agent's wallet, with every
 * hash and statement in the answer made to match it.
 */
async function lyingAnswer(honest: Prepared, owner: Address, ixs: Instruction[], policy: Record<string, unknown> = honest.policy, authority = honest.temporaryAuthority): Promise<Prepared> {
  const lifetime = { blockhash: '11111111111111111111111111111111' as never, lastValidBlockHeight: 1_000n };
  const tx = compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(owner, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    m => appendTransactionMessageInstructions(ixs, m),
  ));
  const digest = await sha(new Uint8Array(tx.messageBytes));
  return {
    ...honest, transaction: getBase64EncodedWireTransaction(tx), messageSha256: digest, temporaryAuthority: authority,
    policy: { ...policy, ephemeral: authority },
    certificate: { ...honest.certificate, messageSha256: digest, temporaryAuthority: authority },
  };
}

/** The honest transaction's instructions, to add one to or change. */
function honestInstructions(honest: Prepared): Instruction[] {
  const tx = getTransactionDecoder().decode(Buffer.from(honest.transaction, 'base64'));
  return [...decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as never).instructions] as Instruction[];
}

describe("the skill's example", () => {
  it('prepares, verifies on its own RPC, signs as the wallet, finalizes and confirms', async () => {
    const b = await bound();
    const result = await protectedSwap({
      apiUrl: 'http://bound.test', apiKey: KEY, rpc: b.agentRpc, wallet: b.wallet, fetchImpl: b.fetchImpl, pollMs: 1,
      intent: { inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', treasury: TREASURY },
    });
    expect(result.outcome).toBe('confirmed');
    expect(result.prepared.amounts.fee).toBe('2000');
    expect(b.sent).toHaveLength(1);
  });

  it("an honest answer passes the agent's full check", async () => {
    const b = await bound();
    expect(await checkPrepared(await honestAnswer(b), intentFor(b.wallet), b.agentRpc)).toEqual([]);
  });
});

describe("a server that lies is refused before the wallet signs (review FA-01)", () => {
  it("the audit's drain: 1,000,000 USDC and 50 SOL to an attacker, with every statement made to match", async () => {
    const b = await bound();
    const honest = await honestAnswer(b);
    const attacker = await generateKeyPairSigner();
    const W = createNoopSigner(b.wallet.address);
    const drain = [
      getTransferCheckedInstruction({
        source: await ataOf(b.wallet.address, USDC), mint: USDC, destination: await ataOf(attacker.address, USDC),
        authority: W, amount: 1_000_000_000_000n, decimals: 6,
      }),
      getTransferSolInstruction({ source: W, destination: attacker.address, amount: 50_000_000_000n }),
      // The attacker is the second signer, as the answer says the one-time key is.
      getTransferSolInstruction({ source: createNoopSigner(attacker.address), destination: attacker.address, amount: 1n }),
    ];
    const lie = await lyingAnswer(honest, b.wallet.address, drain, honest.policy, attacker.address);
    const problems = await checkPrepared(lie, intentFor(b.wallet), b.agentRpc);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join()).toMatch(/R2/);
  });

  const variants: [string, (b: Awaited<ReturnType<typeof bound>>, honest: Prepared, attacker: Address) => Promise<Prepared>][] = [
    ['an extra Approve of the wallet\'s input account to the attacker', async (b, honest, attacker) =>
      lyingAnswer(honest, b.wallet.address, [...honestInstructions(honest), getApproveInstruction({
        source: await ataOf(b.wallet.address, USDC), delegate: attacker, owner: createNoopSigner(b.wallet.address), amount: 10n ** 12n,
      })])],
    ['an extra SetAuthority handing the input account to the attacker', async (b, honest, attacker) =>
      lyingAnswer(honest, b.wallet.address, [...honestInstructions(honest), getSetAuthorityInstruction({
        owned: await ataOf(b.wallet.address, USDC), owner: createNoopSigner(b.wallet.address),
        authorityType: AuthorityType.AccountOwner, newAuthority: attacker,
      })])],
    ['a System Assign of the wallet to another program', async (b, honest, attacker) =>
      lyingAnswer(honest, b.wallet.address, [...honestInstructions(honest), getAssignInstruction({
        account: createNoopSigner(b.wallet.address), programAddress: attacker,
      })])],
    ['a priority fee of 1 SOL', async (b, honest) => {
      const ixs = honestInstructions(honest).map(ix =>
        ix.programAddress === 'ComputeBudget111111111111111111111111111111' && ix.data?.[0] === 3
          ? getSetComputeUnitPriceInstruction({ microLamports: 10n ** 12n }) : ix);
      return lyingAnswer(honest, b.wallet.address, ixs, { ...honest.policy, maxNetworkFeeLamports: '1000000000' });
    }],
    ['the swap program swapped for the attacker\'s', async (b, honest, attacker) => {
      const ixs = honestInstructions(honest).map(ix =>
        ix.programAddress === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' ? { ...ix, programAddress: attacker } : ix);
      return lyingAnswer(honest, b.wallet.address, ixs, { ...honest.policy, jupiterProgram: attacker });
    }],
    ['a fee of 1%, above the most an agent accepts', async (_b, honest) => ({ ...honest, policy: { ...honest.policy, feeBps: '100' } })],
    ['a minimum of 1', async (_b, honest) => ({ ...honest, policy: { ...honest.policy, minOut: '1' } })],
  ];
  for (const [name, make] of variants) {
    it(name, async () => {
      const b = await bound();
      const honest = await honestAnswer(b);
      const lie = await make(b, honest, (await generateKeyPairSigner()).address);
      const intent = name === 'a minimum of 1' ? { ...intentFor(b.wallet), minOut: honest.amounts.minOut } : intentFor(b.wallet);
      expect((await checkPrepared(lie, intent, b.agentRpc)).length, name).toBeGreaterThan(0);
    });
  }

  it("a fee above Bound's 0.3% is refused unless the agent raises its limit itself", async () => {
    const b = await bound();
    const honest = await honestAnswer(b);
    const higher = { ...honest, policy: { ...honest.policy, feeBps: '50' } };
    expect((await checkPrepared(higher, intentFor(b.wallet), b.agentRpc)).join()).toContain('the fee of 50 bps is above your limit');
  });

  it('unless the agent names another, the fee may go only to Bound\'s pinned treasury, or nowhere', async () => {
    const b = await bound();
    const honest = await honestAnswer(b);
    const { treasury: _named, ...unnamed } = intentFor(b.wallet);
    expect(BOUND_TREASURY).toBe('ARzSA3sZGhf5t4UnYrmB3TWyZ5m3Wo1nA9zWBcoiTqLE');
    // This deployment's treasury is not Bound's, so an agent that named none refuses the fee.
    expect((await checkPrepared(honest, unnamed, b.agentRpc)).join()).toContain(`the fee goes to ${TREASURY}, not Bound's treasury`);
    const toBound = { ...honest, policy: { ...honest.policy, treasury: BOUND_TREASURY } };
    expect((await checkPrepared(toBound, unnamed, b.agentRpc)).join()).not.toContain('treasury');
  });

  it('the fee sent to another treasury is refused when the agent pins Bound\'s', async () => {
    const b = await bound();
    const honest = await honestAnswer(b);
    const other = (await generateKeyPairSigner()).address;
    const lie = { ...honest, policy: { ...honest.policy, treasury: other } };
    expect((await checkPrepared(lie, { ...intentFor(b.wallet), treasury: TREASURY }, b.agentRpc)).join()).toContain('not Bound\'s treasury');
  });

  it('answers that disagree with what was asked are refused by the plain checks too', async () => {
    const b = await bound();
    const honest = await honestAnswer(b);
    const intent = intentFor(b.wallet);
    const cases: [string, Prepared, Partial<Intent>][] = [
      ['a higher fee than accepted', honest, { maxFeeBps: 10 }],
      ['another amount', honest, { amountIn: '999999' }],
      ['another output token', honest, { outputMint: USDC }],
      ['another wallet', honest, { owner: (await generateKeyPairSigner()).address }],
      ['a minimum below the one asked for', honest, { minOut: String(10n ** 15n) }],
      ['a message that is not the one hashed', { ...honest, messageSha256: '0'.repeat(64) }, {}],
      // A minimum shown above the one the bytes enforce, stated alike in the amounts and the certificate.
      ['a minimum stated above the enforced one', (() => {
        const shown = String(BigInt(honest.amounts.minOut) + 1_000n);
        return { ...honest, amounts: { ...honest.amounts, minOut: shown }, certificate: { ...honest.certificate, output: { ...honest.certificate.output, minimumOutput: shown } } };
      })(), {}],
    ];
    for (const [name, prepared, change] of cases) {
      expect((await checkPrepared(prepared, { ...intent, ...change }, b.agentRpc)).length, name).toBeGreaterThan(0);
    }
  });
});

describe('what the rules cannot see, the agent checks itself (research audit)', () => {
  it('without a floor of its own the agent does not sign: the price would be the server\'s word (F-02)', async () => {
    const b = await bound();
    const problems = await checkPrepared(await honestAnswer(b), { ...intentFor(b.wallet), minOut: undefined }, b.agentRpc);
    expect(problems.join()).toContain('no minimum of your own');
  });

  it('a server that sells for almost nothing passes every rule, and is refused by the floor the agent got from Jupiter (F-02)', async () => {
    // The compromised server quotes from a pool it controls: a thousandth of the market.
    const b = await bound({ market: fakeJupiter({ out: 1_000_000n }) });
    const cheap = await honestAnswer(b);
    expect(await checkPrepared(cheap, intentFor(b.wallet), b.agentRpc)).toEqual([]);
    const floor = await ownMinimum({ inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', taker: b.wallet.address, fetchImpl: b.fetchImpl });
    expect(BigInt(floor)).toBeGreaterThan(BigInt(cheap.amounts.minOut) * 100n);
    const problems = await checkPrepared(cheap, { ...intentFor(b.wallet), minOut: floor }, b.agentRpc);
    expect(problems.join()).toContain('is below yours');
  });

  it('the example asks Jupiter for its floor itself and sends it with prepare (F-02)', async () => {
    const b = await bound();
    const result = await protectedSwap({
      apiUrl: 'http://bound.test', apiKey: KEY, rpc: b.agentRpc, wallet: b.wallet, fetchImpl: b.fetchImpl, pollMs: 1,
      intent: { inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', treasury: TREASURY },
    });
    expect(result.outcome).toBe('confirmed');
    const floor = await ownMinimum({ inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', taker: b.wallet.address, fetchImpl: b.fetchImpl });
    expect(BigInt(result.prepared.amounts.minOut)).toBeGreaterThanOrEqual(BigInt(floor));
  });

  it('route rent the server says the market needs, but that stays with the one-time key, is refused (F-06)', async () => {
    const b = await bound();
    const honest = await honestAnswer(b);
    const ixs = honestInstructions(honest);
    const swap = ixs.findIndex(ix => ix.programAddress === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
    ixs.splice(swap, 0, getTransferSolInstruction({
      source: createNoopSigner(b.wallet.address), destination: honest.temporaryAuthority as Address, amount: 5_000_000n,
    }));
    const lie = await lyingAnswer(honest, b.wallet.address, ixs, { ...honest.policy, takerRent: '5000000' });
    const problems = await checkPrepared(lie, { ...intentFor(b.wallet), maxRouteCostLamports: 5_000_000 }, b.agentRpc);
    expect(problems).toEqual(['the one-time key would keep 5000000 lamports after the swap']);
  });

  it('rent the route keeps is refused beyond the limit the agent sets, 0.001 SOL by default (engineering review M-05)', async () => {
    const b = await bound();
    const honest = await honestAnswer(b);
    const ixs = honestInstructions(honest);
    const swap = ixs.findIndex(ix => ix.programAddress === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
    ixs.splice(swap, 0, getTransferSolInstruction({
      source: createNoopSigner(b.wallet.address), destination: honest.temporaryAuthority as Address, amount: 5_000_000n,
    }));
    const lie = await lyingAnswer(honest, b.wallet.address, ixs, { ...honest.policy, takerRent: '5000000' });
    expect((await checkPrepared(lie, intentFor(b.wallet), b.agentRpc)).join()).toContain('keeps 5000000 lamports of rent that do not come back');
  });

  it('lamports left in a Pump market account under the one-time key are refused (engineering review M-05)', async () => {
    const b = await bound();
    const honest = await honestAnswer(b);
    const market = await routeAccountFor(address('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), honest.temporaryAuthority as Address);
    // The agent's RPC reports the market's account under E still holding its rent after the swap.
    const rpc = {
      ...b.agentRpc,
      simulateTransaction: (_tx: unknown, config: { accounts: { addresses: string[] } }) => ({
        send: async () => ({ value: { err: null, logs: [], accounts: config.accounts.addresses.map((_, i) => (i === 1 ? { lamports: 1_346_200n } : null)) } }),
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    const problems = await checkPrepared(honest, intentFor(b.wallet), rpc);
    expect(problems.join()).toContain('a market account under the one-time key would keep 1346200 lamports');
    expect(market).toBeTruthy();
  });

  it('cashback left in a token account of a Pump market account under E is refused (engineering audit U1)', async () => {
    const b = await bound();
    const honest = await honestAnswer(b);
    // E and both market accounts are empty; the curve market's WSOL account holds cashback E could claim.
    const rpc = {
      ...b.agentRpc,
      simulateTransaction: (_tx: unknown, config: { accounts: { addresses: string[] } }) => ({
        send: async () => ({ value: { err: null, logs: [], accounts: config.accounts.addresses.map((_, i) => (i === 3 ? { lamports: 2_100_000n } : null)) } }),
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    expect((await checkPrepared(honest, intentFor(b.wallet), rpc)).join()).toContain('a market account under the one-time key would keep 2100000 lamports');
  });

  it('a simulation that does not report the accounts proves nothing, and is refused (engineering review M-05)', async () => {
    const b = await bound();
    const honest = await honestAnswer(b);
    const rpc = {
      ...b.agentRpc,
      simulateTransaction: () => ({ send: async () => ({ value: { err: null, logs: [] } }) }),
    } as unknown as Rpc<SolanaRpcApi>;
    expect((await checkPrepared(honest, intentFor(b.wallet), rpc)).join()).toContain('did not report what the one-time key holds');
  });

  it('with too few blocks left to land, the example does not finalize (F-05)', async () => {
    const b = await bound();
    const late = { ...b.agentRpc, getBlockHeight: () => ({ send: async () => 990n }) } as unknown as Rpc<SolanaRpcApi>;
    await expect(protectedSwap({
      apiUrl: 'http://bound.test', apiKey: KEY, rpc: late, wallet: b.wallet, fetchImpl: b.fetchImpl, pollMs: 1,
      intent: { inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', treasury: TREASURY },
    })).rejects.toThrow('only 10 blocks are left');
    expect(b.sent).toHaveLength(0);
  });
});

describe("the fee, taken like Jupiter's, as the agent sees it", () => {
  it('a sale into SOL pays in SOL out of the output; the minimum the agent checks is what its wallet keeps', async () => {
    const b = await bound({ treasuryWallet: true });
    const result = await protectedSwap({
      apiUrl: 'http://bound.test', apiKey: KEY, rpc: b.agentRpc, wallet: b.wallet, fetchImpl: b.fetchImpl, pollMs: 1,
      intent: { inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', treasury: TREASURY },
    });
    expect(result.outcome).toBe('confirmed');
    const p = result.prepared;
    expect(p.amounts.feeMint).toBe(WSOL_MINT);
    expect(p.amounts.swapAmount).toBe(p.amounts.amountIn);
    expect(BigInt(p.amounts.minOut) + BigInt(p.amounts.fee)).toBe(BigInt(p.policy.minOut as string));
    expect(p.certificate.output.boundFee).toBe(p.amounts.fee);
    expect(p.certificate.output.minimumOutput).toBe(p.amounts.minOut);
  });

  it('a server that takes a larger fee from the output than it states is refused', async () => {
    const b = await bound({ treasuryWallet: true });
    const honest = await honestAnswer(b);
    const lie = { ...honest, policy: { ...honest.policy, fee: String(BigInt(honest.policy.fee as string) * 2n) } };
    expect((await checkPrepared(lie, intentFor(b.wallet), b.agentRpc)).join()).toContain('policy amounts are inconsistent');
  });
});

const signatureOfWire = (wire: string) => getSignatureFromTransaction(getTransactionDecoder().decode(Buffer.from(wire, 'base64')));
const swapIntent = { inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', minOut: '1', treasury: TREASURY };

/**
 * The agent's own RPC on a chain that moves on: 40 blocks at every height read. A transaction is on
 * chain once Bound's server has sent it and the height has reached `landAt`; `others` are other
 * transactions the chain has confirmed. `from`: the height before the first read. The fake server's
 * transactions live until block 1,000, so a test that proves expiry starts the chain within their
 * life, as a real one is: "no record" proves nothing about a transaction signed long before (F1).
 */
function chainOf(b: Awaited<ReturnType<typeof bound>>, opts: { landAt?: bigint; others?: string[]; statusSlot?: bigint; from?: bigint } = {}) {
  let height = opts.from ?? 0n;
  const onChain = (s: string) => (b.sent.some(w => signatureOfWire(w) === s) && height >= (opts.landAt ?? 0n)) || !!opts.others?.includes(s);
  return {
    ...b.agentRpc,
    getBlockHeight: () => ({ send: async () => (height += 40n) }),
    // One node's finalized view: its slot and height together (slots here equal heights).
    getEpochInfo: () => ({ send: async () => ({ absoluteSlot: height, blockHeight: height }) }),
    // Statuses from a node that has reached `statusSlot`: 30 ahead of the finalized view, as a processed
    // node is, unless a test lags it or runs it far ahead.
    getSignatureStatuses: (signatures: string[]) => ({
      send: async () => ({
        context: { slot: opts.statusSlot ?? height + 30n },
        value: signatures.map(s => (onChain(s) ? { confirmationStatus: 'confirmed', err: null } : null)),
      }),
    }),
  } as unknown as Rpc<SolanaRpcApi>;
}

/** The API over HTTP, with each finalize answer passed through `change` on its way back. */
function answering(b: Awaited<ReturnType<typeof bound>>, change: (answer: Record<string, unknown>, n: number) => Record<string, unknown> | 'lost') {
  let n = 0;
  return (async (url: string, init: RequestInit) => {
    const res = await b.fetchImpl(url, init);
    if (!url.endsWith('/api/v1/finalize')) return res;
    const changed = change(await res.json(), n++);
    if (changed === 'lost') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(changed), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('after signing, the chain is the only witness (engineering review H-01, H-02)', () => {
  it('an answer lost after the swap was sent: finalize is asked once more, and the same transaction confirms', async () => {
    const b = await bound();
    let prepares = 0;
    const lossy = answering(b, (answer, n) => (n === 0 ? 'lost' : answer));
    const counting = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/v1/prepare')) prepares++;
      return lossy(url, init);
    }) as unknown as typeof fetch;
    const result = await protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: chainOf(b), wallet: b.wallet, fetchImpl: counting, pollMs: 1, intent: swapIntent });
    expect(result.outcome).toBe('confirmed');
    expect(prepares).toBe(1);
    // The same transaction however often it went out, so it could land only once.
    expect(new Set(b.sent).size).toBe(1);
    expect(result.signature).toBe(signatureOfWire(b.sent[0]));
  });

  it('with every answer lost, the outcome is still read for the transaction the wallet signed', async () => {
    const b = await bound();
    const result = await protectedSwap({
      apiUrl: 'http://bound.test', apiKey: KEY, rpc: chainOf(b), wallet: b.wallet, fetchImpl: answering(b, () => 'lost'), pollMs: 1, intent: swapIntent,
    });
    expect(result.outcome).toBe('confirmed');
    expect(result.signature).toBe(signatureOfWire(b.sent[0]));
  });

  it("another transaction's confirmed signature from the server is not a success", async () => {
    const b = await bound();
    const other = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64)));
    // The server sends nothing and names a transaction that did confirm, with bytes that are not ours.
    const liar = (async (url: string, init: RequestInit) => url.endsWith('/api/v1/finalize')
      ? new Response(JSON.stringify({ signature: other, status: 'sent', signedTransaction: Buffer.alloc(300, 1).toString('base64'), lastValidBlockHeight: '1000' }), { status: 200 })
      : b.fetchImpl(url, init)) as unknown as typeof fetch;
    const result = await protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: chainOf(b, { others: [other], from: 860n }), wallet: b.wallet, fetchImpl: liar, pollMs: 1, intent: swapIntent });
    expect(result.outcome).toBe('expired');
    expect(result.signature).not.toBe(other);
    expect(b.sent).toHaveLength(0);
  });

  it('"sent" without the signed transaction is not a refusal: the swap it sent confirms', async () => {
    const b = await bound();
    const result = await protectedSwap({
      apiUrl: 'http://bound.test', apiKey: KEY, rpc: chainOf(b), wallet: b.wallet, pollMs: 1, intent: swapIntent,
      fetchImpl: answering(b, ({ signedTransaction: _, ...rest }) => rest),
    });
    expect(result.outcome).toBe('confirmed');
  });

  it('"rejected" from a server that sent it anyway: the outcome is what the chain shows', async () => {
    const b = await bound();
    const result = await protectedSwap({
      apiUrl: 'http://bound.test', apiKey: KEY, rpc: chainOf(b), wallet: b.wallet, pollMs: 1, intent: swapIntent,
      fetchImpl: answering(b, ({ signedTransaction: _, ...rest }) => ({ ...rest, status: 'rejected', refusal: 'network' })),
    });
    expect(result.outcome).toBe('confirmed');
    expect(b.sent).toHaveLength(1);
  });

  it('a real refusal before sending is "rejected" once the transaction can no longer land', async () => {
    const preflight = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {} as never);
    const b = await bound({ sendError: preflight });
    const result = await protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: chainOf(b, { from: 860n }), wallet: b.wallet, fetchImpl: b.fetchImpl, pollMs: 1, intent: swapIntent });
    expect(result).toMatchObject({ outcome: 'rejected', refusal: 'network' });
    expect(b.sent).toHaveLength(0);
  });

  it('a lower lastValidBlockHeight from the server does not end the wait while the swap can still land', async () => {
    const b = await bound();
    // Both answers say the transaction dies at block 100; it lands at 180, as its real lifetime allows.
    const low = (async (url: string, init: RequestInit) => {
      const res = await b.fetchImpl(url, init);
      if (url.startsWith('https://api.jup.ag/')) return res;
      const body = await res.json();
      return new Response(JSON.stringify({ ...body, lastValidBlockHeight: '100' }), { status: res.status });
    }) as unknown as typeof fetch;
    const result = await protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: chainOf(b, { landAt: 180n }), wallet: b.wallet, fetchImpl: low, pollMs: 1, intent: swapIntent });
    expect(result.outcome).toBe('confirmed');
  });

  it('the signature is handed over to keep before finalize is asked', async () => {
    const b = await bound();
    const order: string[] = [];
    const watching = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/v1/finalize')) order.push('finalize');
      return b.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    let kept = '';
    const result = await protectedSwap({
      apiUrl: 'http://bound.test', apiKey: KEY, rpc: chainOf(b), wallet: b.wallet, fetchImpl: watching, pollMs: 1, intent: swapIntent,
      onSigned: s => { kept = s.signature; order.push('signed'); },
    });
    expect(order).toEqual(['signed', 'finalize']);
    expect(kept).toBe(result.signature);
  });

  it('confirming stops at its deadline while the RPC keeps failing, and says unknown', async () => {
    const failing = {
      getSignatureStatuses: () => ({ send: async () => { throw new Error('RPC unavailable'); } }),
      getBlockHeight: () => ({ send: async () => { throw new Error('RPC unavailable'); } }),
    } as unknown as Rpc<SolanaRpcApi>;
    expect(await confirm(failing, 'sig', 1_000n, { pollMs: 1, maxWaitMs: 30 })).toBe('unknown');
  });

  it("a busy answer keeps its Retry-After, so the agent can wait as told", async () => {
    const busy: JupiterClient = { ...fakeJupiter(), build: async () => { throw new JupiterError('Jupiter 429: Too many requests', 429); } };
    const b = await bound({ market: busy });
    const err = await protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: b.agentRpc, wallet: b.wallet, fetchImpl: b.fetchImpl, pollMs: 1, intent: swapIntent })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundApiError);
    expect(err).toMatchObject({ code: 'busy', retryAfter: 5 });
  });
});

describe('a fee in SOL for a pair neither token of which can carry it (every swap pays)', () => {
  // USDC for BONK, with a treasury that has a wallet but no USDC account: the fee is paid in SOL.
  const pair = { inputMint: USDC, outputMint: BONK, amountIn: '1000000' };
  const solFeeWorld = () => bound({ treasuryWallet: true, treasuryUsdc: false });
  const prepareFor = async (b: Awaited<ReturnType<typeof bound>>) => {
    const res = await b.fetchImpl('http://bound.test/api/v1/prepare', {
      method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ owner: b.wallet.address, ...pair }),
    });
    return (await res.json()) as Prepared;
  };

  it('the example holds it to a price of its own from Jupiter, and the swap goes through', async () => {
    const b = await solFeeWorld();
    const result = await protectedSwap({
      apiUrl: 'http://bound.test', apiKey: KEY, rpc: b.agentRpc, wallet: b.wallet, fetchImpl: b.fetchImpl, pollMs: 1, intent: { ...pair, minOut: '1', treasury: TREASURY },
    });
    expect(result.outcome).toBe('confirmed');
    expect(result.prepared.amounts.feeMint).toBe(WSOL_MINT);
    expect(result.prepared.certificate.solFee?.lamports).toBe(result.prepared.amounts.fee);
    expect(BigInt(result.prepared.amounts.fee)).toBeGreaterThan(0n);
  });

  it('without a limit of its own, the agent does not sign it', async () => {
    const b = await solFeeWorld();
    const answer = await prepareFor(b);
    const problems = await checkPrepared(answer, { owner: b.wallet.address, ...pair, minOut: '1' }, b.agentRpc);
    expect(problems.join()).toContain('set maxSolFeeLamports');
  });

  it('a server that charges more SOL than the swap is worth to the agent is refused', async () => {
    const b = await solFeeWorld();
    const honest = await prepareFor(b);
    const fee = BigInt(honest.amounts.fee);
    const treasuryTransfer = (ix: Instruction) => ix.programAddress === SYSTEM_PROGRAM && ix.accounts?.[1]?.address === TREASURY;
    const ixs = honestInstructions(honest).map(ix => (treasuryTransfer(ix)
      ? getTransferSolInstruction({ source: createNoopSigner(b.wallet.address), destination: TREASURY, amount: fee * 3n })
      : ix));
    const lie = await lyingAnswer(honest, b.wallet.address, ixs, { ...honest.policy, fee: String(fee * 3n) });
    const inflated = {
      ...lie, amounts: { ...lie.amounts, fee: String(fee * 3n) },
      certificate: { ...lie.certificate, solFee: { lamports: String(fee * 3n), destination: TREASURY } },
    };
    const ownLimit = Number(fee + fee / 50n);
    const problems = await checkPrepared(inflated, { owner: b.wallet.address, ...pair, minOut: '1', maxSolFeeLamports: ownLimit, treasury: TREASURY }, b.agentRpc);
    expect(problems.join()).toContain('above your limit');
    expect(await checkPrepared(honest, { owner: b.wallet.address, ...pair, minOut: '1', maxSolFeeLamports: ownLimit, treasury: TREASURY }, b.agentRpc)).toEqual([]);
  });
});

describe('recovery the delivered example must survive (engineering audit, Stage 1)', () => {
  const never = (signal?: AbortSignal) => new Promise<never>((_, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('The operation timed out.', 'TimeoutError')));
  });

  it('a status node behind the finalized view keeps the outcome unknown; a covering one proves expiry (S1-H-01)', async () => {
    const b = await bound();
    const lagging = chainOf(b, { statusSlot: 1n });
    expect(await confirm(lagging, 'unseen', 50n, { pollMs: 1, maxWaitMs: 60 })).toBe('unknown');
    expect(await confirm(chainOf(b), 'unseen', 50n, { pollMs: 1, maxWaitMs: 2_000, earliestHeight: 0n })).toBe('expired');
  });

  it('a status read that never answers does not hold confirm past its deadline (S1-M-04)', async () => {
    const stuck = {
      getSignatureStatuses: () => ({ send: (o?: { abortSignal?: AbortSignal }) => never(o?.abortSignal) }),
      getBlockHeight: () => ({ send: (o?: { abortSignal?: AbortSignal }) => never(o?.abortSignal) }),
    } as unknown as Rpc<SolanaRpcApi>;
    const started = Date.now();
    expect(await confirm(stuck, 'sig', 1_000n, { pollMs: 1, maxWaitMs: 80, requestTimeoutMs: 20 })).toBe('unknown');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a finalize that never answers ends on time, and the outcome is read for its own signature (S1-M-04)', async () => {
    const b = await bound();
    const silent = (async (url: string, init: RequestInit) => (url.endsWith('/api/v1/finalize')
      ? never(init.signal ?? undefined) : b.fetchImpl(url, init))) as unknown as typeof fetch;
    const result = await protectedSwap({
      apiUrl: 'http://bound.test', apiKey: KEY, rpc: chainOf(b, { from: 860n }), wallet: b.wallet, fetchImpl: silent, pollMs: 1, requestTimeoutMs: 20, intent: swapIntent,
    });
    // Nothing reached the chain, and nothing is called rejected: it did not land and can no longer land.
    expect(result.outcome).toBe('expired');
    expect(b.sent).toHaveLength(0);
  });

  it('a swap that cannot be kept before finalize is not finalized (S1-M-01)', async () => {
    const b = await bound();
    let finalizes = 0;
    const counting = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/v1/finalize')) finalizes++;
      return b.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    await expect(protectedSwap({
      apiUrl: 'http://bound.test', apiKey: KEY, rpc: chainOf(b), wallet: b.wallet, fetchImpl: counting, pollMs: 1, intent: swapIntent,
      onSigned: () => { throw new Error('disk full'); },
    })).rejects.toThrow('disk full');
    expect(finalizes).toBe(0);
    expect(b.sent).toHaveLength(0);
  });

  it('what a stopped run kept is settled by its own signature on the next start; the unknown stays (S1-M-01)', async () => {
    const b = await bound();
    const dir = mkdtempSync(join(tmpdir(), 'bound-pending-'));
    const store = createFileStore(dir);
    // A swap that was sent and landed while the process was down, and one the chain says nothing about yet.
    let kept: Parameters<typeof store.put>[0] | null = null;
    const landed = await protectedSwap({
      apiUrl: 'http://bound.test', apiKey: KEY, rpc: chainOf(b), wallet: b.wallet, fetchImpl: b.fetchImpl, pollMs: 1, intent: swapIntent,
      onSigned: async s => { kept = s; await store.put(s); },
    });
    expect(landed.outcome).toBe('confirmed');
    expect(kept!.signedTransaction).toBeTruthy();
    await store.put({ ...kept!, signature: 'still-unknown-signature', lastValidBlockHeight: 10n ** 12n });
    const rpc = chainOf(b);
    const { settled, unknown } = await recoverPending(store, rpc, { pollMs: 1, maxWaitMs: 60 });
    expect(settled).toEqual([{ signature: landed.signature, outcome: 'confirmed' }]);
    expect(unknown).toEqual(['still-unknown-signature']);
    expect(readdirSync(dir).filter(f => f.startsWith('pending-'))).toEqual(['pending-still-unknown-signature.json']);
  });

  it('one worker per wallet: a second one is refused until the first releases (S1-M-01)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bound-lock-'));
    const release = acquireLock(dir, 'wallet-one');
    expect(() => acquireLock(dir, 'wallet-one')).toThrow('Another swap');
    const other = acquireLock(dir, 'wallet-two');
    release();
    other();
    acquireLock(dir, 'wallet-one')();
  });
});

describe('wallets held by a signing service (remote signers)', () => {
  const finalizesOf = (b: Awaited<ReturnType<typeof bound>>) => {
    const counter = { n: 0 };
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/v1/finalize')) counter.n++;
      return b.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    return { counter, fetchImpl };
  };

  it('a service that signs raw bytes is given the checked message, and the swap confirms', async () => {
    const b = await bound();
    let seen: Uint8Array | null = null;
    const remote = signerFromSignBytes(b.wallet.address, async message => {
      seen = message;
      return signBytes(b.wallet.keyPair.privateKey, message);
    });
    const result = await protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: b.agentRpc, wallet: remote, fetchImpl: b.fetchImpl, pollMs: 1, intent: swapIntent });
    expect(result.outcome).toBe('confirmed');
    const built = getTransactionDecoder().decode(Buffer.from(result.prepared.transaction, 'base64'));
    expect(Buffer.from(seen!).equals(Buffer.from(built.messageBytes))).toBe(true);
    expect(b.sent).toHaveLength(1);
  });

  it('a service that signs a transaction and hands it back unsent works', async () => {
    const b = await bound();
    const remote = signerFromSignTransaction(b.wallet.address, async wire => {
      const signed = await partiallySignTransaction([b.wallet.keyPair], getTransactionDecoder().decode(Buffer.from(wire, 'base64')));
      return Buffer.from(getTransactionEncoder().encode(signed)).toString('base64');
    });
    const result = await protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: b.agentRpc, wallet: remote, fetchImpl: b.fetchImpl, pollMs: 1, intent: swapIntent });
    expect(result.outcome).toBe('confirmed');
  });

  it("a signature that is not the wallet's for this message is refused, and nothing is finalized", async () => {
    const b = await bound();
    const { counter, fetchImpl } = finalizesOf(b);
    const wrong = signerFromSignBytes(b.wallet.address, async () => signBytes(b.wallet.keyPair.privateKey, new Uint8Array([1, 2, 3])));
    await expect(protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: b.agentRpc, wallet: wrong, fetchImpl, pollMs: 1, intent: swapIntent }))
      .rejects.toThrow('no valid signature');
    expect(counter.n).toBe(0);
    expect(b.sent).toHaveLength(0);
  });

  it('a service that changes the transaction before signing it is refused, and nothing is finalized', async () => {
    const b = await bound();
    const { counter, fetchImpl } = finalizesOf(b);
    const meddling = signerFromSignTransaction(b.wallet.address, async wire => {
      const tx = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
      const message = new Uint8Array(tx.messageBytes);
      message[message.length - 1] ^= 1;
      const signed = await partiallySignTransaction([b.wallet.keyPair], { ...tx, messageBytes: message as never });
      return Buffer.from(getTransactionEncoder().encode(signed)).toString('base64');
    });
    await expect(protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: b.agentRpc, wallet: meddling, fetchImpl, pollMs: 1, intent: swapIntent }))
      .rejects.toThrow('changed the transaction');
    expect(counter.n).toBe(0);
    expect(b.sent).toHaveLength(0);
  });
});

describe('bound-verify, the command for bots in other languages', () => {
  const setup = async (opts: { rpc?: (b: Awaited<ReturnType<typeof bound>>) => Rpc<SolanaRpcApi> } = {}) => {
    const b = await bound();
    const stateDir = mkdtempSync(join(tmpdir(), 'bound-cli-'));
    let finalizes = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/v1/finalize')) finalizes++;
      return b.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const deps = {
      rpc: opts.rpc ? opts.rpc(b) : b.agentRpc, apiUrl: 'http://bound.test', apiKey: KEY, fetchImpl, stateDir, treasury: TREASURY,
      pollMs: 1, maxWaitMs: 60,
    };
    const intent = { owner: b.wallet.address, inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000' };
    // What a bot in another language does with `message`: sign the bytes with its own key, in base58.
    const signMessage = async (message: string, bytes?: Uint8Array) =>
      getBase58Decoder().decode(await signBytes(b.wallet.keyPair.privateKey, bytes ?? Buffer.from(message, 'base64')));
    return { b, deps, stateDir, intent, signMessage, finalizes: () => finalizes };
  };
  // Everything crosses the process boundary as JSON.
  const viaJson = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

  it('prepare, one signature made by the bot, finalize: confirmed, and no record is left', async () => {
    const { b, deps, stateDir, intent, signMessage } = await setup();
    const ready = await runCli('prepare', { intent }, deps);
    expect(ready.code).toBe(0);
    const out = viaJson(ready.output) as { checked: unknown; message: string };
    const done = await runCli('finalize', { checked: out.checked, signature: await signMessage(out.message) }, deps);
    expect(done.code).toBe(0);
    expect(done.output.outcome).toBe('confirmed');
    expect(b.sent).toHaveLength(1);
    expect(readdirSync(stateDir).filter(f => f.startsWith('pending-'))).toEqual([]);
  });

  it("finalize checks again: an answer that no longer passes, or a signature that is not the wallet's, sends nothing", async () => {
    const { b, deps, intent, signMessage, finalizes } = await setup();
    const out = viaJson((await runCli('prepare', { intent }, deps)).output) as { checked: { prepared: Prepared; intent: Intent }; message: string };
    const higherFloor = { ...out.checked, intent: { ...out.checked.intent, minOut: String(BigInt(out.checked.prepared.amounts.minOut) + 1n) } };
    const refused = await runCli('finalize', { checked: higherFloor, signature: await signMessage(out.message) }, deps);
    expect(refused.code).toBe(1);
    expect(String(refused.output.problems)).toContain('below yours');
    const forged = await runCli('finalize', { checked: out.checked, signature: await signMessage('', new Uint8Array([9, 9, 9])) }, deps);
    expect(forged.code).toBe(1);
    expect(String(forged.output.error)).toContain('no valid signature');
    const short = await runCli('finalize', { checked: out.checked, signature: '1111' }, deps);
    expect(short.code).toBe(1);
    expect(finalizes()).toBe(0);
    expect(b.sent).toHaveLength(0);
  });

  it('nothing new is prepared while an earlier swap could still land, and recover says which', async () => {
    const { deps, stateDir, intent } = await setup({ rpc: b => chainOf(b) });
    await createFileStore(stateDir).put({
      signature: 'still-unknown-signature', lastValidBlockHeight: 10n ** 12n, ticket: 't', signedTransaction: '', messageSha256: '', signedAt: 0,
    });
    const blocked = await runCli('prepare', { intent }, deps);
    expect(blocked.code).toBe(3);
    expect(blocked.output.pending).toEqual(['still-unknown-signature']);
    const recovered = await runCli('recover', {}, deps);
    expect(recovered.code).toBe(3);
    expect(recovered.output.unknown).toEqual(['still-unknown-signature']);
  });

  it('check: an honest answer is safe to sign, a lying one is not', async () => {
    const { b, deps } = await setup();
    const honest = await honestAnswer(b);
    expect((await runCli('check', { prepared: honest, intent: intentFor(b.wallet) }, deps)).code).toBe(0);
    const other = await generateKeyPairSigner();
    const lie = { ...honest, policy: { ...honest.policy, treasury: other.address } };
    const refused = await runCli('check', { prepared: lie, intent: intentFor(b.wallet) }, deps);
    expect(refused.code).toBe(1);
    expect(String(refused.output.problems)).toContain("not Bound's treasury");
  });

  it('usage errors exit 2, and the bundled command runs as a command only', async () => {
    const { deps } = await setup();
    expect((await runCli('prepare', {}, deps)).code).toBe(2);
    expect((await runCli('finalize', { checked: {} }, deps)).code).toBe(2);
    expect((await runCli('swap', {}, deps)).code).toBe(2);
    const run = spawnSync(process.execPath, ['skills/bound-protected-swap/bin/bound-verify.mjs'], { encoding: 'utf8', cwd: join(import.meta.dirname, '../../..') });
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout).error).toContain('usage: bound-verify');
  });
});

describe('the skill names its version (final audit, M1)', () => {
  it("SKILL_VERSION is the package's version, and every call to Bound carries it", async () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../../../skills/bound-protected-swap/package.json'), 'utf8')) as { version: string };
    expect(SKILL_VERSION).toBe(pkg.version);
    const b = await bound();
    const seen: string[] = [];
    const watching = (async (url: string, init: RequestInit) => {
      if (url.startsWith('http://bound.test/')) seen.push(new Headers(init.headers).get('x-bound-skill') ?? '');
      return b.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const result = await protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: b.agentRpc, wallet: b.wallet, fetchImpl: watching, pollMs: 1, intent: swapIntent });
    expect(result.outcome).toBe('confirmed');
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen)).toEqual(new Set([SKILL_VERSION]));
  });
});

describe('the same order is never swapped twice (final audit, item 7)', () => {
  const counting = (b: Awaited<ReturnType<typeof bound>>) => {
    const calls = { prepare: 0, finalize: 0 };
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/v1/prepare')) calls.prepare++;
      if (url.endsWith('/api/v1/finalize')) calls.finalize++;
      return b.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it('an order that confirmed is not prepared again: the retry is told, with the transaction that did it', async () => {
    const b = await bound();
    const orders = createFileStore(mkdtempSync(join(tmpdir(), 'bound-orders-')));
    const { calls, fetchImpl } = counting(b);
    const first = await protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: b.agentRpc, wallet: b.wallet, fetchImpl, pollMs: 1, orders, intent: { ...swapIntent, id: 'order-42' } });
    expect(first.outcome).toBe('confirmed');
    expect(await orders.order('order-42')).toEqual({ signature: first.signature, state: 'confirmed' });
    const again = await protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: b.agentRpc, wallet: b.wallet, fetchImpl, pollMs: 1, orders, intent: { ...swapIntent, id: 'order-42' } })
      .catch((e: unknown) => e);
    expect(again).toBeInstanceOf(BoundOrderError);
    expect((again as BoundOrderError).record.signature).toBe(first.signature);
    expect(calls.prepare).toBe(1);
    expect(b.sent).toHaveLength(1);
  });

  it('an order whose last attempt expired may be tried again; one taken by another worker is not sent', async () => {
    const b = await bound();
    const orders = createFileStore(mkdtempSync(join(tmpdir(), 'bound-orders-')));
    await orders.recordOrder('order-7', { signature: 'an-earlier-attempt', state: 'expired' });
    const retried = await protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: b.agentRpc, wallet: b.wallet, fetchImpl: b.fetchImpl, pollMs: 1, orders, intent: { ...swapIntent, id: 'order-7' } });
    expect(retried.outcome).toBe('confirmed');

    const c = await bound();
    const { calls, fetchImpl } = counting(c);
    // Another worker takes the order between this one's check and its signature.
    const racing: OrderBook = { order: async () => null, recordOrder: async () => {}, claimOrder: async () => false };
    const lost = await protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: c.agentRpc, wallet: c.wallet, fetchImpl, pollMs: 1, orders: racing, intent: { ...swapIntent, id: 'order-8' } })
      .catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(BoundOrderError);
    expect(calls.finalize).toBe(0);
    expect(c.sent).toHaveLength(0);
  });

  it('a stopped run leaves the order pending; recovery settles it, and the order learns its outcome', async () => {
    const b = await bound();
    const dir = mkdtempSync(join(tmpdir(), 'bound-orders-'));
    const store = createFileStore(dir);
    const landed = await protectedSwap({
      apiUrl: 'http://bound.test', apiKey: KEY, rpc: chainOf(b), wallet: b.wallet, fetchImpl: b.fetchImpl, pollMs: 1, orders: store,
      intent: { ...swapIntent, id: 'order-9' }, onSigned: s => store.put(s),
    });
    // As if the process had stopped after finalize: the order still says pending.
    await store.recordOrder('order-9', { signature: landed.signature, state: 'pending' });
    const { settled } = await recoverPending(store, chainOf(b), { pollMs: 1, maxWaitMs: 60, orders: store });
    expect(settled).toEqual([{ signature: landed.signature, outcome: 'confirmed' }]);
    expect(await store.order('order-9')).toEqual({ signature: landed.signature, state: 'confirmed' });
  });

  it('bound-verify: prepare refuses an order that already swapped (exit 5)', async () => {
    const b = await bound();
    const stateDir = mkdtempSync(join(tmpdir(), 'bound-cli-orders-'));
    const deps = { rpc: b.agentRpc, apiUrl: 'http://bound.test', apiKey: KEY, fetchImpl: b.fetchImpl, stateDir, treasury: TREASURY, pollMs: 1, maxWaitMs: 60 };
    const intent = { owner: b.wallet.address, inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', id: 'cli-order-1' };
    const ready = JSON.parse(JSON.stringify((await runCli('prepare', { intent }, deps)).output)) as { checked: unknown; message: string };
    const signature = getBase58Decoder().decode(await signBytes(b.wallet.keyPair.privateKey, Buffer.from(ready.message, 'base64')));
    expect((await runCli('finalize', { checked: ready.checked, signature }, deps)).code).toBe(0);
    const again = await runCli('prepare', { intent }, deps);
    expect(again.code).toBe(5);
    expect((again.output.order as { state: string }).state).toBe('confirmed');
  });
});

describe('the Stage 2 audit: one swap per wallet, owned locks, outcomes kept apart from bookkeeping', () => {
  it('H-02: two prepared swaps, the first unknown: the second is not sent, with or without an order id', async () => {
    const b = await bound();
    const stateDir = mkdtempSync(join(tmpdir(), 'bound-h02-'));
    let finalizes = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/v1/finalize')) finalizes++;
      return b.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    // A chain on which nothing ever shows up, and whose height never passes the swap's lifetime: the
    // first swap's outcome stays unknown however fast the machine polls.
    const rpc = { ...chainOf(b, { landAt: 10n ** 12n }), getBlockHeight: () => ({ send: async () => 1n }) } as unknown as Rpc<SolanaRpcApi>;
    const deps = { rpc, apiUrl: 'http://bound.test', apiKey: KEY, fetchImpl, stateDir, treasury: TREASURY, pollMs: 1, maxWaitMs: 60 };
    const intent = { owner: b.wallet.address, inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000' };
    const one = JSON.parse(JSON.stringify((await runCli('prepare', { intent }, deps)).output)) as { checked: unknown; message: string };
    const two = JSON.parse(JSON.stringify((await runCli('prepare', { intent }, deps)).output)) as { checked: unknown; message: string };
    const sign = async (m: string) => getBase58Decoder().decode(await signBytes(b.wallet.keyPair.privateKey, Buffer.from(m, 'base64')));
    const first = await runCli('finalize', { checked: one.checked, signature: await sign(one.message) }, deps);
    expect(first.code).toBe(3);
    expect(first.output.outcome).toBe('unknown');
    const second = await runCli('finalize', { checked: two.checked, signature: await sign(two.message) }, deps);
    expect(second.code).toBe(3);
    expect(second.output.sent).toBe(false);
    expect(second.output.pending).toEqual([first.output.signature]);
    expect(finalizes).toBe(1);
    // The first one, asked again with the same bytes, is its own record: allowed through again.
    const again = await runCli('finalize', { checked: one.checked, signature: await sign(one.message) }, deps);
    expect(again.output.signature).toBe(first.output.signature);
  }, 30_000);

  it('H-02: protectedSwap sends nothing while another swap from the wallet may still land', async () => {
    const b = await bound();
    const store = createFileStore(mkdtempSync(join(tmpdir(), 'bound-h02b-')));
    await store.put({ signature: 'an-earlier-swap', lastValidBlockHeight: 10n ** 12n, ticket: 't', signedTransaction: '', messageSha256: '', signedAt: 0, owner: b.wallet.address });
    let prepares = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/v1/prepare')) prepares++;
      return b.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const refused = await protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: b.agentRpc, wallet: b.wallet, fetchImpl, pollMs: 1, intent: swapIntent, pending: store })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PendingSwapError);
    expect(prepares).toBe(0);
    // Another wallet's pending swap is not this wallet's.
    const other = await bound();
    const fine = await protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: other.agentRpc, wallet: other.wallet, fetchImpl: other.fetchImpl, pollMs: 1, intent: swapIntent, pending: store });
    expect(fine.outcome).toBe('confirmed');
    expect((await store.list()).map(s => s.signature)).toEqual(['an-earlier-swap']);
  });

  it('M-01: a worker whose stale lock was taken over does not remove its successor; a third waits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bound-m01-'));
    const releaseA = acquireLock(dir, 'wallet', 1_000);
    // A goes silent past the stale limit: B takes over.
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'lock-wallet'), old, old);
    const releaseB = acquireLock(dir, 'wallet', 1_000);
    releaseA(); // A comes back and releases: B's lock must stay
    expect(() => acquireLock(dir, 'wallet', 1_000)).toThrow('Another swap');
    releaseB();
    acquireLock(dir, 'wallet', 1_000)();
  });

  it('M-03: a record that cannot be removed after the swap confirmed is said beside the outcome, never as "not sent"', async () => {
    const b = await bound();
    const files = createFileStore(mkdtempSync(join(tmpdir(), 'bound-m03-')));
    const failing = { ...files, remove: async () => { throw new Error('ENOSPC: no space left on device'); } };
    const stateDir = mkdtempSync(join(tmpdir(), 'bound-m03-state-'));
    const deps = { rpc: b.agentRpc, apiUrl: 'http://bound.test', apiKey: KEY, fetchImpl: b.fetchImpl, stateDir, treasury: TREASURY, pollMs: 1, maxWaitMs: 60, store: failing };
    const ready = JSON.parse(JSON.stringify((await runCli('prepare', { intent: { owner: b.wallet.address, inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000' } }, deps)).output)) as { checked: unknown; message: string };
    const signature = getBase58Decoder().decode(await signBytes(b.wallet.keyPair.privateKey, Buffer.from(ready.message, 'base64')));
    const done = await runCli('finalize', { checked: ready.checked, signature }, deps);
    expect(done.code).toBe(0);
    expect(done.output.outcome).toBe('confirmed');
    expect(done.output.signature).toBe(signature);
    expect(String(done.output.bookkeepingError)).toContain('ENOSPC');
    expect(done.output.sent).toBeUndefined();

    const c = await bound();
    const lib = await protectedSwap({ apiUrl: 'http://bound.test', apiKey: KEY, rpc: c.agentRpc, wallet: c.wallet, fetchImpl: c.fetchImpl, pollMs: 1, intent: swapIntent, pending: failing });
    expect(lib.outcome).toBe('confirmed');
    expect(lib.bookkeepingError).toContain('ENOSPC');
  });

  it("M-02: the agent's check ends in time when its RPC never answers, and says so", async () => {
    const b = await bound();
    const honest = await honestAnswer(b);
    const never = (o?: { abortSignal?: AbortSignal }) => new Promise<never>((_, reject) => o?.abortSignal?.addEventListener('abort', () => reject(new Error('timed out'))));
    const stuck = { ...b.agentRpc, getMultipleAccounts: () => ({ send: never }) } as unknown as Rpc<SolanaRpcApi>;
    const started = Date.now();
    const problems = await checkPrepared(honest, intentFor(b.wallet), stuck, { requestTimeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(problems.join()).toContain('could not be read from your RPC');
  });
});

describe('the third audit: what "no record" proves, a finalize asked again, what a route leaves open', () => {
  /** A swap kept before finalize: its transaction could land in blocks 900 to 1,075. */
  const keptSwap = (signature: string, owner: string, more: Partial<Signed> = {}): Signed => ({
    signature, lastValidBlockHeight: 1_075n, signedHeight: 900n, ticket: 't', signedTransaction: '', messageSha256: '', signedAt: 0, owner, ...more,
  });

  it('F1: recovered long after it was sent, a swap the chain has no record of stays unknown, said at once', async () => {
    const b = await bound();
    const store = createFileStore(mkdtempSync(join(tmpdir(), 'bound-f1-')));
    await store.put(keptSwap('long-ago', b.wallet.address, { intentId: 'order-1' }));
    await store.claimOrder('order-1', { signature: 'long-ago', state: 'pending' });
    // Days later: the chain is far past it, and no node's status cache reaches back that far.
    const started = Date.now();
    const { settled, unknown } = await recoverPending(store, chainOf(b, { from: 500_000n }), { pollMs: 1, maxWaitMs: 60_000, orders: store });
    expect(settled).toEqual([]);
    expect(unknown).toEqual(['long-ago']);
    expect(Date.now() - started).toBeLessThan(5_000);
    // The order is not reopened: it stays pending, so the same order is not swapped again.
    expect(await store.order('order-1')).toMatchObject({ state: 'pending' });
  });

  it('F1: right after its lifetime, the same silence does prove it expired', async () => {
    const b = await bound();
    const store = createFileStore(mkdtempSync(join(tmpdir(), 'bound-f1b-')));
    await store.put(keptSwap('just-expired', b.wallet.address));
    const { settled } = await recoverPending(store, chainOf(b, { from: 1_050n }), { pollMs: 1, maxWaitMs: 5_000 });
    expect(settled).toEqual([{ signature: 'just-expired', outcome: 'expired' }]);
  });

  it('F1: a kept swap without the height it was signed at (an older copy) is never proven expired', async () => {
    const b = await bound();
    const store = createFileStore(mkdtempSync(join(tmpdir(), 'bound-f1c-')));
    await store.put(keptSwap('no-height', b.wallet.address, { signedHeight: undefined }));
    const { unknown } = await recoverPending(store, chainOf(b, { from: 1_050n }), { pollMs: 1, maxWaitMs: 5_000 });
    expect(unknown).toEqual(['no-height']);
  });

  it('F1: settled by hand once looked up: refused while it could still land, and the chain answers first', async () => {
    const b = await bound();
    const store = createFileStore(mkdtempSync(join(tmpdir(), 'bound-f1d-')));
    await store.put(keptSwap('by-hand', b.wallet.address, { intentId: 'order-2' }));
    await store.put(keptSwap('landed-after-all', b.wallet.address));
    await expect(resolvePending(store, chainOf(b, { from: 900n }), 'by-hand', 'expired')).rejects.toThrow('can still land');
    const later = chainOf(b, { from: 500_000n, others: ['landed-after-all'] });
    expect(await resolvePending(store, later, 'by-hand', 'expired', { orders: store })).toEqual({ signature: 'by-hand', outcome: 'expired', by: 'you' });
    expect(await store.order('order-2')).toMatchObject({ state: 'expired' });
    // The operator said expired; the RPC still has it confirmed, and that is what is recorded.
    expect(await resolvePending(store, later, 'landed-after-all', 'expired')).toEqual({ signature: 'landed-after-all', outcome: 'confirmed', by: 'chain' });
    expect(await store.list()).toEqual([]);
    await expect(resolvePending(store, later, 'never-kept', 'expired')).rejects.toThrow('No kept swap');
  });

  it('F1: bound-verify resolve, the same by hand for bots', async () => {
    const b = await bound();
    const stateDir = mkdtempSync(join(tmpdir(), 'bound-f1e-'));
    await createFileStore(stateDir).put(keptSwap('by-hand', b.wallet.address));
    const deps = (rpc: Rpc<SolanaRpcApi>) => ({ rpc, stateDir, pollMs: 1, maxWaitMs: 60 });
    expect((await runCli('resolve', { signature: 'by-hand', outcome: 'gone' }, deps(chainOf(b)))).code).toBe(2);
    const early = await runCli('resolve', { signature: 'by-hand', outcome: 'expired' }, deps(chainOf(b, { from: 900n })));
    expect(early.code).toBe(1);
    expect(String(early.output.error)).toContain('can still land');
    const done = await runCli('resolve', { signature: 'by-hand', outcome: 'expired' }, deps(chainOf(b, { from: 500_000n })));
    expect(done).toMatchObject({ code: 0, output: { ok: true, signature: 'by-hand', outcome: 'expired', by: 'you' } });
    expect((await runCli('recover', {}, deps(chainOf(b)))).code).toBe(0);
  });

  it('F4: finalize asked again for a kept swap is not a first send: it answers with the signature and its outcome, whatever the checks would say now', async () => {
    const b = await bound();
    const stateDir = mkdtempSync(join(tmpdir(), 'bound-f4-'));
    let finalizes = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/v1/finalize')) finalizes++;
      return b.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    // Nothing shows up, and the height never passes the lifetime: the outcome stays unknown.
    const stuck = { ...chainOf(b, { landAt: 10n ** 12n }), getBlockHeight: () => ({ send: async () => 1n }) } as unknown as Rpc<SolanaRpcApi>;
    const deps = { rpc: stuck, apiUrl: 'http://bound.test', apiKey: KEY, fetchImpl, stateDir, treasury: TREASURY, pollMs: 1, maxWaitMs: 60 };
    const intent = { owner: b.wallet.address, inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', id: 'order-f4' };
    const ready = JSON.parse(JSON.stringify((await runCli('prepare', { intent }, deps)).output)) as { checked: unknown; message: string };
    const signature = getBase58Decoder().decode(await signBytes(b.wallet.keyPair.privateKey, Buffer.from(ready.message, 'base64')));
    const first = await runCli('finalize', { checked: ready.checked, signature }, deps);
    expect(first).toMatchObject({ code: 3, output: { outcome: 'unknown' } });
    // The agent's RPC no longer reads accounts: the check for a first send would refuse, and the
    // order is already pending. Neither may turn into "not sent".
    const blind = { ...stuck, getMultipleAccounts: () => ({ send: async () => { throw new Error('RPC unavailable'); } }) } as unknown as Rpc<SolanaRpcApi>;
    const again = await runCli('finalize', { checked: ready.checked, signature }, { ...deps, rpc: blind });
    expect(again.code).toBe(3);
    expect(again.output).toMatchObject({ signature: first.output.signature, outcome: 'unknown', resumed: true });
    expect(again.output.sent).toBeUndefined();
    // Bound was asked again for the same bytes, which land at most once.
    expect(finalizes).toBe(2);
    expect(new Set(b.sent.map(signatureOfWire))).toEqual(new Set([first.output.signature]));
  });

  it('F4: an outcome whose record cannot be updated is still returned by recovery, and the record stays for the next run', async () => {
    const b = await bound();
    const store = createFileStore(mkdtempSync(join(tmpdir(), 'bound-f4b-')));
    await store.put(keptSwap('landed', b.wallet.address, { intentId: 'order-3' }));
    const failing: OrderBook = { order: async () => null, claimOrder: async () => true, recordOrder: async () => { throw new Error('ENOSPC'); } };
    const { settled, bookkeepingErrors } = await recoverPending(store, chainOf(b, { others: ['landed'] }), { pollMs: 1, maxWaitMs: 60, orders: failing });
    expect(settled).toEqual([{ signature: 'landed', outcome: 'confirmed' }]);
    expect(bookkeepingErrors).toEqual([{ signature: 'landed', error: 'ENOSPC' }]);
    expect((await store.list()).map(s => s.signature)).toEqual(['landed']);
  });

  it('F5: an account the route opens and leaves open is refused, whatever market it belongs to', async () => {
    const b = await bound();
    const honest = await honestAnswer(b);
    let watched: string[] = [];
    // E and the Pump accounts end empty; one account the transaction created (not the wallet's own
    // output account) is still open after the swap.
    const rpc = {
      ...b.agentRpc,
      simulateTransaction: (_tx: unknown, config: { accounts: { addresses: string[] } }) => ({
        send: async () => {
          watched = config.accounts.addresses;
          return { value: { err: null, logs: [], accounts: watched.map((_, i) => (i === 7 ? { lamports: 2_039_280n } : null)) } };
        },
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    const problems = await checkPrepared(honest, intentFor(b.wallet), rpc);
    expect(watched.length).toBeGreaterThan(7);
    expect(watched).not.toContain(TREASURY);
    expect(problems.join()).toContain(`the route would leave open 1 account(s) it creates (${watched[7]})`);
    // With every account closed, the same answer passes.
    expect(await checkPrepared(honest, intentFor(b.wallet), b.agentRpc)).toEqual([]);
  });

  it('priority 4: one ceiling for all the SOL a swap may cost and not return', async () => {
    const b = await bound();
    const honest = await honestAnswer(b);
    const kept = BigInt(honest.costs.keptSolLamports ?? '-1');
    expect(kept).toBe(BigInt(honest.costs.networkFeeLamports) + BigInt(honest.costs.routeRentLamports) - BigInt(honest.costs.routeRefundLamports));
    expect(await checkPrepared(honest, { ...intentFor(b.wallet), maxSolCostLamports: 1_000_000 }, b.agentRpc)).toEqual([]);
    const tight = await checkPrepared(honest, { ...intentFor(b.wallet), maxSolCostLamports: 1 }, b.agentRpc);
    expect(tight.join()).toContain('(maxSolCostLamports)');
  });
});

describe('the Stage 2 re-run: bound-verify answers even when its state directory fails (E5)', () => {
  it('prepare, recover and resolve answer in JSON, and prepare builds nothing', async () => {
    const b = await bound();
    const stateDir = mkdtempSync(join(tmpdir(), 'bound-e5-'));
    const files = createFileStore(stateDir);
    const broken = { ...files, list: async () => { throw new Error('ENOSPC: no space left on device'); } };
    let prepares = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/v1/prepare')) prepares++;
      return b.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const deps = { rpc: b.agentRpc, apiUrl: 'http://bound.test', apiKey: KEY, fetchImpl, stateDir, treasury: TREASURY, pollMs: 1, maxWaitMs: 60, store: broken };
    const intent = { owner: b.wallet.address, inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000' };
    const prepared = await runCli('prepare', { intent }, deps);
    expect(prepared.code).toBe(3);
    expect(String(prepared.output.error)).toContain('ENOSPC');
    expect(prepares).toBe(0);
    const recovered = await runCli('recover', {}, deps);
    expect(recovered).toMatchObject({ code: 3, output: { ok: false } });
    expect(String(recovered.output.error)).toContain('ENOSPC');
    expect((await runCli('resolve', { signature: 'any', outcome: 'expired' }, deps)).code).toBe(3);
  });
});

describe("the agent's own floor for a token that taxes its transfers", () => {
  it("is priced for what reaches the route: the amount less the fee, less the token's own tax", async () => {
    let asked = '';
    const fetchImpl = (async (url: string) => {
      asked = new URL(url).searchParams.get('amount') ?? '';
      return new Response(JSON.stringify({ inputMint: USDC, outputMint: WSOL_MINT, inAmount: asked, outAmount: '1000000' }), { status: 200 });
    }) as unknown as typeof fetch;
    const base = { inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', taker: WSOL_MINT, fetchImpl };
    await ownMinimum(base);
    expect(asked).toBe('997000');
    // 2% on every transfer: 997,000 routed, 19,940 of it kept by the token on the way in.
    await ownMinimum({ ...base, inputTax: { bps: 200, maximum: 10n ** 12n } });
    expect(asked).toBe('977060');
  });

  it("reads the tax from the mint on the agent's own RPC, for the epoch now; none for a classic token", async () => {
    const mintData = new Uint8Array(166 + 4 + 108);
    mintData[44] = 6;
    mintData[165] = 1; // a mint, with extensions
    const view = new DataView(mintData.buffer);
    view.setUint16(166, 1, true); // TransferFeeConfig
    view.setUint16(168, 108, true);
    view.setBigUint64(170 + 90, 800n, true); // the newer schedule starts at epoch 800
    view.setBigUint64(170 + 98, 5_000n, true); // at most 5,000 base units
    view.setUint16(170 + 106, 150, true); // 1.5%
    const rpcWith = (owner: string) => ({
      getMultipleAccounts: () => ({ send: async () => ({ context: { slot: 1n }, value: [{ owner, lamports: 1n, data: [Buffer.from(mintData).toString('base64'), 'base64'] }] }) }),
      getEpochInfo: () => ({ send: async () => ({ epoch: 900n }) }),
    }) as unknown as Rpc<SolanaRpcApi>;
    expect(await inputTransferFee(rpcWith('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'), USDC)).toEqual({ bps: 150, maximum: 5_000n });
    expect(await inputTransferFee(rpcWith('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), USDC)).toBeNull();
  });
});
