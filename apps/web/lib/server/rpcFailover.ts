import { createDefaultRpcTransport, createSolanaRpcFromTransport } from '@solana/kit';
import { createRetryingRpc, httpStatusOf, retryingTransport } from '@orientim/solana';
import type { SolanaRpc } from '@orientim/solana';

type Transport = ReturnType<typeof createDefaultRpcTransport>;
type Config = Parameters<Transport>[0];

/**
 * The agent API's RPC, with the operator's backup (RPC_URL_FALLBACK) behind the main one: the same
 * rule as the page's relay (rpcProxy.ts). The backup is asked when the main RPC does not answer, is
 * still rate-limited after its retries, or fails (5xx). A read takes the backup's answer; a send
 * takes it only when it is a success, since a refusal from the backup says nothing about what the
 * main RPC may already have broadcast.
 */
export function createServerRpc(primary: string, fallback: string | null): SolanaRpc {
  if (!fallback || fallback === primary) return createRetryingRpc(primary);
  const main = retryingTransport(createDefaultRpcTransport({ url: primary as `https://${string}` }));
  const backup = retryingTransport(createDefaultRpcTransport({ url: fallback as `https://${string}` }));
  const transport = (async (config: Config) => {
    try {
      return await main(config);
    } catch (e) {
      // The caller's own cancel is not an outage; neither is an HTTP error that is not one (4xx).
      if ((config as { signal?: AbortSignal }).signal?.aborted) throw e;
      const status = httpStatusOf(e);
      if (status !== null && status !== 429 && status < 500) throw e;
      const method = (config as { payload?: { method?: unknown } }).payload?.method;
      if (method !== 'sendTransaction') return backup(config);
      let answer: unknown;
      try {
        answer = await backup(config);
      } catch {
        throw e;
      }
      if (answer !== null && typeof answer === 'object' && 'result' in answer && !('error' in answer)) return answer;
      throw e;
    }
  }) as Transport;
  return createSolanaRpcFromTransport(transport) as unknown as SolanaRpc;
}
