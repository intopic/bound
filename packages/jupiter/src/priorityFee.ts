import type { Address } from '@solana/kit';

/** What the pipeline asks for the priority price of a swap's writable accounts, in micro-lamports per CU. */
export type PriorityFeeLevel = (writable: readonly Address[]) => Promise<bigint | null>;

/**
 * Helius's own estimate (`getPriorityFeeEstimate`, level High, about the 75th percentile the fallback
 * uses), which reads more than the last 150 slots of the swap's accounts. Any other RPC answers
 * "method not found", and a slow or broken answer is null: the pipeline then falls back to
 * `getRecentPrioritizationFees`, as before. The request goes out as plain JSON, not through kit,
 * whose response transform would turn the estimate (a float) into a bigint and throw.
 */
export function heliusPriorityFee(url: string, fetchImpl: typeof fetch = (...a) => fetch(...a), timeoutMs = 3_000): PriorityFeeLevel {
  return async writable => {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getPriorityFeeEstimate',
          params: [{ accountKeys: writable, options: { priorityLevel: 'High' } }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const estimate = ((await res.json()) as { result?: { priorityFeeEstimate?: unknown } })?.result?.priorityFeeEstimate;
      return typeof estimate === 'number' && Number.isFinite(estimate) && estimate >= 0 ? BigInt(Math.ceil(estimate)) : null;
    } catch {
      return null;
    }
  };
}
