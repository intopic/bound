import {
  address, assertIsFullySignedTransaction, decompileTransactionMessage, getBase64Decoder,
  getCompiledTransactionMessageDecoder, isSolanaError, partiallySignTransaction,
  SOLANA_ERROR__TRANSACTION__TOO_MANY_ACCOUNT_ADDRESSES,
} from '@solana/kit';
import type { Address, KeyPairSigner, Transaction } from '@solana/kit';
import {
  ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS, ATA_PROGRAM, buildPolicy, compileProtectedSwap, LEGACY_SIZE_LIMIT,
  MAX_COMPUTE_UNITS, TOKEN_2022_ACCOUNT_SIZE, TOKEN_2022_PROGRAM, TOKEN_ACCOUNT_RENT_UPPER_BOUND_LAMPORTS,
  TOKEN_ACCOUNT_SIZE, TOKEN_PROGRAM, tokenAmountOf,
  V1_MAX_ACCOUNTS, V1_SIZE_LIMIT, variantOf, withMinOut, WSOL_MINT, ataOf,
} from '@bound/core';
import type { BoundConfig, IntermediateAta, Lifetime, Policy, TxVersion, Violation } from '@bound/core';
import { fetchAccounts, fetchSnapshot, isInfrastructureProgram, mintInfoOf, sendAndConfirm, simulate } from '@bound/solana';
import { certify, hasTransferFee, memoRequired, transferFeeOf, transferFeeOn, unsupportedExtension, verifyWalletReturn } from '@bound/verifier';
import type { Certificate } from '@bound/verifier';
import type { SendResult, SendStatus, SolanaRpc } from '@bound/solana';
import { JupiterError, toKitInstruction } from './client.ts';
import type { ApiInstruction, BuildResponse, JupiterClient } from './client.ts';

export type SwapSettings = BoundConfig & {
  /** DEXes that charge the taker persistent rent (D13). */
  excludeDexes: readonly string[];
  slippageBps: number;
  /**
   * How far below the unrestricted route a protected one may sit (D15). Under `askAboveBps` the
   * swap proceeds; between the two the user is told the difference and decides; above
   * `badQuoteBps` the quote is treated as broken and refused without asking, because at that
   * distance the likely cause is a broken or manipulated answer, not the cost of protection.
   */
  askAboveBps: bigint;
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
  askAboveBps: 100n,
  badQuoteBps: 500n,
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
  /**
   * How much worse than the unrestricted market price the user has agreed the protected route may
   * be, in bps. Without it, a route more than `askAboveBps` below the market stops with
   * `costs-more` and the page asks.
   */
  acceptedCostBps?: bigint;
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
  quote: {
    inAmount: bigint; outAmount: bigint; minOut: bigint; route: string[]; priceImpactPct: number; baselineOut: bigint;
    /** How far below the unrestricted route this one sits, in bps: the cost of the protection. */
    gapBps: bigint;
  };
  /** Rent this transaction moves out of W beyond the network fee, to show before signing (audit B-09, C-09). */
  oneTimeCosts: { outputAccountRent: bigint };
  /** The network fee of this exact message, as the cluster prices it (audit B-12). */
  networkFeeLamports: bigint;
  /** Side effects the user should be told about before signing. */
  notices: { removesDelegate: boolean };
  /**
   * A tax the input token itself charges on every transfer, and what Bound's extra hop costs
   * because of it. The money goes to whoever the mint's fee authority is, never to Bound.
   */
  tokenTax: { inputBps: number; extraOnInput: bigint } | null;
  /** Temporary ATA(E, m) accounts the route uses; each is created and closed in the transaction. */
  intermediates: IntermediateAta[];
  /** What the verified transaction does, bound to its exact bytes (idea 35). */
  certificate: Certificate;
  /** Wall-clock time of prepare, and the part spent computing locally (compile and verify). */
  timings: { totalMs: number; localMs: number };
  attempts: Attempt[];
};

export type BoundErrorCode =
  | 'unsupported-token' | 'token-data-mismatch' | 'output-account-restricted' | 'no-route' | 'bad-quote' | 'price-moved'
  | 'costs-more' | 'simulation-failed'
  | 'verification-failed' | 'wallet-changed-transaction' | 'expired';

/** For `price-moved`: what the market supports now, to show the user before asking again. */
export type PriceMoved = { newMinOut: bigint; newOutAmount: bigint };

/** For `costs-more`: how far the best protected route sits below the unrestricted one. */
export type CostsMore = { gapBps: bigint; outAmount: bigint; baselineOut: bigint };

export class BoundError extends Error {
  readonly code: BoundErrorCode;
  readonly violations: Violation[];
  readonly priceMoved: PriceMoved | null;
  readonly costsMore: CostsMore | null;
  constructor(
    code: BoundErrorCode,
    message: string,
    violations: Violation[] = [],
    priceMoved: PriceMoved | null = null,
    costsMore: CostsMore | null = null,
  ) {
    super(message);
    this.code = code;
    this.violations = violations;
    this.priceMoved = priceMoved;
    this.costsMore = costsMore;
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

/**
 * Why the routes failed, in the words the simulation used. Without this a failure says only that
 * something went wrong, which helps neither the user nor whoever reads the report afterwards.
 */
const why = (attempts: readonly Attempt[]) =>
  attempts.length
    ? `Tried: ${attempts.slice(-3).map(a => `${a.route.join(' + ') || 'no route'} (${a.simulation})`).join('; ')}.`
    : '';

/** A bps gap as a percentage, for a message a person reads: 137n → "1.37%". */
const percent = (bps: bigint | null) => (bps === null ? 'far' : `${(Number(bps) / 100).toFixed(2)}%`);

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
  // Which token program owns a mint decides its associated-account address, and that is only known
  // once the mint is read, so both candidates are asked for together.
  const variant = variantOf(req.inputMint, req.outputMint);
  const bothPrograms = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM];
  const feeCandidates = settings.treasury && req.inputMint !== WSOL_MINT
    ? await Promise.all(bothPrograms.map(tp => ataOf(settings.treasury!, req.inputMint, tp)))
    : [];
  const wOutCandidates = variant === 'A' ? [] : await Promise.all(bothPrograms.map(tp => ataOf(req.owner, req.outputMint, tp)));
  // From the cluster, since it changed in 2026 (audit C-09). If the RPC cannot answer, the
  // pre-2026 value is shown, which is an upper bound.
  const rentFor = (size: number) => rpc.getMinimumBalanceForRentExemption(BigInt(size)).send()
    .then(BigInt)
    .catch(() => TOKEN_ACCOUNT_RENT_UPPER_BOUND_LAMPORTS);
  const [firstReads, classicRent, extendedRent] = await Promise.all([
    fetchAccounts(rpc, [req.inputMint, req.outputMint, ...feeCandidates, ...wOutCandidates]),
    wOutCandidates.length ? rentFor(TOKEN_ACCOUNT_SIZE) : Promise.resolve(0n),
    wOutCandidates.length ? rentFor(TOKEN_2022_ACCOUNT_SIZE) : Promise.resolve(0n),
  ]);
  const mints = new Map([req.inputMint, req.outputMint].map(m => [m, mintInfoOf(firstReads.get(m))]));

  // R7 up front, so a token we cannot isolate is refused before anything is quoted or built.
  for (const m of [req.inputMint, req.outputMint]) {
    const info = mints.get(m)!;
    if (!info.exists || (info.program !== TOKEN_PROGRAM && info.program !== TOKEN_2022_PROGRAM)) {
      throw new BoundError('unsupported-token', `${m} is not a token Bound can swap.`);
    }
    if (info.program === TOKEN_2022_PROGRAM) {
      // The same rule the verifier applies, with the same exception: the swap's own mints may
      // charge a transfer fee, because their temporary account is harvested before it is closed.
      const bad = unsupportedExtension(firstReads.get(m)!.data, { allowTransferFee: true });
      if (bad) throw new BoundError('unsupported-token', `This token uses ${bad}, which a protected swap cannot isolate.`);
    }
  }
  // A mint with the transfer-fee extension keeps a cut of every transfer, and which of its two fee
  // settings applies depends on the epoch. The epoch is read only for such a mint, and a swap is
  // never built on a guess: without it the tax cannot be priced.
  const inputTaxes = mints.get(req.inputMint)!.program === TOKEN_2022_PROGRAM
    && hasTransferFee(firstReads.get(req.inputMint)!.data);
  const epoch = inputTaxes
    ? await rpc.getEpochInfo({ commitment: 'confirmed' }).send().then(e => BigInt(e.epoch)).catch(() => null)
    : 0n;
  if (epoch === null) {
    throw new BoundError(
      'token-data-mismatch',
      "Bound could not read the epoch that decides this token's transfer fee, so the amount could not be priced. Nothing was built; try again in a moment.",
    );
  }
  const inputFee = inputTaxes ? transferFeeOf(firstReads.get(req.inputMint)!.data, epoch) : null;
  const inputTokenProgram = mints.get(req.inputMint)!.program!;
  const outputTokenProgram = mints.get(req.outputMint)!.program!;
  const feeAccount = feeCandidates.length ? await ataOf(settings.treasury!, req.inputMint, inputTokenProgram) : null;
  const wOutAddress = wOutCandidates.length ? await ataOf(req.owner, req.outputMint, outputTokenProgram) : null;
  const newAccountRent = !wOutAddress ? 0n : outputTokenProgram === TOKEN_PROGRAM ? classicRent : extendedRent;
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
    inputTokenProgram,
    outputTokenProgram,
    // The extension itself, not this epoch's rate: an account that has ever received the token
    // may hold withheld fees, and the cleanup must harvest them whatever the rate is today.
    inputTransferFee: inputTaxes,
    config: settings,
    feeAccountExists,
  });

  // The token keeps a cut of every transfer, including ours into the temporary account, so the
  // route must be quoted for what actually lands there.
  const taxOnInput = inputFee ? transferFeeOn(policy.swapAmount, inputFee) : 0n;
  const arriving = policy.swapAmount - taxOnInput;
  if (arriving <= 0n) throw new BoundError('unsupported-token', 'The token keeps the whole amount as a transfer fee at this size.');

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
    if (state && memoRequired(state.data)) {
      throw new BoundError(
        'output-account-restricted',
        'Your account for the output token requires a memo on every incoming transfer, which a swap cannot provide.',
      );
    }
    // The trusted Revoke also removes a delegate the user set up on purpose: say so (review, B-03).
    removesDelegate = !!view && view.getUint32(72, true) === 1;
    wOutBefore = { exists: !!state, balance: tokenAmountOf(state?.data) };
  }

  const buildBase = {
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    amount: arriving,
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
    r.inputMint === req.inputMint && r.outputMint === req.outputMint && BigInt(r.inAmount) === arriving;
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

  // A hop through a mint that taxes transfers leaves withheld fees in the temporary account, which
  // then cannot be closed; the compiler harvests those, so it has to know which mints tax.
  const taxing = new Map<string, boolean>([[req.inputMint, inputTaxes]]);
  const withTransferFees = async (list: IntermediateAta[]): Promise<IntermediateAta[]> => {
    const unknown = [...new Set(list.map(x => x.mint).filter(m => !taxing.has(m)))];
    if (unknown.length) {
      const states = await fetchAccounts(rpc, unknown);
      for (const m of unknown) {
        const state = states.get(m);
        taxing.set(m, !!state && state.owner === TOKEN_2022_PROGRAM && hasTransferFee(state.data));
      }
    }
    return list.map(x => ({ ...x, transferFee: taxing.get(x.mint) ?? false }));
  };

  for (let attempt = 0; attempt < settings.maxRepairAttempts; attempt++) {
    const excluded = [...settings.excludeDexes, ...learned];
    const lifetime = await (attempt === 0 ? firstLifetimeTask : latestLifetime(rpc));

    let chosen: { r: BuildResponse; intermediates: IntermediateAta[] } | null = null;
    let chosenGapBps = 0n;
    let sawBadQuote = false;
    // A route priced right but too big for one transaction is the usual outcome for a large
    // amount: Solana allows 64 accounts per transaction, and Bound's own instructions need a
    // dozen of them. That is a different failure from a broken quote, and it is reported as such.
    let sawTooBig = false;
    /** How far the best route offered was below the unrestricted price, in bps. */
    let bestGapBps: bigint | null = null;
    for (const [level, maxAccounts] of MAX_ACCOUNTS_LEVELS.entries()) {
      const r = attempt === 0 && level === 0 ? await firstRouteTask : await buildOrNull(maxAccounts, excluded);
      if (!r) continue;
      if (!answersThisRequest(r)) { sawBadQuote = true; continue; }
      const out = BigInt(r.outAmount);
      const gap = baselineOut > 0n ? ((baselineOut - out) * 10_000n) / baselineOut : 0n;
      if (bestGapBps === null || gap < bestGapBps) bestGapBps = gap;
      if (gap > settings.badQuoteBps) { sawBadQuote = true; continue; }
      if (BigInt(r.otherAmountThreshold) <= 0n) continue; // no floor to enforce
      const intermediates = await withTransferFees(intermediatesFromSetup(r.setupInstructions, policy));
      const c = timed(() => compileIfFits(() => compile(r, lifetime, intermediates, MAX_COMPUTE_UNITS)));
      if (c && fits(c.size, c.staticAccounts, req.version)) { chosen = { r, intermediates }; chosenGapBps = gap; break; }
      sawTooBig = true;
    }
    // The levels run from the widest route to the narrowest, so the first one that fits is the best
    // price available to a protected swap. When it costs noticeably more than the unrestricted
    // market, that is the price of the guarantee, and the user decides rather than Bound.
    if (chosen && chosenGapBps > settings.askAboveBps) {
      const accepted = req.acceptedCostBps;
      // A little slack, or a market that drifts by a few bps would ask again and again.
      if (accepted === undefined || chosenGapBps > accepted + 50n) {
        throw new BoundError(
          'costs-more',
          `The protected route for this swap is ${percent(chosenGapBps)} below the best price on the market: it has to fit in one transaction, and Bound leaves out pools that would leave an account behind.`,
          [], null,
          { gapBps: chosenGapBps, outAmount: BigInt(chosen.r.outAmount), baselineOut },
        );
      }
    }
    // The best route that fits cannot deliver what the user accepted: ask, never lower it silently.
    if (chosen && BigInt(chosen.r.outAmount) < accepted) throw priceMoved(chosen.r);
    if (!chosen) {
      // After a repair, the routes we could still use are the ones nothing has blamed yet. If none
      // of them works, the honest reason is the simulations that got us here, not the price.
      if (learned.length) {
        throw new BoundError(
          'simulation-failed',
          `Every route that fits failed in simulation, and what is left is far below the market price. No funds were moved. ${why(attempts)}`,
        );
      }
      throw sawTooBig
        ? new BoundError('no-route', 'The best route for this amount does not fit in a single protected transaction. Try a smaller amount, or split the swap.')
        : sawBadQuote
          ? new BoundError('bad-quote', `The best protected route for this amount is ${percent(bestGapBps)} below the best price on the market, which is more than Bound accepts. Try a smaller amount, or again in a moment.`)
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
        tokenTax: inputFee ? { inputBps: inputFee.bps, extraOnInput: taxOnInput } : null,
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
          gapBps: chosenGapBps,
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
  throw new BoundError('simulation-failed', `Every route failed in simulation. No funds were moved. ${why(attempts)}`);
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
