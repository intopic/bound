/**
 * Jupiter is untrusted, including the shape of its answers: a malformed quote must fail as a
 * JupiterError, not as a crash further down the pipeline (review, answer to question 7).
 */
import { describe, expect, it } from 'vitest';
import { address } from '@solana/kit';
import { checkBuildResponse, createJupiterClient, JupiterError } from '../src/client.ts';

const good = {
  inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  outputMint: 'So11111111111111111111111111111111111111112',
  inAmount: '100000000',
  outAmount: '450000000',
  otherAmountThreshold: '447750000',
  routePlan: [{ percent: 100, swapInfo: { label: 'Whirlpool', ammKey: 'x' } }],
  computeBudgetInstructions: [],
  setupInstructions: [],
  swapInstruction: { programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', accounts: [], data: '' },
  cleanupInstruction: null,
  otherInstructions: [],
  addressesByLookupTableAddress: null,
};

describe('Jupiter /build responses are validated', () => {
  it('a well-formed quote passes unchanged', () => {
    expect(checkBuildResponse(good)).toBe(good);
  });

  const bad: [string, unknown][] = [
    ['a non-numeric amount', { ...good, outAmount: '4.5e8' }],
    ['a negative floor', { ...good, otherAmountThreshold: '-1' }],
    ['a missing floor', { ...good, otherAmountThreshold: undefined }],
    ['a missing swap instruction', { ...good, swapInstruction: undefined }],
    ['a swap instruction without accounts', { ...good, swapInstruction: { ...good.swapInstruction, accounts: null } }],
    ['no route plan', { ...good, routePlan: null }],
    ['a body that is not an object', 'oops'],
  ];
  for (const [name, body] of bad) {
    it(`${name} is refused with a JupiterError`, () => {
      expect(() => checkBuildResponse(body)).toThrow(JupiterError);
    });
  }

  it('the client applies the check to every /build answer', async () => {
    const client = createJupiterClient({
      buildUrl: 'https://jupiter.test/build',
      tokensUrl: 'https://jupiter.test/tokens',
      labelsUrl: 'https://jupiter.test/labels',
      fetchImpl: (async () => new Response(JSON.stringify({ ...good, inAmount: 'abc' }))) as unknown as typeof fetch,
    });
    await expect(
      client.build({
        inputMint: address(good.inputMint), outputMint: address(good.outputMint), amount: 100_000_000n,
        taker: address('11111111111111111111111111111111'), slippageBps: 50, maxAccounts: 64,
      }),
    ).rejects.toThrow('malformed quote');
  });
});
