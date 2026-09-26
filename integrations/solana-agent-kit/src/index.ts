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
import { address, createSolanaRpc } from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { VersionedTransaction } from '@solana/web3.js';
import { z } from 'zod';
import type { Action, Plugin, SolanaAgentKit } from 'solana-agent-kit';
import {
  acquireLock, createFileStore, OrientimApiError, OrientimOrderError, PendingSwapError, protectedSwap, recoverPending,
  requestApiKey, signerFromSignTransaction,
} from '../../../skills/orientim-protected-swap/examples/swap.ts';
import type { OrderBook, OrderRecord, Outcome, PendingStore, Signed, WalletSigner } from '../../../skills/orientim-protected-swap/examples/swap.ts';

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
   * Keep signed swaps and order ids on disk here, and hold a lock per wallet across processes
   * sharing it. Without it they are kept in memory: enough for one long-running process.
   */
  stateDir?: string;
  /** Your Jupiter key, for the price your own floor is set from; JUPITER_API_KEY in OTHER_API_KEYS otherwise. */
  jupiterApiKey?: string;
  /** How long to wait for an outcome, in ms (default 3 minutes), and how often to look, in ms. */
  maxWaitMs?: number;
  pollMs?: number;
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
  /** The least to receive, in whole output tokens; when absent, Jupiter's price less `maxBelowBps`. */
  minOutput?: number | string;
  /** How far below Jupiter's price the floor may be, in bps (default 200; 500 on a Pump.fun curve). */
  maxBelowBps?: number;
  /** Your order's own id, the same on every retry: an order is never swapped twice. */
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
  /** In whole tokens, as strings. */
  inputAmount: string;
  minimumReceived: string;
  quotedOutput: string;
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

/** `amount` in base units, rounded down: never more than was asked. */
export function toBaseUnits(amount: number | string, decimals: number): bigint {
  const text = typeof amount === 'number'
    ? (Number.isFinite(amount) ? amount.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) : '')
    : amount.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new OrientimPluginError('invalid-amount', `${String(amount)} is not an amount. Nothing was prepared.`);
  const units = BigInt(m[1] + (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0'));
  if (units <= 0n) throw new OrientimPluginError('invalid-amount', `${String(amount)} is below the token's smallest unit. Nothing was prepared.`);
  return units;
}

export function fromBaseUnits(units: string | bigint, decimals: number): string {
  const s = BigInt(units).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** Each mint's decimals, read in one call on the agent's RPC; SOL is 9. */
async function decimalsOf(rpc: Rpc<SolanaRpcApi>, mints: string[]): Promise<number[]> {
  const read = mints.filter(m => m !== SOL_MINT);
  const { value } = read.length
    ? await rpc.getMultipleAccounts(read.map(m => address(m)), { encoding: 'base64', commitment: 'confirmed' }).send()
    : { value: [] };
  return mints.map(m => {
    if (m === SOL_MINT) return 9;
    const account = value[read.indexOf(m)];
    const data = account ? Buffer.from(account.data[0], 'base64') : null;
    if (!account || !data || !TOKEN_PROGRAMS.has(account.owner) || data.length < 82) {
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

/** Signed swaps and order ids in memory, for one process. */
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
  const store = options.stateDir ? createFileStore(options.stateDir) : memoryStore();
  const keys = new Map<string, Promise<{ key: string; wallet: string; expiresAt: string }>>();
  const queues = new Map<string, Promise<unknown>>();

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
    const kept = keys.get(slot);
    if (kept) {
      const k = await kept.catch(() => null);
      // A day's margin: a key is never used on its last day.
      if (k && Date.parse(k.expiresAt) - Date.now() > 86_400_000) return k;
    }
    const asked = requestApiKey({ apiUrl, address: wallet, signMessage: m => agent.wallet.signMessage(m), fetchImpl: options.fetchImpl })
      .then(async issued => {
        await options.onApiKey?.(issued);
        return issued;
      });
    keys.set(slot, asked);
    asked.catch(() => keys.delete(slot));
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
    const rpc = rpcOf(agent);
    const [inDecimals, outDecimals] = await decimalsOf(rpc, [inputMint, outputMint]);
    const amountIn = toBaseUnits(input.inputAmount, inDecimals);
    const minOut = input.minOutput !== undefined && input.minOutput !== null ? toBaseUnits(input.minOutput, outDecimals) : undefined;
    const release = options.stateDir ? acquireLock(options.stateDir, agent.wallet.publicKey.toBase58()) : () => {};
    try {
      // What an earlier call left for this wallet is settled first; while an outcome is unknown, nothing new starts.
      const owner = agent.wallet.publicKey.toBase58();
      const mine: PendingStore = { ...store, list: async () => (await store.list()).filter(s => (s.owner ?? owner) === owner) };
      const { unknown } = await recoverPending(mine, rpc, { orders: store, maxWaitMs: 60_000, pollMs: options.pollMs });
      if (unknown.length) {
        throw new OrientimPluginError('swap-unsettled', `An earlier swap from this wallet (${unknown.join(', ')}) has no outcome yet. Nothing new was started; ask again in a minute.`);
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
          ...(input.maxBelowBps ? { maxBelowBps: input.maxBelowBps } : {}),
          ...(input.id ? { id: input.id } : {}),
          ...(input.acceptCostBps ? { acceptCostBps: input.acceptCostBps } : {}),
        },
        jupiterApiKey: options.jupiterApiKey ?? other(agent, 'JUPITER_API_KEY'),
        fetchImpl: options.fetchImpl,
        maxWaitMs: options.maxWaitMs,
        pollMs: options.pollMs,
        orders: store,
        pending: store,
      });
      const a = result.prepared.amounts;
      return {
        signature: result.signature,
        outcome: result.outcome,
        ...(result.refusal ? { refusal: result.refusal } : {}),
        inputMint, outputMint,
        inputAmount: fromBaseUnits(a.amountIn, inDecimals),
        minimumReceived: fromBaseUnits(a.minOut, outDecimals),
        quotedOutput: fromBaseUnits(a.quotedOut, outDecimals),
        amounts: { amountIn: a.amountIn, minOut: a.minOut, quotedOut: a.quotedOut, fee: a.fee, ...(a.feeMint ? { feeMint: a.feeMint } : {}), feeBps: a.feeBps },
        explorer: `https://solscan.io/tx/${result.signature}`,
        ...(result.bookkeepingError ? { bookkeepingError: result.bookkeepingError } : {}),
      };
    } finally {
      release();
    }
  }

  /** One swap per wallet at a time in this process: a second call waits for the first to settle. */
  function orientimSwap(agent: Agent, input: OrientimSwapInput): Promise<OrientimSwapResult> {
    const wallet = agent.wallet.publicKey.toBase58();
    const before = queues.get(wallet) ?? Promise.resolve();
    const run = before.catch(() => {}).then(() => swapNow(agent, input));
    const tail = run.catch(() => {});
    queues.set(wallet, tail);
    void tail.then(() => {
      if (queues.get(wallet) === tail) queues.delete(wallet);
    });
    return run;
  }

  return {
    name: 'orientim',
    methods: { orientimSwap, orientimApiKey },
    actions: [protectedSwapAction(orientimSwap)],
    initialize: () => {},
  };
}

// --- the action the AI frameworks see

const mint = () => z.string().min(32).max(44);
/** Optional fields are nullable too: OpenAI's tools ask for every field, and a model sends null for "none". */
export const swapSchema = z.object({
  outputMint: mint().describe('Mint address of the token to receive'),
  inputAmount: z.number().positive().describe('How much of the input token to swap, in whole tokens (0.5 is half a SOL)'),
  inputMint: mint().optional().nullable().describe('Mint address of the token to pay with; SOL when empty'),
  slippageBps: z.number().int().min(1).max(5_000).optional().nullable()
    .describe('How far below the current price the minimum received may be, in basis points (default 200; 500 on a Pump.fun curve)'),
});

/** Why a swap did not go ahead, for the model to tell the user. */
function failure(e: unknown): { status: 'error'; code: string; message: string; retryAfter?: number } {
  if (e instanceof z.ZodError) return { status: 'error', code: 'invalid-input', message: e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
  if (e instanceof OrientimApiError) {
    return { status: 'error', code: e.code, message: e.message.replace(/^\d+ [\w-]+: /, ''), ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}) };
  }
  if (e instanceof OrientimPluginError) return { status: 'error', code: e.code, message: e.message };
  if (e instanceof PendingSwapError) return { status: 'error', code: 'swap-unsettled', message: e.message };
  if (e instanceof OrientimOrderError) return { status: 'error', code: 'order-taken', message: e.message };
  return { status: 'error', code: 'swap-refused', message: e instanceof Error ? e.message : String(e) };
}

const SAID: Record<OrientimSwapResult['outcome'], string> = {
  confirmed: 'The swap landed.',
  failed: 'The transaction landed but the swap failed; only the network fee was spent.',
  expired: 'The swap did not land and can no longer land. Nothing was swapped.',
  unknown: 'The swap may still land: check the signature before swapping again.',
  rejected: 'The swap was not sent.',
};

export function protectedSwapAction(swap: (agent: Agent, input: OrientimSwapInput) => Promise<OrientimSwapResult>): Action {
  return {
    name: 'ORIENTIM_PROTECTED_SWAP',
    similes: ['protected swap', 'safe swap', 'swap tokens safely', 'buy a token with SOL', 'sell a token for SOL or USDC'],
    description: 'Swap tokens on Solana through Orientim. Only the amount given can be used by the route, never the rest of the wallet, '
      + 'and the swap is checked before the wallet signs. inputAmount is in whole tokens; inputMint defaults to SOL. '
      + 'Fee 0.3%. Returns the signature and whether it landed.',
    examples: [[{
      input: { outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', inputAmount: 0.1 },
      output: { status: 'success', outcome: 'confirmed', signature: '<transaction signature>', minimumReceived: '14.6', message: 'The swap landed.' },
      explanation: 'Swap 0.1 SOL for USDC: the route could use the 0.1 SOL and nothing else in the wallet',
    }]],
    schema: swapSchema,
    // Checked here as well: LangChain calls the handler without the schema.
    handler: async (agent, input) => {
      try {
        const i = swapSchema.parse(input);
        const r = await swap(agent, {
          outputMint: i.outputMint, inputAmount: i.inputAmount,
          ...(i.inputMint ? { inputMint: i.inputMint } : {}), ...(i.slippageBps ? { maxBelowBps: i.slippageBps } : {}),
        });
        return { status: r.outcome === 'confirmed' ? 'success' : 'error', message: r.refusal ?? SAID[r.outcome], ...r };
      } catch (e) {
        return failure(e);
      }
    },
  };
}

const OrientimPlugin = createOrientimPlugin();
export default OrientimPlugin;
