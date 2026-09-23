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
  /** The least the agent accepts, in base units of the output; Bound's floor may be stricter. */
  minOut?: string;
  /** The highest Bound fee accepted, in bps (Bound's is 20). */
  maxFeeBps?: number;
  /** The most the transaction may cost in network fees, in lamports (default 0.001 SOL). */
  maxNetworkFeeLamports?: number;
  /** When set, the fee may go only to this treasury wallet (or nowhere). */
  treasury?: string;
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
 * agent's own RPC) and the policy held to `limits`. Returns the problems found; sign only when empty.
 */
export function verifyPrepared(prepared: PreparedSwap, limits: AgentLimits, rpc: Rpc<SolanaRpcApi>): Promise<string[]>;
