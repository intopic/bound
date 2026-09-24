import { describe, expect, it } from 'vitest';
import { receivedFromMeta } from '../lib/client/received.ts';

const W = 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const balance = (accountIndex: number, owner: string, amount: string) =>
  ({ accountIndex, mint: BONK, owner, uiTokenAmount: { amount } });

describe('what actually arrived (review BR-03)', () => {
  it('a token output: the wallet account after, less before', () => {
    const meta = {
      fee: 15_000n, preBalances: [], postBalances: [],
      preTokenBalances: [balance(3, W, '1000')],
      postTokenBalances: [balance(3, W, '51000'), balance(5, 'someone else', '9')],
    };
    expect(receivedFromMeta(meta, { owner: W, outputMint: BONK, solOutput: false, routeRent: 0n })).toBe(50_000n);
  });

  it('a token output into a new account starts from zero', () => {
    const meta = { fee: 15_000n, preBalances: [], postBalances: [], preTokenBalances: [], postTokenBalances: [balance(3, W, '42')] };
    expect(receivedFromMeta(meta, { owner: W, outputMint: BONK, solOutput: false, routeRent: 0n })).toBe(42n);
  });

  it("a SOL output: the wallet's lamports after, less before, plus the network fee and the market's account fee", () => {
    // Received 49,500,000; paid 20,000 in fees and 1,346,200 to the market; deposits came back.
    const meta = { fee: 20_000n, preBalances: [100_000_000n], postBalances: [100_000_000n + 49_500_000n - 20_000n - 1_346_200n] };
    expect(receivedFromMeta(meta, { owner: W, outputMint: 'So11111111111111111111111111111111111111112', solOutput: true, routeRent: 1_346_200n }))
      .toBe(49_500_000n);
  });

  it("the part of the market's account fee that came back is not swap output (FA-05)", () => {
    // Received 49,500,000; paid 1,478,280 to the market, of which 1,346,200 came back.
    const meta = { fee: 20_000n, preBalances: [100_000_000n], postBalances: [100_000_000n + 49_500_000n - 20_000n - 1_478_280n + 1_346_200n] };
    expect(receivedFromMeta(meta, {
      owner: W, outputMint: 'So11111111111111111111111111111111111111112', solOutput: true, routeRent: 1_478_280n, routeRefund: 1_346_200n,
    })).toBe(49_500_000n);
  });

  it('unknown when the transaction does not show the account', () => {
    const meta = { fee: 5_000n, preBalances: [], postBalances: [], postTokenBalances: [] };
    expect(receivedFromMeta(meta, { owner: W, outputMint: BONK, solOutput: false, routeRent: 0n })).toBeNull();
  });
});
