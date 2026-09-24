import { describe, expect, it } from 'vitest';
import { minimumForReceived, outputFeeFor } from '../src/index.ts';

/** What the wallet keeps of a minimum, after a fee from the output. */
const keeps = (gross: bigint, feeBps: bigint) => gross - outputFeeFor(gross, feeBps);

describe('the minimum that keeps what the user accepted (engineering review L-10)', () => {
  it('one unit kept at 0.2% needs a minimum of one: its fee rounds down to nothing', () => {
    expect(minimumForReceived(1n, 20n)).toBe(1n);
  });

  it('is the least minimum that keeps at least the amount, for every amount and fee tried', () => {
    const wrong: string[] = [];
    for (const feeBps of [0n, 1n, 20n, 50n, 100n, 999n]) {
      for (let received = 0n; received <= 20_000n; received++) {
        const gross = minimumForReceived(received, feeBps);
        if (keeps(gross, feeBps) < received || (gross > 0n && keeps(gross - 1n, feeBps) >= received)) wrong.push(`${received} at ${feeBps} bps`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('holds for amounts far larger than a test can count through', () => {
    for (const received of [995_000_000n, 10n ** 15n + 7n, 2n ** 63n]) {
      const gross = minimumForReceived(received, 20n);
      expect(keeps(gross, 20n)).toBeGreaterThanOrEqual(received);
      expect(keeps(gross - 1n, 20n)).toBeLessThan(received);
    }
  });
});
