import { describe, expect, it } from 'vitest';
import { costsMoreThan, keptByMarket } from '../lib/client/rebuild.ts';

const swap = (routeRent: bigint, routeRefund: bigint, extra: { tax?: bigint; removesDelegate?: boolean } = {}) => ({
  oneTimeCosts: { routeRent, routeRefund },
  tokenTax: extra.tax === undefined ? null : { extraOnInput: extra.tax },
  notices: { removesDelegate: extra.removesDelegate ?? false },
});

describe('a swap built again after a question (engineering review M-06)', () => {
  it('the same rent with its refund lost costs more: the user is asked again', () => {
    const accepted = swap(1_346_200n, 1_346_200n);
    const rebuilt = swap(1_346_200n, 0n);
    expect(keptByMarket(accepted)).toBe(0n);
    expect(costsMoreThan(rebuilt, accepted)).toBe(true);
  });

  it('a higher rent that comes back in full costs nothing more', () => {
    expect(costsMoreThan(swap(2_000_000n, 2_000_000n), swap(1_346_200n, 1_346_200n))).toBe(false);
  });

  it('the same costs are not asked about twice', () => {
    expect(costsMoreThan(swap(1_346_200n, 1_000_000n), swap(1_346_200n, 1_000_000n))).toBe(false);
  });

  it('a fee in SOL that is new, or more than 2% higher, costs more (engineering audit S1-M-02)', () => {
    const withSolFee = (fee: bigint) => ({ ...swap(0n, 0n), policy: { feeSide: 'sol', fee } });
    expect(costsMoreThan(withSolFee(100_000n), swap(0n, 0n))).toBe(true);
    expect(costsMoreThan(withSolFee(103_000n), withSolFee(100_000n))).toBe(true);
    expect(costsMoreThan(withSolFee(101_000n), withSolFee(100_000n))).toBe(false);
    expect(costsMoreThan({ ...swap(0n, 0n), policy: { feeSide: 'input', fee: 500n } }, swap(0n, 0n))).toBe(false);
  });

  it('a larger transfer tax, or a delegate removal not mentioned before, costs more', () => {
    expect(costsMoreThan(swap(0n, 0n, { tax: 10n }), swap(0n, 0n, { tax: 5n }))).toBe(true);
    expect(costsMoreThan(swap(0n, 0n, { removesDelegate: true }), swap(0n, 0n))).toBe(true);
  });
});
