/**
 * The agent's own check of a prepared swap, before its wallet signs (review FA-01).
 *
 * Bound's server built the transaction; the agent must not take its word for what it does. This
 * runs Bound's full verifier (`@bound/verifier`, the same rules the page applies, R1–R7) on the exact
 * bytes, against chain state the agent reads from ITS OWN RPC, and against a policy the agent holds
 * to its own intent and limits. A compromised server, relay, DNS or impostor URL can then refuse or
 * delay a swap, never make the agent sign one that moves anything but the approved amount.
 *
 * Two things the rules alone cannot settle are settled here too (research audit). The price: the
 * agent must bring a floor of its own (`minOut`, from `ownMinimum` or its own source), or a server
 * could sell the amount for almost nothing through a pool it controls (F-02). And the one-time key:
 * the swap is simulated on the agent's RPC and must leave it with nothing, so no lamports stay
 * where a server that derives the key could collect them (F-06).
 *
 * Bundled into ../lib/bound-verify.mjs by tools/build-skill.ts (only @solana/kit stays external), so
 * the skill works on its own; CI rebuilds it and fails if the committed file differs.
 */
import { fetchAddressesForLookupTables, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { JUPITER_PROGRAM } from '@bound/core/constants';
import type { ChainSnapshot, Policy } from '@bound/core/types';
import { readAccounts } from '@bound/solana';
import { verify } from '@bound/verifier';

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

const BIGINT_FIELDS = ['minOut', 'takerRent', 'routeRefund', 'amountIn', 'feeBps', 'fee', 'swapAmount', 'maxNetworkFeeLamports'] as const;

function policyOf(json: Record<string, unknown>): Policy | null {
  try {
    const p: Record<string, unknown> = { ...json, accounts: { ...(json.accounts as object) } };
    for (const k of BIGINT_FIELDS) {
      if (typeof json[k] !== 'string' || !/^\d{1,20}$/.test(json[k] as string)) return null;
      p[k] = BigInt(json[k] as string);
    }
    return p as unknown as Policy;
  } catch {
    return null;
  }
}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');

/**
 * The problems found, or an empty list. Sign only when it is empty. `rpc` must be the agent's own
 * RPC, not one Bound provides: the check is worth what the chain state it reads is worth.
 */
export async function verifyPrepared(prepared: PreparedSwap, limits: AgentLimits, rpc: Rpc<SolanaRpcApi>): Promise<string[]> {
  const problems: string[] = [];
  let transaction;
  try {
    transaction = getTransactionDecoder().decode(Buffer.from(prepared.transaction, 'base64'));
  } catch {
    return ['the transaction cannot be decoded'];
  }
  const digest = hex(await crypto.subtle.digest('SHA-256', new Uint8Array(transaction.messageBytes)));
  if (digest !== prepared.messageSha256) problems.push('the message does not hash to messageSha256');

  // The policy comes from the server too, so every part of it that matters is held to the agent's
  // own intent and limits before the verifier uses it.
  const p = policyOf(prepared.policy);
  if (!p) return [...problems, 'the policy is malformed'];
  if (p.owner !== limits.owner) problems.push(`the policy is for wallet ${p.owner}, not yours`);
  if (p.inputMint !== limits.inputMint || p.outputMint !== limits.outputMint) problems.push('the policy is for other tokens');
  if (p.amountIn !== BigInt(limits.amountIn)) problems.push(`the policy debits ${p.amountIn}, not ${limits.amountIn}`);
  if (p.jupiterProgram !== JUPITER_PROGRAM) problems.push(`the swap program is ${p.jupiterProgram}, not Jupiter`);
  if (p.ephemeral !== prepared.temporaryAuthority) problems.push('the one-time key differs from the one stated');
  if (p.feeBps > BigInt(limits.maxFeeBps ?? 20)) problems.push(`the fee of ${p.feeBps} bps is above your limit`);
  if (limits.treasury && p.treasury !== null && p.treasury !== limits.treasury) problems.push(`the fee goes to ${p.treasury}, not Bound's treasury`);
  if (p.maxNetworkFeeLamports > BigInt(limits.maxNetworkFeeLamports ?? 1_000_000)) {
    problems.push(`the network fee may reach ${p.maxNetworkFeeLamports} lamports, above your limit`);
  }
  if (!/^\d{1,20}$/.test(limits.minOut ?? '') || BigInt(limits.minOut) === 0n) {
    problems.push('no minimum of your own: set minOut from a price you got yourself (ownMinimum asks Jupiter for one)');
  } else if (p.minOut < BigInt(limits.minOut)) {
    problems.push(`the minimum ${p.minOut} is below yours, ${limits.minOut}`);
  }

  // Chain state from the agent's own RPC: every account the message names, resolved through its
  // lookup tables, and the accounts the policy derives.
  let snapshot: ChainSnapshot;
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes) as unknown as {
      staticAccounts: Address[];
      addressTableLookups?: { lookupTableAddress: Address; writableIndexes: number[]; readonlyIndexes: number[] }[];
    };
    const lookups = compiled.addressTableLookups ?? [];
    const lookupTables: Record<string, readonly Address[]> = lookups.length
      ? await fetchAddressesForLookupTables(lookups.map(l => l.lookupTableAddress), rpc as never)
      : {};
    const resolved = lookups.flatMap(l =>
      [...l.writableIndexes, ...l.readonlyIndexes].map(i => lookupTables[l.lookupTableAddress]?.[i]).filter((a): a is Address => !!a));
    const derived = Object.values(p.accounts).filter((a): a is Address => !!a);
    const addresses = [
      ...compiled.staticAccounts, ...resolved, ...derived, p.inputMint, p.outputMint, p.ephemeral,
      ...(p.treasury ? [p.treasury] : []),
    ];
    const { accounts, slot } = await readAccounts(rpc as never, addresses);
    snapshot = { accounts, lookupTables, slot };
  } catch (e) {
    return [...problems, `the chain state could not be read from your RPC: ${(e as Error).message}`];
  }

  const verdict = await verify(transaction, p, snapshot);
  for (const v of verdict.violations) problems.push(`${v.rule}: ${v.detail}`);
  problems.push(...await leftUnderKey(prepared.transaction, p.ephemeral, rpc));
  return problems;
}

/**
 * What the one-time key holds after the swap, simulated on the agent's own RPC. Every lamport the
 * wallet sends it (a market's account rent) must be spent by the route or come back in the same
 * transaction; a server that stated more than the route needs, or a smaller refund, would otherwise
 * leave lamports under a key it can derive (research audit F-06).
 */
async function leftUnderKey(transaction: string, key: Address, rpc: Rpc<SolanaRpcApi>): Promise<string[]> {
  try {
    const { value } = await rpc
      .simulateTransaction(transaction as never, {
        encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
        accounts: { addresses: [key], encoding: 'base64' },
      })
      .send();
    if (value.err) return [`the swap fails in simulation on your RPC: ${JSON.stringify(value.err, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`];
    const after = (value as { accounts?: readonly ({ lamports: bigint | number } | null)[] | null }).accounts;
    const left = BigInt(after?.[0]?.lamports ?? 0);
    return left === 0n ? [] : [`the one-time key would keep ${left} lamports after the swap`];
  } catch (e) {
    return [`the swap could not be simulated on your RPC: ${(e as Error).message}`];
  }
}

/** The program of a Pump.fun bonding curve: a route through one is quoted at a wider tolerance. */
const PUMP_CURVE_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/**
 * A floor of the agent's own, from a price it asks Jupiter for itself (research audit F-02): the
 * output for the amount Bound will route (after its fee), less `maxBelowBps`. By default 2%, or 5%
 * when the route trades on a Pump.fun bonding curve, which Bound quotes at 3%: enough for Bound's
 * tolerance, its narrower routes and a few seconds of movement, and far from "almost nothing".
 * Without `apiKey`, Jupiter allows a request every two seconds.
 */
export async function ownMinimum(args: {
  inputMint: string; outputMint: string; amountIn: string; taker: string;
  maxFeeBps?: number; maxBelowBps?: number; jupiterUrl?: string; apiKey?: string; fetchImpl?: typeof fetch;
}): Promise<string> {
  const amount = BigInt(args.amountIn);
  const routed = amount - (amount * BigInt(args.maxFeeBps ?? 20)) / 10_000n;
  const url = new URL(args.jupiterUrl ?? 'https://api.jup.ag/swap/v2/build');
  const query = {
    inputMint: args.inputMint, outputMint: args.outputMint, amount: routed.toString(), taker: args.taker, slippageBps: '50', maxAccounts: '64',
  };
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await (args.fetchImpl ?? fetch)(url.toString(), { headers: args.apiKey ? { 'x-api-key': args.apiKey } : {} });
  if (!res.ok) throw new Error(`Jupiter answered ${res.status} when asked for your own price`);
  const r = (await res.json()) as {
    inputMint?: string; outputMint?: string; inAmount?: string; outAmount?: string; swapInstruction?: { accounts?: { pubkey: string }[] };
  };
  if (r.inputMint !== args.inputMint || r.outputMint !== args.outputMint || r.inAmount !== routed.toString() || !/^\d{1,20}$/.test(r.outAmount ?? '')) {
    throw new Error('Jupiter answered for another trade when asked for your own price');
  }
  const curve = r.swapInstruction?.accounts?.some(a => a.pubkey === PUMP_CURVE_PROGRAM) ?? false;
  const below = BigInt(args.maxBelowBps ?? (curve ? 500 : 200));
  return ((BigInt(r.outAmount!) * (10_000n - below)) / 10_000n).toString();
}
