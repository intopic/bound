import { isAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { checkBuildResponse, JupiterError } from './client.ts';
import type { BuildParams, BuildResponse, JupiterClient } from './client.ts';

/**
 * Routes an agent brings from Jupiter itself, with its own API key: Orientim builds and checks the
 * protected swap around them exactly as around a route it asked for, and asks Jupiter nothing for
 * them. The agent's key never reaches Orientim.
 *
 * A route an agent brings is untrusted, as Jupiter's own answers are: the pipeline holds it to the
 * swap it answers (mints and amount), to the tolerance and quote its instruction carries, to the
 * verifier's rules and to two simulations. A route the agent made up harms only the agent's own
 * swap, and never lowers Orientim's fee: a fee on the input is a share of the amount in; a fee in SOL
 * is priced with Orientim's key, never from an agent's route; and a fee on the output, a share of
 * the minimum the route sets, is held to Orientim's own price (`PROVIDED_ROUTE_TOLERANCE_BPS`). What
 * cannot be checked is not taken on trust: Orientim builds the swap with its own key instead
 * (`RoutesUntrusted`).
 */

/**
 * How far below Orientim's own price the minimum of an agent's route may be, when Orientim's fee is
 * a share of that minimum: 1%, the cost a user is asked about (0.5%) and a few seconds of the
 * market's movement between the agent's quote and Orientim's. Further below, the route is not used
 * and Orientim builds the swap with its own key: the fee never rests on a price only the agent gave.
 */
export const PROVIDED_ROUTE_TOLERANCE_BPS = 100n;

/** One Jupiter build, as text: what Orientim asks for, and what an agent fetches and sends back. */
export type RouteRequest = {
  inputMint: string;
  outputMint: string;
  /** Base units, as a decimal string. */
  amount: string;
  taker: string;
  slippageBps: number;
  maxAccounts: number;
  mode?: 'fast';
  destinationTokenAccount?: string;
  excludeDexes?: string[];
};

/** A route an agent brings: Jupiter's answer for `params`, or `noRoute` when Jupiter found none. */
export type ProvidedRoute = { params: RouteRequest; response?: unknown; noRoute?: boolean };

/** The most routes one request may bring; each round of a prepare asks for a few at most. */
export const MAX_PROVIDED_ROUTES = 24;

/** Thrown when the pipeline needs a route the agent has not brought: the requests it needs. */
export class RoutesNeeded extends Error {
  readonly requests: RouteRequest[];
  constructor(requests: RouteRequest[]) {
    super(`Orientim needs ${requests.length} more route(s) from Jupiter to build this swap.`);
    this.name = 'RoutesNeeded';
    this.requests = requests;
  }
}

/**
 * The agent's routes cannot be held to what Orientim must check (its fee on the output, or a DEX the
 * swap excludes): the API builds the swap with Orientim's own key instead.
 */
export class RoutesUntrusted extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RoutesUntrusted';
  }
}

export function routeRequestOf(p: BuildParams): RouteRequest {
  return {
    inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount.toString(), taker: p.taker,
    slippageBps: p.slippageBps, maxAccounts: p.maxAccounts,
    ...(p.mode ? { mode: p.mode } : {}),
    ...(p.destinationTokenAccount ? { destinationTokenAccount: p.destinationTokenAccount } : {}),
    ...(p.excludeDexes?.length ? { excludeDexes: [...p.excludeDexes] } : {}),
  };
}

/** The same build, written one way only: the key a route is found by. */
export function routeKey(r: RouteRequest): string {
  return JSON.stringify([
    r.inputMint, r.outputMint, r.amount, r.taker, r.slippageBps, r.maxAccounts, r.mode ?? '', r.destinationTokenAccount ?? '',
    [...(r.excludeDexes ?? [])].sort(),
  ]);
}

/** `r` as a route request, or null: every field checked, nothing else kept. */
export function parseRouteRequest(r: unknown): RouteRequest | null {
  const x = r as Partial<Record<keyof RouteRequest, unknown>> | null;
  if (!x || typeof x !== 'object') return null;
  const address = (v: unknown) => typeof v === 'string' && isAddress(v);
  if (!address(x.inputMint) || !address(x.outputMint) || !address(x.taker)) return null;
  if (typeof x.amount !== 'string' || !/^\d{1,20}$/.test(x.amount) || BigInt(x.amount) <= 0n) return null;
  if (!Number.isInteger(x.slippageBps) || (x.slippageBps as number) < 1 || (x.slippageBps as number) > 10_000) return null;
  if (!Number.isInteger(x.maxAccounts) || (x.maxAccounts as number) < 1 || (x.maxAccounts as number) > 256) return null;
  if (x.mode !== undefined && x.mode !== 'fast') return null;
  if (x.destinationTokenAccount !== undefined && !address(x.destinationTokenAccount)) return null;
  if (x.excludeDexes !== undefined && !(Array.isArray(x.excludeDexes) && x.excludeDexes.length <= 64
    && x.excludeDexes.every(d => typeof d === 'string' && d.length > 0 && d.length <= 64))) return null;
  return {
    inputMint: x.inputMint as string, outputMint: x.outputMint as string, amount: x.amount, taker: x.taker as string,
    slippageBps: x.slippageBps as number, maxAccounts: x.maxAccounts as number,
    ...(x.mode ? { mode: 'fast' as const } : {}),
    ...(x.destinationTokenAccount ? { destinationTokenAccount: x.destinationTokenAccount as string } : {}),
    ...(x.excludeDexes && (x.excludeDexes as string[]).length ? { excludeDexes: [...(x.excludeDexes as string[])] } : {}),
  };
}

/**
 * The routes an agent brought, or a refusal in words: at most MAX_PROVIDED_ROUTES, each a request
 * and either Jupiter's answer (checked as Orientim checks its own) or `noRoute`.
 */
export function parseProvidedRoutes(v: unknown): { routes: ProvidedRoute[] } | { error: string } {
  if (!Array.isArray(v)) return { error: 'routes must be an array.' };
  if (v.length > MAX_PROVIDED_ROUTES) return { error: `routes may hold at most ${MAX_PROVIDED_ROUTES} routes.` };
  const routes: ProvidedRoute[] = [];
  for (const [i, entry] of v.entries()) {
    const e = entry as { params?: unknown; response?: unknown; noRoute?: unknown } | null;
    const params = parseRouteRequest(e?.params);
    if (!params) return { error: `routes[${i}].params is not a route request Orientim made.` };
    if (e?.noRoute === true) {
      routes.push({ params, noRoute: true });
      continue;
    }
    try {
      routes.push({ params, response: checkBuildResponse(e?.response) });
    } catch {
      return { error: `routes[${i}].response is not a Jupiter build answer.` };
    }
  }
  return { routes };
}

/**
 * A Jupiter client that answers from the routes an agent brought. A build it has no route for is
 * recorded and stops the build with `RoutesNeeded`, which the API turns into the list the agent
 * fetches next. A route through a DEX the build excluded is refused, by the programs its instruction
 * names (an agent's route plan is its own text, so its labels are not taken). Program labels come
 * from Orientim's own Jupiter client, never from the agent.
 */
export function providedRoutes(routes: readonly ProvidedRoute[], own: Pick<JupiterClient, 'programLabels'>): JupiterClient & { missing: RouteRequest[] } {
  const byKey = new Map(routes.map(r => [routeKey(r.params), r]));
  const missing: RouteRequest[] = [];
  const missingKeys = new Set<string>();
  return {
    missing,
    async build(p) {
      const request = routeRequestOf(p);
      const key = routeKey(request);
      const found = byKey.get(key);
      if (!found) {
        if (!missingKeys.has(key)) {
          missingKeys.add(key);
          missing.push(request);
        }
        throw new RoutesNeeded(missing);
      }
      if (found.noRoute) throw new JupiterError('Jupiter 400: No routes found (as the agent was told)', 400);
      const r = found.response as BuildResponse;
      if (p.excludeDexes?.length) {
        // Without Orientim's labels, or with a DEX they do not name, an excluded DEX could not be told
        // from any other: never "nothing excluded", the swap is built with Orientim's key, where
        // Jupiter itself leaves the DEX out.
        const labels = await own.programLabels().catch(() => null);
        const known = new Set(Object.values(labels ?? {}));
        if (!labels || p.excludeDexes.some(label => !known.has(label))) {
          throw new RoutesUntrusted(`Orientim cannot tell ${p.excludeDexes.join(', ')} by its programs now`);
        }
        const programs = new Set<string>([r.swapInstruction.programId, ...r.swapInstruction.accounts.map(a => a.pubkey)]);
        const through = [...programs].map(a => labels[a]).find(label => label && p.excludeDexes!.includes(label));
        if (through) throw new JupiterError(`Jupiter 400: the route goes through ${through}, which this build excludes`, 400);
      }
      return r;
    },
    async searchTokens() {
      throw new JupiterError('Token search is not part of a route an agent brings', 400);
    },
    programLabels: () => own.programLabels(),
  };
}

/** Orientim asked for this route request: the same mints and the taker the session named. */
export function requestFor(r: RouteRequest, swap: { inputMint: Address; outputMint: Address; taker: Address }): boolean {
  return r.inputMint === swap.inputMint && r.outputMint === swap.outputMint && r.taker === swap.taker;
}
