/**
 * The page and the pipeline must ask for a price on the same amount. A token that taxes its own
 * transfers keeps a cut of the transfer into the protected account, and the audit found the page
 * quoting the amount before that cut while the pipeline quoted the amount after it — so the first
 * number a user saw was higher than the one they could actually get.
 */
import { describe, expect, it } from 'vitest';
import { amountReachingRoute, currentTransferFee } from '../lib/client/tokens';

describe('the amount a quote is asked for', () => {
  it('is the whole amount for a token that charges nothing', () => {
    expect(amountReachingRoute(1_000_000n, { transferFee: null })).toBe(1_000_000n);
    expect(amountReachingRoute(1_000_000n, null)).toBe(1_000_000n);
    expect(amountReachingRoute(1_000_000n, undefined)).toBe(1_000_000n);
  });

  it('leaves out the tax the token keeps, rounded the way the token program rounds it', () => {
    const fee = { bps: 300, maximum: 2n ** 63n };
    expect(amountReachingRoute(1_000_000n, { transferFee: fee })).toBe(970_000n);
    // 3% of 101 is 3.03, and the token program rounds a fee up.
    expect(amountReachingRoute(101n, { transferFee: fee })).toBe(97n);
  });

  it('respects the cap a mint puts on its fee', () => {
    const fee = { bps: 300, maximum: 5n };
    expect(amountReachingRoute(1_000_000n, { transferFee: fee })).toBe(999_995n);
  });
});

describe('the active Token-2022 transfer fee', () => {
  const taxingMint = () => {
    const data = new Uint8Array(166 + 4 + 108);
    data[165] = 1; // AccountType::Mint
    new DataView(data.buffer).setUint16(166, 1, true); // TransferFeeConfig
    new DataView(data.buffer).setUint16(168, 108, true);
    return data;
  };

  it('does not need an epoch for a mint without the extension', async () => {
    let reads = 0;
    expect(await currentTransferFee(new Uint8Array(82), async () => { reads++; return 10n; })).toBeNull();
    expect(reads).toBe(0);
  });

  it('fails closed instead of pricing a taxing mint with epoch zero', async () => {
    await expect(currentTransferFee(taxingMint(), async () => { throw new Error('RPC unavailable'); }))
      .rejects.toThrow('RPC unavailable');
  });
});
