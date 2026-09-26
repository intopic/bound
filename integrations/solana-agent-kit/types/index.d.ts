// The plugin's public types (src/index.ts), kept by hand: test/types-check.ts holds them to the source.
import type { Rpc, SolanaRpcApi, TransactionPartialSigner } from '@solana/kit';
import type { Action, Plugin, SolanaAgentKit } from 'solana-agent-kit';
import type { z } from 'zod';

export declare const SOL_MINT = 'So11111111111111111111111111111111111111112';

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
  outcome: 'confirmed' | 'failed' | 'expired' | 'unknown' | 'rejected';
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
export declare class OrientimPluginError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export type OrientimPlugin = Plugin & {
  methods: {
    orientimSwap: (agent: SolanaAgentKit, input: OrientimSwapInput) => Promise<OrientimSwapResult>;
    orientimApiKey: (agent: SolanaAgentKit) => Promise<{ key: string; wallet: string; expiresAt: string | null }>;
  };
};

/** `amount` in base units, rounded down: never more than was asked. */
export declare function toBaseUnits(amount: number | string, decimals: number): bigint;
export declare function fromBaseUnits(units: string | bigint, decimals: number): string;
/** The agent's wallet as the skill's signer: its answer counts only when it is this very transaction, signed by this wallet. */
export declare function walletSigner(agent: SolanaAgentKit): TransactionPartialSigner;
/** The plugin, with its own options. The default export is this with none. */
export declare function createOrientimPlugin(options?: OrientimPluginOptions): OrientimPlugin;
export declare const swapSchema: z.ZodObject<{
  outputMint: z.ZodString;
  inputAmount: z.ZodNumber;
  inputMint: z.ZodNullable<z.ZodOptional<z.ZodString>>;
  slippageBps: z.ZodNullable<z.ZodOptional<z.ZodNumber>>;
}, 'strip'>;
export declare function protectedSwapAction(swap: (agent: SolanaAgentKit, input: OrientimSwapInput) => Promise<OrientimSwapResult>): Action;

declare const OrientimPlugin: OrientimPlugin;
export default OrientimPlugin;
