/**
 * The page and the pipeline must ask for a price on the same amount. A token that taxes its own
 * transfers keeps a cut of the transfer into the protected account, and the audit found the page
 * quoting the amount before that cut while the pipeline quoted the amount after it — so the first
 * number a user saw was higher than the one they could actually get.
 */
import { address } from '@solana/kit';
import { ataOf, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '@bound/core';
import { describe, expect, it } from 'vitest';
import { amountReachingRoute, currentTransferFee, mintAta, tokenWarnings } from '../lib/client/tokens';

describe('the selected mint decides its ATA program', () => {
  const owner = address('GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE');
  const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  it('derives distinct classic and Token-2022 accounts from on-chain mint facts', async () => {
    const classic = await mintAta(owner, mint, { program: TOKEN_PROGRAM });
    const token2022 = await mintAta(owner, mint, { program: TOKEN_2022_PROGRAM });
    expect(classic).toBe(await ataOf(owner, address(mint), TOKEN_PROGRAM));
    expect(token2022).toBe(await ataOf(owner, address(mint), TOKEN_2022_PROGRAM));
    expect(token2022).not.toBe(classic);
  });
});

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

describe('token warnings come from the chain for a token Jupiter does not vouch for (review BR-11)', () => {
  const pasted = { id: 'x', symbol: 'ABCD…WXYZ', name: 'Not listed on Jupiter', decimals: 6, tokenProgram: TOKEN_PROGRAM, isVerified: false };
  const verified = { ...pasted, symbol: 'USDC', name: 'USD Coin', isVerified: true };

  it('a pasted mint with a freeze and a mint authority is warned about, though Jupiter has no audit for it', () => {
    const w = tokenWarnings(pasted, { freezeAuthority: true, mintAuthority: true });
    expect(w.some(x => x.includes('freeze authority'))).toBe(true);
    expect(w.some(x => x.includes('can still be minted'))).toBe(true);
  });

  it('a pasted mint with neither authority is warned only that it is not verified', () => {
    expect(tokenWarnings(pasted, { freezeAuthority: false, mintAuthority: false })).toHaveLength(1);
  });

  it("a verified token follows Jupiter's audit, so USDC's freeze authority is not a warning on every swap", () => {
    expect(tokenWarnings(verified, { freezeAuthority: true, mintAuthority: true })).toHaveLength(0);
  });
});

