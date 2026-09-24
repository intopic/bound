/**
 * A swap built again after a question (its blockhash ran low while the user read it) is asked about
 * again only if it costs more than the one the user just accepted.
 */
type Costs = {
  oneTimeCosts: { routeRent: bigint; routeRefund: bigint };
  tokenTax?: { extraOnInput: bigint } | null;
  notices: { removesDelegate: boolean };
};

/** What the market keeps: the rent it takes, less what closing its account returns in the same transaction (FA-05). */
export const keptByMarket = (p: Costs) => p.oneTimeCosts.routeRent - p.oneTimeCosts.routeRefund;

/**
 * Does `next` cost more than `accepted`? The market's rent counts net of its refund, so a refund the
 * rebuild lost is a new cost even when the rent is the same (engineering review M-06); so are a
 * larger transfer tax and a delegate removal the user was not told about.
 */
export const costsMoreThan = (next: Costs, accepted: Costs) =>
  keptByMarket(next) > keptByMarket(accepted)
  || (next.tokenTax?.extraOnInput ?? 0n) > (accepted.tokenTax?.extraOnInput ?? 0n)
  || (next.notices.removesDelegate && !accepted.notices.removesDelegate);
