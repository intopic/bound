import {
  address, assertIsFullySignedTransaction, decompileTransactionMessage, getBase64Decoder,
  getCompiledTransactionMessageDecoder, isSolanaError, partiallySignTransaction,
  SOLANA_ERROR__TRANSACTION__TOO_MANY_ACCOUNT_ADDRESSES,
} from '@solana/kit';
import type { Address, KeyPairSigner, Transaction } from '@solana/kit';
import {
  ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS, ATA_PROGRAM, buildPolicy, compileProtectedSwap, LEGACY_SIZE_LIMIT,
  MAX_COMPUTE_UNITS, TOKEN_ACCOUNT_RENT_UPPER_BOUND_LAMPORTS, TOKEN_ACCOUNT_SIZE, TOKEN_PROGRAM, tokenAmountOf,
  V1_MAX_ACCOUNTS, V1_SIZE_LIMIT, variantOf, withMinOut, WSOL_MINT, ataOf,
} from '@bound/core';
import type { BoundConfig, IntermediateAta, Lifetime, Policy, TxVersion, Violation } from '@bound/core';
import { fetchAccounts, fetchSnapshot, isInfrastructureProgram, mintInfoOf, sendAndConfirm, simulate } from '@bound/solana';
import { certify, verifyWalletReturn } from '@bound/verifier';
import type { Certificate } from '@bound/verifier';
import type { SendResult, SendStatus, SolanaRpc } from '@bound/solana';
import { JupiterError, toKitInstruction } from './client.ts';
import type { ApiInstruction, BuildResponse, JupiterClient } from './client.ts';

export type SwapSettings = BoundConfig & {
  /** DEXes that charge the taker persistent rent (D13). */
  excludeDexes: readonly string[];
  slippageBps: number;
  /** Quotes this many bps below the unrestricted route are treated as broken (D15). */
  badQuoteBps: bigint;
  maxRepairAttempts: number;
  /** v0 priority price; v1 uses `priorityFeeLamports`. */
  microLamportsPerComputeUnit: bigint;
  priorityFeeLamports: bigint;
};

export const DEFAULT_SETTINGS: Omit<SwapSettings, 'treasury' | 'jupiterProgram'> = {
  feeBps: 50n,
  maxNetworkFeeLamports: 200_000n,
  excludeDexes: ['HumidiFi', 'Pump.fun Amm'],
  slippageBps: 50,
  badQuoteBps: 100n,
  maxRepairAttempts: 4,
  microLamportsPerComputeUnit: 50_000n,
  priorityFeeLamports: 10_000n,
};

const MAX_ACCOUNTS_LEVELS = [64, 56, 48, 40, 32, 24, 16];

export type SwapRequest = {
  owner: Address;
  ephemeral: KeyPairSigner;
  inputMint: Address;
  outputMint: Address;
  /** Base units of the input token, as the user accepted them. */
  amountIn: bigint;
  /**
   * The decimals the interface used to turn what the user typed into `amountIn` and to show
   * amounts. They must equal the mints' on-chain decimals, or nothing is built (audit C-01).
   */
  inputDecimals: number;
  outputDecimals: number;
  /**
   * The minimum the user saw and accepted before clicking (audit C-02). Bound enforces at least
   * this on chain. When the market no longer supports it, nothing is built: prepare stops with
   * `price-moved` and the new minimum, and the user decides.
   */
  acceptedMinOut?: bigint;
  version: TxVersion;
};

export type Attempt = { excluded: string[]; route: string[]; simulation: 'ok' | string; blamed: string | null };

export type PreparedSwap = {
  policy: Policy;
  version: TxVersion;
  transaction: Transaction;
  lifetime: Lifetime;
  size: number;
  computeUnits: number;
  /** `minOut` is enforced by Bound's own check after the swap (audit B-04), not only by Jupiter. */
  quote: { inAmount: bigint; outAmount: bigint; minOut: bigint; route: string[]; priceImpactPct: number; baselineOut: bigint };
  /** Rent this transaction moves out of W beyond the network fee, to show before signing (audit B-09, C-09). */
  oneTimeCosts: { outputAccountRent: bigint };
  /** The network fee of this exact message, as the cluster prices it (audit B-12). */
  networkFeeLamports: bigint;
  /** Side effects the user should be told about before signing. */
  notices: { removesDelegate: boolean };
  /** Temporary ATA(E, m) accounts the route uses; each is created and closed in the transaction. */
  intermediates: IntermediateAta[];
  /** What the verified transaction does, bound to its exact bytes (idea 35). */
  certificate: Certificate;
  /** Wall-clock time of prepare, and the part spent computing locally (compile and verify). */
  timings: { totalMs: number; localMs: number };
  attempts: Attempt[];
};

export type BoundErrorCode =
  | 'unsupported-token' | 'token-data-mismatch' | 'output-account-restricted' | 'no-route' | 'bad-quote' | 'price-moved' | 'simulation-failed'
  | 'verification-failed' | 'wallet-changed-transaction' | 'expired';

/** For `price-moved`: what the market supports now, to show the user before asking again. */
export type PriceMoved = { newMinOut: bigint; newOutAmount: bigint };

export class BoundError extends Error {
  readonly code: BoundErrorCode;
  readonly violations: Violation[];
  readonly priceMoved: PriceMoved | null;
  constructor(code: BoundErrorCode, message: string, violations: Violation[] = [], priceMoved: PriceMoved | null = null) {
    super(message);
    this.code = code;
    this.violations = violations;
    this.priceMoved = priceMoved;
  }
}

/**
 * Jupiter's setup instructions show which ATA(E, m) the route expects to exist. We never run
 * Jupiter's setup (its payer is E, who holds no SOL); we recreate these ATAs ourselves (D14).
 */
export function intermediatesFromSetup(setup: readonly ApiInstruction[], policy: Policy): IntermediateAta[] {
  const ours = new Set<string>([policy.accounts.eIn, policy.accounts.eOut ?? '']);
  const out: IntermediateAta[] = [];
  for (const ix of setup) {
    if (ix.programId !== ATA_PROGRAM || ix.accounts.length < 6) continue;
    const [, ata, owner, mint, , tokenProgram] = ix.accounts.map(a => a.pubkey);
    if (owner !== policy.ephemeral || ours.has(ata) || out.some(x => x.ata === ata)) continue;
    out.push({ ata: address(ata), mint: address(mint), tokenProgram: address(tokenProgram) });
  }
  return out;
}

/**
 * The minimum Bound enforces for a route (audit C-02): the quoted output less the slippage the user
 * accepted, computed here and rounded down. Jupiter's own threshold can only make it stricter, never
 * weaker, so an answer with a tiny `otherAmountThreshold` cannot lower the floor.
 */
export function minimumOutput(outAmount: bigint, slippageBps: number): bigint {
  return (outAmount * BigInt(10_000 - slippageBps)) / 10_000n;
}

export function routeFloor(r: Pick<BuildResponse, 'outAmount' | 'otherAmountThreshold'>, slippageBps: number): bigint {
  const local = minimumOutput(BigInt(r.outAmount), slippageBps);
  const quoted = BigInt(r.otherAmountThreshold);
  return quoted > local ? quoted : local;
}

/** Did the simulation fail at Bound's own minimum-output check (a self-TransferChecked)? */
function failedAtFloorCheck(tx: Transaction, index: number | null, lookups: Record<string, string[]> | null): boolean {
  if (index === null) return false;
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const msg = decompileTransactionMessage(compiled as never, { addressesByLookupTableAddress: (lookups ?? {}) as never });
    const ix = msg.instructions[index] as { programAddress: string; data?: ArrayLike<number>; accounts?: { address: string }[] };
    return ix?.programAddress === TOKEN_PROGRAM && ix.data?.[0] === 12 && !!ix.accounts && ix.accounts[0].address === ix.accounts[2].address;
  } catch {
    return false;
  }
}

/**
 * A route whose accounts together with Bound's exceed the 64-account limit cannot be compiled at
 * all; like a route that is too large, it simply does not fit, and a smaller one is requested.
 */
export function compileIfFits<T>(build: () => T): T | null {
  try {
    return build();
  } catch (e) {
    if (isSolanaError(e, SOLANA_ERROR__TRANSACTION__TOO_MANY_ACCOUNT_ADDRESSES)) return null;
    throw e;
  }
}

const fits = (size: number, staticAccounts: number, version: TxVersion) =>
  version === 1 ? size <= V1_SIZE_LIMIT && staticAccounts <= V1_MAX_ACCOUNTS : size <= LEGACY_SIZE_LIMIT;

async function latestLifetime(rpc: SolanaRpc): Promise<Lifetime> {
  const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  return value;
}

/**
 * Builds, simulates and verifies a protected swap (plan, sections 4–6). The returned transaction
 * has passed all 7 rules and is ready for the wallet to sign first.
 */
export async function prepareProtectedSwap(deps: {
  rpc: SolanaRpc;
  secondaryRpc?: SolanaRpc;
  jupiter: JupiterClient;
  settings: SwapSettings;
}, req: SwapRequest): Promise<PreparedSwap> {
  const { rpc, jupiter, settings } = deps;
  const E = req.ephemeral.address;
  const started = performance.now();
  let localMs = 0;
  const timed = <T>(work: () => T): T => {
    const t = performance.now();
    try {
      return work();
    } finally {
      localMs += performance.now() - t;
    }
  };

  // Everything the first decisions need, in one round trip (idea 21): both mints, the treasury's
  // account for the input token and W_out, with the rent for a new W_out asked at the same time.
  const feeAccount = settings.treasury && req.inputMint !== WSOL_MINT ? await ataOf(settings.treasury, req.inputMint) : null;
  const wOutAddress = variantOf(req.inputMint, req.outputMint) === 'A' ? null : await ataOf(req.owner, req.outputMint);
  const [firstReads, newAccountRent] = await Promise.all([
    fetchAccounts(rpc, [req.inputMint, req.outputMint, ...(feeAccount ? [feeAccount] : []), ...(wOutAddress ? [wOutAddress] : [])]),
    // From the cluster, since it changed in 2026 (audit C-09). If the RPC cannot answer, the
    // pre-2026 value is shown, which is an upper bound.
    wOutAddress
      ? rpc.getMinimumBalanceForRentExemption(BigInt(TOKEN_ACCOUNT_SIZE)).send().then(BigInt).catch(() => TOKEN_ACCOUNT_RENT_UPPER_BOUND_LAMPORTS)
      : Promise.resolve(0n),
  ]);
  const mints = new Map([req.inputMint, req.outputMint].map(m => [m, mintInfoOf(firstReads.get(m))]));

  // R7 up front: classic SPL tokens and SOL only (D5).
  for (const m of [req.inputMint, req.outputMint]) {
    const info = mints.get(m)!;
    if (!info.exists || info.program !== TOKEN_PROGRAM) {
      throw new BoundError('unsupported-token', `${m} is not a classic SPL token. Token-2022 tokens are not supported yet.`);
    }
  }
  // The amount the user typed was converted with `inputDecimals`; if the chain disagrees, the
  // wallet would be asked for a different amount than the one shown (audit C-01).
  for (const [m, shown] of [[req.inputMint, req.inputDecimals], [req.outputMint, req.outputDecimals]] as const) {
    if (mints.get(m)!.decimals !== shown) {
      throw new BoundError('token-data-mismatch', `The token data for ${m} does not match the chain. Nothing was built; reload and try again.`);
    }
  }

  const feeAccountExists = feeAccount ? !!firstReads.get(feeAccount) : true;
  const policy = await buildPolicy({
    intent: { owner: req.owner, inputMint: req.inputMint, outputMint: req.outputMint, amountIn: req.amountIn },
    ephemeral: E,
    inputDecimals: mints.get(req.inputMint)!.decimals,
    outputDecimals: mints.get(req.outputMint)!.decimals,
    config: settings,
    feeAccountExists,
  });

  // W_out is the only account of W the swap sees. A delegate is revoked in the transaction, but a
  // close authority cannot be, so such an account is refused up front (audit B-03).
  let wOutBefore: { exists: boolean; balance: bigint } = { exists: false, balance: 0n };
  let removesDelegate = false;
  if (policy.accounts.wOut) {
    const state = firstReads.get(policy.accounts.wOut);
    const view = state && state.data.length >= TOKEN_ACCOUNT_SIZE ? new DataView(state.data.buffer, state.data.byteOffset) : null;
    if (view && view.getUint32(129, true) === 1) {
      throw new BoundError(
        'output-account-restricted',
        'Your account for the output token has a close authority set, so Bound will not send the output there.',
      );
    }
    // The trusted Revoke also removes a delegate the user set up on purpose: say so (review, B-03).
    removesDelegate = !!view && view.getUint32(72, true) === 1;
    wOutBefore = { exists: !!state, balance: tokenAmountOf(state?.data) };
  }

  const buildBase = {
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    amount: policy.swapAmount,
    taker: E,
    slippageBps: settings.slippageBps,
    destinationTokenAccount: policy.accounts.wOut ?? undefined,
  };
  // Individual quotes fail transiently ("pool has not been updated", "zero tradable amount"):
  // retry the baseline once and skip a failing maxAccounts level instead of giving up.
  const buildOrNull = async (maxAccounts: number, excludeDexes?: readonly string[]) => {
    try {
      return await jupiter.build({ ...buildBase, maxAccounts, excludeDexes });
    } catch (e) {
      if (e instanceof JupiterError && e.status < 500) return null;
      throw e;
    }
  };
  // Jupiter is untrusted: an answer for another pair or another amount is not a quote for this
  // swap (audit C-02).
  const answersThisRequest = (r: BuildResponse) =>
    r.inputMint === req.inputMint && r.outputMint === req.outputMint && BigInt(r.inAmount) === policy.swapAmount;
  // The unrestricted baseline, the first protected route, the blockhash and the DEX labels do not
  // depend on each other: ask for them at the same time (idea 21).
  // Jupiter sometimes answers "No matching liquidity" for a pair it quotes a second later: retry
  // once after a pause, then accept a smaller route as the baseline before giving up.
  const baselineTask = (async () => {
    for (const [i, maxAccounts] of [64, 64, 48, 32].entries()) {
      if (i > 0) await new Promise(r => setTimeout(r, 700));
      const r = await buildOrNull(maxAccounts);
      if (r) return r;
    }
    return null;
  })();
  const firstRouteTask = buildOrNull(MAX_ACCOUNTS_LEVELS[0], settings.excludeDexes);
  const firstLifetimeTask = latestLifetime(rpc);
  const labelsTask = jupiter.programLabels().catch(() => ({} as Record<string, string>));
  // Settled early so that a failure the loop never waits for is not an unhandled rejection.
  firstRouteTask.catch(() => undefined);
  firstLifetimeTask.catch(() => undefined);
  const baseline = await baselineTask;
  if (!baseline) throw new BoundError('no-route', 'Jupiter could not quote this pair right now. Try again in a moment.');
  if (!answersThisRequest(baseline)) throw new BoundError('bad-quote', 'Jupiter answered for a different trade. Nothing was built.');
  const baselineOut = BigInt(baseline.outAmount);
  const labels = await labelsTask;

  const learned: string[] = [];
  const attempts: Attempt[] = [];
  let floorMisses = 0;
  // Bound computes each route's floor itself and enforces it on chain, never below what the user
  // accepted (audit B-04, C-02).
  const accepted = req.acceptedMinOut ?? 0n;
  const floorOf = (r: BuildResponse) => {
    const floor = routeFloor(r, settings.slippageBps);
    return floor > accepted ? floor : accepted;
  };
  const policyFor = (r: BuildResponse) => withMinOut(policy, floorOf(r));
  const priceMoved = (r: BuildResponse) =>
    new BoundError('price-moved', 'The price moved beyond the slippage tolerance since you looked. Nothing was signed.', [], {
      newMinOut: routeFloor(r, settings.slippageBps),
      newOutAmount: BigInt(r.outAmount),
    });
  const compile = (
    r: BuildResponse, lifetime: Lifetime, intermediates: IntermediateAta[], computeUnitLimit: number,
    outputBalanceBefore = wOutBefore.balance,
  ) =>
    compileProtectedSwap({
      policy: policyFor(r),
      outputBalanceBefore,
      swapInstruction: toKitInstruction(r.swapInstruction),
      intermediates,
      version: req.version,
      lifetime,
      computeUnitLimit,
      microLamportsPerComputeUnit: settings.microLamportsPerComputeUnit,
      priorityFeeLamports: settings.priorityFeeLamports,
      lookupTables: req.version === 0 ? (r.addressesByLookupTableAddress ?? undefined) as never : undefined,
    });

  for (let attempt = 0; attempt < settings.maxRepairAttempts; attempt++) {
    const excluded = [...settings.excludeDexes, ...learned];
    const lifetime = await (attempt === 0 ? firstLifetimeTask : latestLifetime(rpc));

    let chosen: { r: BuildResponse; intermediates: IntermediateAta[] } | null = null;
    let sawBadQuote = false;
    for (const [level, maxAccounts] of MAX_ACCOUNTS_LEVELS.entries()) {
      const r = attempt === 0 && level === 0 ? await firstRouteTask : await buildOrNull(maxAccounts, excluded);
      if (!r) continue;
      if (!answersThisRequest(r)) { sawBadQuote = true; continue; }
      const out = BigInt(r.outAmount);
      if (out * 10_000n < baselineOut * (10_000n - settings.badQuoteBps)) { sawBadQuote = true; continue; }
      if (BigInt(r.otherAmountThreshold) <= 0n) continue; // no floor to enforce
      const intermediates = intermediatesFromSetup(r.setupInstructions, policy);
      const c = timed(() => compileIfFits(() => compile(r, lifetime, intermediates, MAX_COMPUTE_UNITS)));
      if (c && fits(c.size, c.staticAccounts, req.version)) { chosen = { r, intermediates }; break; }
    }
    // The best route that fits cannot deliver what the user accepted: ask, never lower it silently.
    if (chosen && BigInt(chosen.r.outAmount) < accepted) throw priceMoved(chosen.r);
    if (!chosen) {
      throw sawBadQuote
        ? new BoundError('bad-quote', 'Jupiter only returned quotes far below the best price. Try again in a moment.')
        : new BoundError('no-route', 'No route fits in a single protected transaction. Try a different amount or token.');
    }

    const route = chosen.r.routePlan.map(p => p.swapInfo.label);
    const trial = timed(() => compile(chosen.r, lifetime, chosen.intermediates, MAX_COMPUTE_UNITS));
    const sim = await simulate(rpc, trial.transaction);
    attempts.push({ excluded, route, simulation: sim.ok ? 'ok' : sim.error ?? 'failed', blamed: sim.blame ? labels[sim.blame] ?? sim.blame : null });

    if (sim.ok) {
      const chosenPolicy = policyFor(chosen.r);
      const swapAccounts = chosen.r.swapInstruction.accounts.map(a => address(a.pubkey));
      // The snapshot for the verifier and the fresh blockhash, together (idea 21).
      const [snapshot, finalLifetime] = await Promise.all([
        fetchSnapshot({
          rpc,
          secondaryRpc: deps.secondaryRpc,
          addresses: [
            ...swapAccounts, E, policy.accounts.eIn, ...(policy.accounts.eOut ? [policy.accounts.eOut] : []),
            // W_out explicitly, not only when Jupiter happens to list it (audit B-03).
            ...(policy.accounts.wOut ? [policy.accounts.wOut] : []),
            ...chosen.intermediates.flatMap(x => [x.ata, x.mint]), req.inputMint, req.outputMint,
          ],
          lookupTableAddresses: req.version === 0 ? Object.keys(chosen.r.addressesByLookupTableAddress ?? {}).map(a => address(a)) : [],
        }),
        latestLifetime(rpc),
      ]);

      // Final build with a tight compute budget, a fresh blockhash, and W_out's balance as the
      // verifier will read it from the same snapshot.
      const units = Math.min(MAX_COMPUTE_UNITS, Math.ceil(sim.units * 1.3) + 20_000);
      const outputBalanceBefore = policy.accounts.wOut ? tokenAmountOf(snapshot.accounts.get(policy.accounts.wOut)?.data) : 0n;
      const final = timed(() => compile(chosen.r, finalLifetime, chosen.intermediates, units, outputBalanceBefore));

      // Verified and certified in one step: the certificate exists only if every rule held.
      const verifyStarted = performance.now();
      const certification = await certify(final.transaction, chosenPolicy, snapshot);
      localMs += performance.now() - verifyStarted;
      const verdict = certification.ok ? { ok: true, violations: [] as Violation[] } : { ok: false, violations: certification.violations };
      // A route through a Token-2022 hop with a transfer hook or permanent delegate (B-10) is not
      // an error of the pair: exclude that route's DEXes and look for another one.
      if (!verdict.ok && verdict.violations.every(v => v.rule === 'R7' && v.detail.startsWith('intermediate mint'))) {
        attempts[attempts.length - 1].simulation = 'refused hop mint';
        const before = learned.length;
        for (const label of route) if (!excluded.includes(label)) learned.push(label);
        if (learned.length === before) break;
        continue;
      }
      if (!verdict.ok) {
        throw new BoundError('verification-failed', 'A protected transaction cannot be produced.', verdict.violations);
      }

      // The cluster prices the exact message (audit B-12). Fail closed: without a price there is
      // no proof that the fee stays under the limit, so nothing goes to the wallet.
      const feeLimit = chosenPolicy.maxNetworkFeeLamports < ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS
        ? chosenPolicy.maxNetworkFeeLamports
        : ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS;
      const priceMessage = () => rpc
        .getFeeForMessage(getBase64Decoder().decode(final.transaction.messageBytes) as never, { commitment: 'confirmed' })
        .send()
        .then(r => r.value)
        .catch(() => null);
      const clusterFee = (await priceMessage()) ?? (await priceMessage());
      if (clusterFee === null) {
        throw new BoundError('verification-failed', "The network fee couldn't be confirmed. Nothing was signed; try again.", [
          { rule: 'R4', detail: 'the cluster did not price the final message' },
        ]);
      }
      if (BigInt(clusterFee) > feeLimit) {
        throw new BoundError('verification-failed', 'The network fee would be above the limit.', [
          { rule: 'R4', detail: `the cluster prices this transaction at ${clusterFee} lamports, above ${feeLimit}` },
        ]);
      }

      const createsOutputAccount = !!policy.accounts.wOut && !snapshot.accounts.get(policy.accounts.wOut);
      if (!certification.ok) throw new BoundError('verification-failed', 'A protected transaction cannot be produced.', certification.violations);

      return {
        oneTimeCosts: { outputAccountRent: createsOutputAccount ? newAccountRent : 0n },
        certificate: certification.certificate,
        timings: { totalMs: Math.round(performance.now() - started), localMs: Math.round(localMs) },
        networkFeeLamports: BigInt(clusterFee),
        notices: { removesDelegate },
        intermediates: chosen.intermediates,
        policy: chosenPolicy,
        version: req.version,
        transaction: final.transaction,
        lifetime: finalLifetime,
        size: final.size,
        computeUnits: units,
        quote: {
          inAmount: BigInt(chosen.r.inAmount),
          outAmount: BigInt(chosen.r.outAmount),
          minOut: chosenPolicy.minOut,
          route,
          priceImpactPct: Number(chosen.r.priceImpactPct ?? 0),
          baselineOut,
        },
        attempts,
      };
    }

    // The swap delivered less than the floor, or W_out's balance moved since it was read (the
    // check is b0 + minOut). Both are transient: re-read W_out and requote, without blaming DEXes.
    if (failedAtFloorCheck(trial.transaction, sim.failedInstruction, chosen.r.addressesByLookupTableAddress)) {
      attempts[attempts.length - 1].simulation = 'output below the minimum';
      if (++floorMisses >= 2) {
        if (accepted > 0n) throw priceMoved(chosen.r);
        throw new BoundError('simulation-failed', 'The price moved beyond the slippage tolerance. No funds were moved; try again.');
      }
      if (policy.accounts.wOut) {
        const state = (await fetchAccounts(rpc, [policy.accounts.wOut])).get(policy.accounts.wOut);
        wOutBefore = { exists: !!state, balance: tokenAmountOf(state?.data) };
      }
      continue;
    }

    // Route repair (D15): exclude the DEX to blame; if our own cleanup failed, the route left
    // funds behind, so exclude every DEX on it.
    const before = learned.length;
    const blamedLabel = sim.blame && !isInfrastructureProgram(sim.blame) ? labels[sim.blame] : null;
    for (const label of blamedLabel ? [blamedLabel] : route) {
      if (!excluded.includes(label)) learned.push(label);
    }
    if (learned.length === before) break;
  }
  throw new BoundError('simulation-failed', 'Every route failed in simulation. No funds were moved.');
}

/**
 * The wallet has signed first. Check that it signed exactly the verified message, then E signs
 * last and the transaction is sent (D4). Without E's signature it can never execute.
 */
export async function finalizeProtectedSwap(args: {
  rpc: SolanaRpc;
  prepared: PreparedSwap;
  walletSignedBytes: Uint8Array;
  ephemeral: KeyPairSigner;
  onStatus?: (status: SendStatus, signature: string) => void;
}): Promise<SendResult> {
  const { rpc, prepared, ephemeral } = args;
  const check = await verifyWalletReturn(prepared.transaction, args.walletSignedBytes, prepared.policy.owner, ephemeral.address);
  if (!check.ok || !check.transaction) {
    throw new BoundError('wallet-changed-transaction', 'The wallet changed the transaction, so it was stopped for your safety.', check.violations);
  }
  const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
  if (height > prepared.lifetime.lastValidBlockHeight) {
    throw new BoundError('expired', 'The transaction expired before it was signed. Build it again.');
  }
  const signed = await partiallySignTransaction([ephemeral.keyPair], check.transaction);
  assertIsFullySignedTransaction(signed);
  return sendAndConfirm({ rpc, transaction: signed, lastValidBlockHeight: prepared.lifetime.lastValidBlockHeight, onStatus: args.onStatus });
}
