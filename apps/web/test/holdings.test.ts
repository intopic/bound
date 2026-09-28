import { describe, expect, it } from 'vitest';
import type { TokenInfo } from '@orientim/jupiter';
import { mergeHoldings, rankHoldings } from '../lib/client/holdings';
import { SOL_MINT, TOKEN_PROGRAM } from '../lib/client/tokens';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SPAM = 'Spam1111111111111111111111111111111111111111';
const UNLISTED = 'Unl1sted11111111111111111111111111111111111';
const RICH = 'Rich1111111111111111111111111111111111111111';

const info = (id: string, symbol: string, usdPrice: number | undefined, isVerified: boolean): TokenInfo =>
  ({ id, symbol, name: symbol, decimals: 6, tokenProgram: TOKEN_PROGRAM, isVerified, usdPrice });
const held = (mint: string, amount: bigint, decimals = 6) => ({ mint, program: TOKEN_PROGRAM, amount, decimals });

describe("the wallet's tokens in the token window", () => {
  it('adds up a mint held in more than one account and drops empty ones', () => {
    expect(mergeHoldings([held(USDC, 1n), held(USDC, 2n), held(BONK, 0n)])).toEqual([held(USDC, 3n)]);
  });

  it('lists the most valuable first, and keeps unverified dust and unlisted tokens hidden', () => {
    const { shown, hidden } = rankHoldings(
      [held(SOL_MINT, 1_000_000_000n, 9), held(USDC, 5_000_000n), held(BONK, 10_000_000n), held(SPAM, 1_000_000_000n), held(UNLISTED, 7n), held(RICH, 2_000_000n)],
      [
        { ...info(SOL_MINT, 'SOL', 150, true), decimals: 9 }, info(USDC, 'USDC', 1, true), info(BONK, 'BONK', 0.00002, true),
        info(SPAM, 'FREE', 0.0000001, false), info(RICH, 'RICH', 3, false),
      ],
    );
    expect(shown.map(o => o.token.symbol)).toEqual(['SOL', 'RICH', 'USDC', 'BONK']);
    expect(shown[0].usd).toBeCloseTo(150);
    expect(hidden.map(o => o.token.id)).toEqual([SPAM, UNLISTED]);
    expect(hidden[1].usd).toBeNull();
    expect(hidden[1].token.isVerified).toBe(false);
  });
});
