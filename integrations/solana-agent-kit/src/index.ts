/**
 * Orientim for Solana Agent Kit v2: the agent's swaps go through Orientim, where the route can only
 * use the amount the agent approved, never the rest of its wallet. Each swap is checked on the agent's
 * own RPC before its wallet signs (the skill's `protectedSwap`, bundled in), and the outcome is read
 * from the chain.
 *
 *   import { SolanaAgentKit, KeypairWallet, createVercelAITools } from 'solana-agent-kit';
 *   import OrientimPlugin from '@orientim/plugin-solana-agent-kit';
 *
 *   const agent = new SolanaAgentKit(wallet, RPC_URL, { OTHER_API_KEYS: { ORIENTIM_API_KEY, JUPITER_API_KEY } })
 *     .use(OrientimPlugin);
 *   await agent.methods.orientimSwap(agent, { outputMint: USDC, inputAmount: 0.1 });   // 0.1 SOL for USDC
 *   const tools = createVercelAITools(agent, agent.actions);                             // ORIENTIM_PROTECTED_SWAP
 *
 * Without ORIENTIM_API_KEY, the wallet signs Orientim's API-key message once (text, checked first; it
 * moves nothing) and the key is kept in memory. Store it (`onApiKey`) for a process that restarts often.
 */
import { resolve } from 'node:path';
import { address, createSolanaRpc } from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { VersionedTransaction } from '@solana/web3.js';
import { z } from 'zod';
import type { Action, Plugin, SolanaAgentKit } from 'solana-agent-kit';
import {
  acquireLock, createFileStore, fillAgainstQuote, OrientimApiError, OrientimOrderError, PendingSwapError, PriceImpactError, protectedSwap,
  recoverPending, requestApiKey, signerFromSignTransaction,
} from '../../../skills/orientim-protected-swap/examples/swap.ts';
import type { OrderBook, OrderRecord, Outcome, PendingStore, Signed, WalletSigner } from '../../../skills/orientim-protected-swap/examples/swap.ts';

export type { OrderBook, OrderRecord, PendingStore, Signed };

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);

export type OrientimPluginOptions = {
  /** Orientim's address (default https://orientim.com, or ORIENTIM_API_URL in the agent's OTHER_API_KEYS). */
  apiUrl?: string;
  /** The API key; ORIENTIM_API_KEY in the agent's OTHER_API_KEYS otherwise. */
  apiKey?: string;
  /** Without a key, get one by signing Orientim's key message with the agent's wallet (default true). */
  autoKey?: boolean;
  /** Called with a key obtained that way, to store it where the agent reads its settings. */
  onApiKey?: (issued: { key: string; wallet: string; expiresAt: string }) => void | Promise<void>;
  /** The RPC every check reads the chain from: the agent's own (its connection) unless set. */
  rpcUrl?: string;
  /** Or the RPC client itself (@solana/kit), e.g. one with your provider's headers. */
  rpc?: Rpc<SolanaRpcApi>;
  /**
   * Where signed swaps and order ids are kept until settled, which is what stops a second swap while
   * one may still land, and an order from being swapped twice. Without `store` or `stateDir` they are
   * kept in this process's memory: a restart, or a second process or server, forgets them.
   *   stateDir  a directory on disk, with a lock per wallet: every process on one machine that uses it
   *   store     your own, shared by every process and server that swaps from the same wallets
   *             (a database; `claimOrder` must be atomic)
   */
  stateDir?: string;
  store?: PendingStore & OrderBook;
  /** Keep them in memory on purpose (tests, one long-running process): no warning then. */
  acceptInMemoryState?: boolean;
  /**
   * The most slippage tolerance anyone may choose, in bps: the model through the tool, or your code
   * (default 500: 5%; at most 1500, as on the page). The minimum a swap enforces sits that far below
   * the quote at most, and the agent's own floor follows it.
   */
  maxSlippageBpsCap?: number;
  /**
   * The most one swap may move the market, in bps (default 500: 5%). Above it the swap is refused
   * before anything is prepared: the mark of thin liquidity, as when a token's pool is drained. The
   * page asks a person at the same point. Only you set it, never the model.
   */
  maxPriceImpactBps?: number;
  /** Your Jupiter key, for the price your own floor is set from; JUPITER_API_KEY in OTHER_API_KEYS otherwise. */
  jupiterApiKey?: string;
  /** How long to wait for an outcome, in ms (default 3 minutes), and how often to look, in ms. */
  maxWaitMs?: number;
  pollMs?: number;
  /** How long one call to Orientim or to the RPC may take, in ms (default 30 s and 10 s). */
  requestTimeoutMs?: number;
  /** For tests: the fetch every call to Orientim and Jupiter goes through. */
  fetchImpl?: typeof fetch;
};

export type OrientimSwapInput = {
  /** The token to receive: its mint address. */
  outputMint: string;
  /** How much to pay, in whole tokens of the input (0.5 is half a SOL): only this amount can be used. */
  inputAmount: number | string;
  /** The token to pay with: its mint address; SOL when absent. */
  inputMint?: string;
  /** The least to receive, in whole output tokens, rounded up; when absent, it follows the tolerance and Jupiter's price. */
  minOutput?: number | string;
  /**
   * The slippage tolerance, as on the page: how far below the quote the swap may fill, in bps, from
   * 10 to `maxSlippageBpsCap`. Unset: 0.5%, or 3% on a Pump.fun bonding curve.
   */
  slippageBps?: number;
  /** Your order's own id, the same on every retry: with a shared `store`, an order is never swapped twice. */
  id?: string;
  /** A gap to the open market the user accepted, from a `costs-more` answer (bps, as a string). */
  acceptCostBps?: string;
};

export type OrientimSwapResult = {
  signature: string;
  /** `confirmed` landed; `failed` landed without swapping; `expired` never landed; `unknown` may still land. */
  outcome: Outcome | 'rejected';
  refusal?: string;
  inputMint: string;
  outputMint: string;
  /**
   * In whole tokens, as strings. `minimumReceived` is the least the swap could deliver, enforced by
   * the transaction; the amount delivered is in the transaction itself (`explorer`).
   */
  inputAmount: string;
  minimumReceived: string;
  quotedOutput: string;
  /** What arrived, in whole tokens, read from the confirmed transaction; absent when unreadable. */
  received?: string;
  /** The same, in base units. */
  receivedUnits?: bigint;
  /** Notes about the tokens themselves: an issuer that can freeze balances, or mint more. */
  warnings: string[];
  /** In base units, as Orientim's answer gives them. */
  amounts: { amountIn: string; minOut: string; quotedOut: string; fee: string; feeMint?: string; feeBps: string };
  explorer: string;
  bookkeepingError?: string;
};

/** An error with the reason in `code` (Orientim's own codes pass through, e.g. `costs-more`, `wrong-wallet`). */
export class OrientimPluginError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// --- whole tokens and base units

/**
 * `amount` in base units. Rounded down for what is paid (never more than was asked) and up for a
 * minimum (never less than was asked).
 */
export function toBaseUnits(amount: number | string, decimals: number, rounding: 'down' | 'up' = 'down'): bigint {
  const text = typeof amount === 'number'
    ? (Number.isFinite(amount) ? amount.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) : '')
    : amount.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new OrientimPluginError('invalid-amount', `${String(amount)} is not an amount. Nothing was prepared.`);
  const fraction = m[2] ?? '';
  let units = BigInt(m[1] + fraction.slice(0, decimals).padEnd(decimals, '0'));
  if (rounding === 'up' && /[1-9]/.test(fraction.slice(decimals))) units += 1n;
  if (units <= 0n) throw new OrientimPluginError('invalid-amount', `${String(amount)} is below the token's smallest unit. Nothing was prepared.`);
  return units;
}

export function fromBaseUnits(units: string | bigint, decimals: number): string {
  const s = BigInt(units).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** For the report of a sent swap, which must never fail: the answer's numbers were checked before signing. */
const shown = (units: string, decimals: number) => {
  try {
    return fromBaseUnits(units, decimals);
  } catch {
    return '';
  }
};

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** A mint's own layout: 82 bytes, or a Token-2022 mint with extensions (account type 1 at byte 165). */
const isMint = (owner: string, data: Uint8Array) =>
  TOKEN_PROGRAMS.has(owner) && (data.length === 82 || (owner === TOKEN_2022 && data.length > 166 && data[165] === 1));

/** Each mint's decimals, read in one call on the agent's RPC; SOL is 9. */
async function decimalsOf(rpc: Rpc<SolanaRpcApi>, mints: string[], timeoutMs: number): Promise<number[]> {
  const read = mints.filter(m => m !== SOL_MINT);
  let value: readonly ({ owner: string; data: readonly [string, string] } | null)[] = [];
  if (read.length) {
    try {
      ({ value } = await rpc.getMultipleAccounts(read.map(m => address(m)), { encoding: 'base64', commitment: 'confirmed' })
        .send({ abortSignal: AbortSignal.timeout(timeoutMs) }));
    } catch (e) {
      throw new OrientimPluginError('rpc-unavailable', `The RPC did not answer (${e instanceof Error ? e.message : String(e)}). Nothing was prepared.`);
    }
  }
  return mints.map(m => {
    if (m === SOL_MINT) return 9;
    const account = value[read.indexOf(m)];
    const data = account ? Buffer.from(account.data[0], 'base64') : null;
    if (!account || !data || !isMint(account.owner, data)) {
      throw new OrientimPluginError('not-a-token', `${m} is not a token mint on Solana. Nothing was prepared.`);
    }
    return data[44];
  });
}

// --- the agent's wallet and settings

type Agent = SolanaAgentKit;
const other = (agent: Agent, name: string): string | undefined => agent.config?.OTHER_API_KEYS?.[name] || undefined;

/**
 * The agent's wallet as the skill's signer. The wallet gets the transaction to sign, and its answer
 * counts only when it is this very transaction, signed by this wallet (`signerFromSignTransaction`).
 */
export function walletSigner(agent: Agent): WalletSigner {
  return signerFromSignTransaction(agent.wallet.publicKey.toBase58(), async transaction => {
    const signed = await agent.wallet.signTransaction(VersionedTransaction.deserialize(Buffer.from(transaction, 'base64')));
    return Buffer.from(signed.serialize()).toString('base64');
  });
}

/** Signed swaps and order ids in memory. */
function memoryStore(): PendingStore & OrderBook {
  const pending = new Map<string, Signed>();
  const orders = new Map<string, OrderRecord>();
  return {
    put: async s => void pending.set(s.signature, s),
    remove: async signature => void pending.delete(signature),
    list: async () => [...pending.values()],
    order: async id => orders.get(id) ?? null,
    recordOrder: async (id, record) => void orders.set(id, record),
    claimOrder: async (id, record) => (orders.has(id) ? false : (orders.set(id, record), true)),
  };
}

type Issued = { key: string; wallet: string; expiresAt: string };
/**
 * What every copy of the plugin in this process shares: its memory store, the files it opened, the
 * queue of each wallet and the keys it got. A project that loads the plugin twice (the `import` and
 * the `require` build, or two versions) still has one queue per wallet (independent audit, ORI-02).
 */
type Shared = {
  memory: PendingStore & OrderBook;
  files: Map<string, PendingStore & OrderBook>;
  queues: Map<string, Promise<unknown>>;
  keys: Map<string, Promise<Issued>>;
  warned: boolean;
};
const SHARED = Symbol.for('@orientim/plugin-solana-agent-kit/shared');
function shared(): Shared {
  const g = globalThis as unknown as Record<symbol, Shared | undefined>;
  return (g[SHARED] ??= { memory: memoryStore(), files: new Map(), queues: new Map(), keys: new Map(), warned: false });
}

const bps = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000;
const MIN_SLIPPAGE_BPS = 10;
const MAX_SLIPPAGE_BPS = 1_500;
const slippage = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= MIN_SLIPPAGE_BPS && v <= MAX_SLIPPAGE_BPS;
const pct = (b: number) => `${b / 100}%`;

export type OrientimPlugin = Plugin & {
  methods: {
    orientimSwap: (agent: Agent, input: OrientimSwapInput) => Promise<OrientimSwapResult>;
    orientimApiKey: (agent: Agent) => Promise<{ key: string; wallet: string; expiresAt: string | null }>;
  };
};

/**
 * The plugin, with its own options. `OrientimPlugin` (the default export) is this with none: every
 * setting then comes from the agent.
 */
export function createOrientimPlugin(options: OrientimPluginOptions = {}): OrientimPlugin {
  const cap = options.maxSlippageBpsCap ?? 500;
  if (!slippage(cap)) throw new OrientimPluginError('invalid-option', `maxSlippageBpsCap must be a whole number of bps from ${MIN_SLIPPAGE_BPS} to ${MAX_SLIPPAGE_BPS}.`);
  const maxImpact = options.maxPriceImpactBps ?? 500;
  if (!bps(maxImpact)) throw new OrientimPluginError('invalid-option', 'maxPriceImpactBps must be a whole number of bps from 0 to 10000.');
  const state = shared();
  const dir = options.stateDir ? resolve(options.stateDir) : null;
  const fileStore = (d: string) => {
    let s = state.files.get(d);
    if (!s) state.files.set(d, (s = createFileStore(d)));
    return s;
  };
  const store = options.store ?? (dir ? fileStore(dir) : state.memory);
  const timeoutMs = options.requestTimeoutMs ?? 10_000;

  const apiUrlOf = (agent: Agent) => (options.apiUrl ?? other(agent, 'ORIENTIM_API_URL') ?? 'https://orientim.com').replace(/\/+$/, '');
  const rpcOf = (agent: Agent) => options.rpc ?? createSolanaRpc(options.rpcUrl ?? agent.connection.rpcEndpoint);

  async function orientimApiKey(agent: Agent): Promise<{ key: string; wallet: string; expiresAt: string | null }> {
    const wallet = agent.wallet.publicKey.toBase58();
    const configured = options.apiKey ?? other(agent, 'ORIENTIM_API_KEY');
    if (configured) return { key: configured, wallet, expiresAt: null };
    if (options.autoKey === false) {
      throw new OrientimPluginError('no-api-key', 'Set ORIENTIM_API_KEY in the agent\'s OTHER_API_KEYS (get one on Orientim\'s docs page, under API access). Nothing was prepared.');
    }
    const apiUrl = apiUrlOf(agent);
    const slot = `${apiUrl} ${wallet}`;
    const kept = state.keys.get(slot);
    if (kept) {
      const k = await kept.catch(() => null);
      // A day's margin: a key is never used on its last day.
      if (k && Date.parse(k.expiresAt) - Date.now() > 86_400_000) return k;
    }
    const asked = requestApiKey({
      apiUrl, address: wallet, signMessage: m => agent.wallet.signMessage(m), fetchImpl: options.fetchImpl, requestTimeoutMs: options.requestTimeoutMs,
    }).then(async issued => {
      await options.onApiKey?.(issued);
      return issued;
    });
    state.keys.set(slot, asked);
    asked.catch(() => state.keys.delete(slot));
    return asked;
  }

  async function swapNow(agent: Agent, input: OrientimSwapInput): Promise<OrientimSwapResult> {
    if (agent.config?.signOnly) {
      throw new OrientimPluginError('sign-only', 'Orientim sends the swap once the wallet has signed it, so signOnly is not supported for Orientim swaps. Nothing was signed.');
    }
    const inputMint = input.inputMint || SOL_MINT;
    const { outputMint } = input;
    for (const mint of [inputMint, outputMint]) {
      try {
        address(mint);
      } catch {
        throw new OrientimPluginError('invalid-mint', `${mint} is not a Solana address. Nothing was prepared.`);
      }
    }
    if (inputMint === outputMint) throw new OrientimPluginError('same-token', 'The input and output are the same token. Nothing was prepared.');
    // Only a missing value takes Orientim's default; anything given is checked (ORI-04).
    const tolerance = input.slippageBps ?? undefined;
    if (tolerance !== undefined && !slippage(tolerance)) {
      throw new OrientimPluginError('invalid-input', `slippageBps must be a whole number of bps from ${MIN_SLIPPAGE_BPS} to ${MAX_SLIPPAGE_BPS}, not ${String(tolerance)}. Nothing was prepared.`);
    }
    if (tolerance !== undefined && tolerance > cap) {
      throw new OrientimPluginError('slippage-above-limit', `A ${pct(tolerance)} slippage tolerance is above this agent's limit of ${pct(cap)}. Nothing was prepared.`);
    }
    const rpc = rpcOf(agent);
    const [inDecimals, outDecimals] = await decimalsOf(rpc, [inputMint, outputMint], timeoutMs);
    const amountIn = toBaseUnits(input.inputAmount, inDecimals);
    const minOut = input.minOutput !== undefined && input.minOutput !== null ? toBaseUnits(input.minOutput, outDecimals, 'up') : undefined;
    const owner = agent.wallet.publicKey.toBase58();
    const release = dir && !options.store ? acquireLock(dir, owner) : () => {};
    try {
      // What an earlier call left for this wallet is settled first; while an outcome is unknown, or a
      // settled one could not be recorded, nothing new starts.
      const mine: PendingStore = {
        put: s => store.put(s),
        remove: signature => store.remove(signature),
        list: async () => (await store.list()).filter(s => (s.owner ?? owner) === owner),
      };
      const { settled, unknown, bookkeepingErrors } = await recoverPending(mine, rpc, {
        orders: store, maxWaitMs: Math.min(options.maxWaitMs ?? 60_000, 60_000), pollMs: options.pollMs,
      });
      if (unknown.length) {
        throw new OrientimPluginError('swap-unsettled', `An earlier swap from this wallet (${unknown.join(', ')}) has no outcome yet. Nothing new was started; ask again in a minute.`);
      }
      if (bookkeepingErrors.length) {
        const [b] = bookkeepingErrors;
        const outcome = settled.find(s => s.signature === b.signature)?.outcome ?? 'settled';
        throw new OrientimPluginError('record-not-updated', `An earlier swap from this wallet (${b.signature}) ended ${outcome}, but its record could not be updated (${b.error}). `
          + 'Nothing new was started: fix where swaps are kept, then ask again.');
      }
      const { key } = await orientimApiKey(agent);
      const result = await protectedSwap({
        apiUrl: apiUrlOf(agent),
        apiKey: key,
        rpc,
        wallet: walletSigner(agent),
        intent: {
          inputMint, outputMint, amountIn: amountIn.toString(),
          ...(minOut !== undefined ? { minOut: minOut.toString() } : {}),
          ...(tolerance !== undefined ? { slippageBps: tolerance } : {}),
          maxPriceImpactBps: maxImpact,
          ...(input.id ? { id: input.id } : {}),
          ...(input.acceptCostBps ? { acceptCostBps: input.acceptCostBps } : {}),
        },
        jupiterApiKey: options.jupiterApiKey ?? other(agent, 'JUPITER_API_KEY'),
        fetchImpl: options.fetchImpl,
        maxWaitMs: options.maxWaitMs,
        pollMs: options.pollMs,
        requestTimeoutMs: options.requestTimeoutMs,
        orders: store,
        pending: store,
      });
      // The swap may be on the chain from here on: nothing below can fail, so its signature and
      // outcome always reach the caller (ORI-01).
      const a = result.prepared.amounts;
      return {
        signature: result.signature,
        outcome: result.outcome,
        ...(result.refusal ? { refusal: result.refusal } : {}),
        inputMint, outputMint,
        inputAmount: shown(a.amountIn, inDecimals),
        minimumReceived: shown(a.minOut, outDecimals),
        quotedOutput: shown(a.quotedOut, outDecimals),
        ...(result.received !== undefined ? { received: shown(result.received, outDecimals), receivedUnits: BigInt(result.received) } : {}),
        warnings: result.notices,
        amounts: { amountIn: a.amountIn, minOut: a.minOut, quotedOut: a.quotedOut, fee: a.fee, ...(a.feeMint ? { feeMint: a.feeMint } : {}), feeBps: a.feeBps },
        explorer: `https://solscan.io/tx/${result.signature}`,
        ...(result.bookkeepingError ? { bookkeepingError: result.bookkeepingError } : {}),
      };
    } finally {
      release();
    }
  }

  /** One swap per wallet at a time in this process, across every copy of the plugin: a second call waits for the first. */
  function orientimSwap(agent: Agent, input: OrientimSwapInput): Promise<OrientimSwapResult> {
    const wallet = agent.wallet.publicKey.toBase58();
    const before = state.queues.get(wallet) ?? Promise.resolve();
    const run = before.catch(() => {}).then(() => swapNow(agent, input));
    const tail = run.catch(() => {});
    state.queues.set(wallet, tail);
    void tail.then(() => {
      if (state.queues.get(wallet) === tail) state.queues.delete(wallet);
    });
    return run;
  }

  return {
    name: 'orientim',
    methods: { orientimSwap, orientimApiKey },
    actions: [protectedSwapAction(orientimSwap)],
    initialize: () => {
      if (options.store || dir || options.acceptInMemoryState || state.warned) return;
      state.warned = true;
      console.warn('Orientim: swaps that are signed but not yet settled are kept in this process\'s memory. A restart, or a second process '
        + 'or server, forgets them and could send a second swap. Set `stateDir` (one machine) or `store` (several) in production.');
    },
  };
}

// --- the action the AI frameworks see

const mint = () => z.string().min(32).max(44);
/** Optional fields are nullable too: OpenAI's tools ask for every field, and a model sends null for "none". */
export const swapSchema = z.object({
  outputMint: mint().describe('Mint address of the token to receive'),
  inputAmount: z.number().positive().describe('How much of the input token to swap, in whole tokens (0.5 is half a SOL)'),
  inputMint: mint().optional().nullable().describe('Mint address of the token to pay with; SOL when empty'),
  slippageBps: z.number().int().min(MIN_SLIPPAGE_BPS).max(MAX_SLIPPAGE_BPS).optional().nullable()
    .describe('Slippage tolerance in basis points: how far below the quote the swap may fill (default 50; 300 on a Pump.fun launch curve). '
      + 'Above the limit the agent\'s owner set (500 unless set), the swap is refused'),
});

/** Why a swap did not go ahead, for the model to tell the user. */
function failure(e: unknown): { status: 'error'; code: string; message: string; retryAfter?: number } {
  if (e instanceof z.ZodError) return { status: 'error', code: 'invalid-input', message: e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
  if (e instanceof PriceImpactError) {
    return {
      status: 'error', code: 'price-impact-high',
      message: `Price impact is ${(e.impactBps / 100).toFixed(2)}%: this amount would move the market too much, a sign of thin liquidity. `
        + 'Nothing was sent. Try a smaller amount.',
    };
  }
  if (e instanceof OrientimApiError) {
    const retry = e.retryAfter ? { retryAfter: e.retryAfter } : {};
    if (e.code === 'price-moved') {
      return { status: 'error', code: e.code, message: 'Price moved beyond the tolerance while the swap was prepared. Nothing was sent. Try again, or use a higher slippageBps.', ...retry };
    }
    if (e.code === 'costs-more') {
      const gap = Number((e.body as { gapBps?: unknown }).gapBps);
      const below = Number.isFinite(gap) ? `${(gap / 100).toFixed(2)}% ` : '';
      return { status: 'error', code: e.code, message: `Best available rate for this amount is ${below}below market. Nothing was sent. Try a smaller amount, or again shortly.`, ...retry };
    }
    return { status: 'error', code: e.code, message: e.message.replace(/^\d+ [\w-]+: /, ''), ...retry };
  }
  if (e instanceof OrientimPluginError) return { status: 'error', code: e.code, message: e.message };
  if (e instanceof PendingSwapError) return { status: 'error', code: 'swap-unsettled', message: e.message };
  if (e instanceof OrientimOrderError) return { status: 'error', code: 'order-taken', message: e.message };
  const said = e instanceof Error ? e.message : String(e);
  // The agent's own check: Orientim stopped the swap before the wallet signed.
  if (/^Not signing: /.test(said)) {
    return { status: 'error', code: 'swap-refused', message: `Orientim stopped this swap before signing: ${said.replace(/^Not signing: /, '')}. Nothing was sent.` };
  }
  return { status: 'error', code: 'swap-refused', message: said };
}

/** What the model is told, in the words the page uses: what happened to the money, and what to do next. */
const said = (r: OrientimSwapResult, tolerance: string): string => {
  const expected = BigInt(r.amounts.quotedOut) - (r.amounts.feeMint === r.outputMint && r.amounts.feeMint !== r.inputMint ? BigInt(r.amounts.fee) : 0n);
  const vs = r.received !== undefined && r.receivedUnits !== undefined ? fillAgainstQuote(r.receivedUnits, expected, tolerance) : '';
  const text = {
    confirmed: r.received !== undefined
      ? `Swapped ${r.inputAmount} for ${r.received} of the output token.${vs ? ` ${vs}` : ''} At least ${r.minimumReceived} was guaranteed; the swap could use only ${r.inputAmount}.`
      : `Swapped ${r.inputAmount} for at least ${r.minimumReceived} of the output token; the swap could use only ${r.inputAmount}.`,
    failed: 'Swap cancelled on-chain: the minimum was enforced, so nothing was swapped and only the network fee was used. '
      + 'The usual cause is a price move beyond the tolerance: try again, or use a higher slippageBps.',
    expired: 'The swap expired before it landed and can no longer execute. Nothing was swapped.',
    unknown: 'The swap may still land. No new swap starts from this wallet until it settles: check the signature before trying again.',
    rejected: 'The swap was not sent. Nothing moved.',
  }[r.outcome];
  return r.warnings.length ? `${text} Token notes: ${r.warnings.join('; ')}.` : text;
};

export function protectedSwapAction(swap: (agent: Agent, input: OrientimSwapInput) => Promise<OrientimSwapResult>): Action {
  return {
    name: 'ORIENTIM_PROTECTED_SWAP',
    similes: ['protected swap', 'safe swap', 'swap tokens safely', 'buy a token with SOL', 'sell a token for SOL or USDC'],
    description: 'Swap tokens on Solana through Orientim. Only the amount given can be used by the route, never the rest of the wallet, '
      + 'and the swap is checked before the wallet signs. inputAmount is in whole tokens; inputMint defaults to SOL. '
      + 'Fee 0.3%. Returns the signature, what arrived, and notes about the tokens to pass on to the user.',
    examples: [[{
      input: { outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', inputAmount: 0.1 },
      output: {
        status: 'success', outcome: 'confirmed', signature: '<transaction signature>', minimumReceived: '14.6', received: '14.68',
        message: 'Swapped 0.1 for 14.68 of the output token. At least 14.6 was guaranteed; the swap could use only 0.1.',
      },
      explanation: 'Swap 0.1 SOL for USDC, at least 14.6 USDC: the route could use the 0.1 SOL and nothing else in the wallet',
    }]],
    schema: swapSchema,
    // Checked here as well: LangChain calls the handler without the schema.
    handler: async (agent, input) => {
      try {
        const i = swapSchema.parse(input);
        const r = await swap(agent, {
          outputMint: i.outputMint, inputAmount: i.inputAmount,
          ...(i.inputMint ? { inputMint: i.inputMint } : {}), ...(i.slippageBps !== null && i.slippageBps !== undefined ? { slippageBps: i.slippageBps } : {}),
        });
        const { receivedUnits: _units, ...shownResult } = r;
        const tolerance = i.slippageBps ? pct(i.slippageBps) : '';
        return { status: r.outcome === 'confirmed' ? 'success' : 'error', message: r.refusal ?? said(r, tolerance), ...shownResult };
      } catch (e) {
        return failure(e);
      }
    },
  };
}

const OrientimPlugin = createOrientimPlugin();
export default OrientimPlugin;
