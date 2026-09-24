// Types for bound-verify.mjs, the bundled agent verifier (source: ../src/verify.ts).
import type { Rpc, SolanaRpcApi } from '@solana/kit';

/** What the agent asked for, and the most it accepts. */
export type AgentLimits = {
  /** The agent's wallet, which signs first and pays. */
  owner: string;
  inputMint: string;
  outputMint: string;
  /** Base units, as a string: everything that leaves the wallet in the input token, fee included. */
  amountIn: string;
  /**
   * The least the agent accepts, in base units of the output. Required, and from a price the agent
   * got itself (`ownMinimum` asks Jupiter), never from Bound's answer. Bound's floor may be stricter.
   */
  minOut: string;
  /** The highest Bound fee accepted, in bps (Bound's is 30: anything above is refused by default). */
  maxFeeBps?: number;
  /** The most the transaction may cost in network fees, in lamports (default 0.001 SOL). */
  maxNetworkFeeLamports?: number;
  /** When set, the fee may go only to this treasury wallet (or nowhere). */
  treasury?: string;
  /**
   * The most rent the route may keep, in lamports: what the wallet sends for a market's account,
   * less what closing it returns in the same transaction (default 0.001 SOL). A Pump.fun bonding
   * curve keeps about 0.00013 SOL of every buy for growing its own account.
   */
  maxRouteCostLamports?: number;
  /**
   * The most Bound's fee may be in lamports when it is paid in SOL from the wallet (a swap between
   * two tokens neither of which can carry it). Required for such a swap; `ownSolFeeLimit` asks
   * Jupiter for it.
   */
  maxSolFeeLamports?: number;
};

/** The parts of a /api/v1/prepare answer the check reads. */
export type PreparedSwap = {
  transaction: string;
  messageSha256: string;
  temporaryAuthority: string;
  policy: Record<string, unknown>;
};

/**
 * Runs Bound's full verifier on the prepared transaction, with chain state read from `rpc` (the
 * agent's own RPC) and the policy held to `limits`, then simulates it there: nothing may stay under
 * the one-time key, in its own account or in a Pump.fun market's account in its name. Returns the
 * problems found; sign only when empty.
 */
export function verifyPrepared(prepared: PreparedSwap, limits: AgentLimits, rpc: Rpc<SolanaRpcApi>): Promise<string[]>;

/**
 * A floor of the agent's own: Jupiter's price for the amount Bound will route, asked for directly,
 * less `maxBelowBps` (default 2%, or 5% on a Pump.fun bonding curve). In base units, as a string.
 */
export function ownMinimum(args: {
  inputMint: string; outputMint: string; amountIn: string; taker: string;
  maxFeeBps?: number; maxBelowBps?: number; jupiterUrl?: string; apiKey?: string; fetchImpl?: typeof fetch;
}): Promise<string>;

/**
 * The most Bound's fee in SOL may be, from a price the agent asks Jupiter for itself: `maxFeeBps`
 * (default 30) of what `amountIn` of the input is worth in SOL, plus 2% for the price moving. In
 * lamports.
 */
export function ownSolFeeLimit(args: {
  inputMint: string; amountIn: string; taker: string;
  maxFeeBps?: number; jupiterUrl?: string; apiKey?: string; fetchImpl?: typeof fetch;
}): Promise<number>;
