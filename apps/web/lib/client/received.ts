/**
 * What actually arrived, read from the confirmed transaction (review BR-03). The quote is what
 * Jupiter expected; this is what the chain recorded, and it is what the page reports and keeps.
 */
export type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };

export type ConfirmedMeta = {
  fee: bigint | number;
  preBalances: readonly (bigint | number)[];
  postBalances: readonly (bigint | number)[];
  preTokenBalances?: readonly TokenBalance[] | null;
  postTokenBalances?: readonly TokenBalance[] | null;
};

/**
 * A token output: the wallet's balance of that token after the transaction, less before it (a new
 * account starts at zero). A SOL output: the wallet's lamports after, less before, plus what the
 * transaction itself cost the wallet (the network fee and a market's account fee). The temporary
 * accounts' deposits come back in the same transaction and cancel out. Null when the transaction
 * does not show it.
 */
export function receivedFromMeta(
  meta: ConfirmedMeta,
  swap: { owner: string; outputMint: string; solOutput: boolean; routeRent: bigint; routeRefund?: bigint },
): bigint | null {
  if (swap.solOutput) {
    const before = meta.preBalances[0];
    const after = meta.postBalances[0];
    if (before === undefined || after === undefined) return null;
    // The market's account fee went out and most of it came back (FA-05): neither is swap output.
    // A Orientim fee taken from the output also left the wallet: what is counted is what it kept.
    return BigInt(after) - BigInt(before) + BigInt(meta.fee) + swap.routeRent - (swap.routeRefund ?? 0n);
  }
  const mine = (list: readonly TokenBalance[] | null | undefined) =>
    (list ?? []).filter(b => b.mint === swap.outputMint && b.owner === swap.owner);
  const after = mine(meta.postTokenBalances);
  if (!after.length) return null;
  const before = new Map(mine(meta.preTokenBalances).map(b => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]));
  return after.reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount) - (before.get(b.accountIndex) ?? 0n), 0n);
}

/**
 * How what arrived compares with what the quote expected (`expected`, net of a fee taken from the
 * output). Said when it is better, or when it is well below the quote but within the tolerance the
 * person set, so that a fill near the minimum reads as the tolerance at work. Empty otherwise.
 */
export function fillAgainstQuote(received: bigint, expected: bigint, tolerance: string): string {
  if (expected <= 0n) return '';
  const bps = Number(((received - expected) * 10_000n) / expected);
  const pct = (b: number) => `${(Math.abs(b) / 100).toFixed(Math.abs(b) < 100 ? 2 : 1)}%`;
  if (bps >= 5) return `${pct(bps)} better than quoted.`;
  if (bps <= -100 && tolerance) return `Filled ${pct(bps)} below the quote, within your ${tolerance} tolerance.`;
  return '';
}
