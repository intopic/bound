import { describe, expect, it } from 'vitest';
import { chainSwapOf, entryOf, pilotReport } from '../../../tools/pilot-report.ts';
import type { ChainSwap, PilotEntry, ShownSwap } from '../../../tools/pilot-report.ts';

const TREASURY = 'ARzSA3sZGhf5t4UnYrmB3TWyZ5m3Wo1nA9zWBcoiTqLE';
const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const sig = (n: number) => `${'5'.repeat(80)}${String(n).padStart(8, '1')}`.slice(0, 88);

/** A sale of 100 USDC for SOL, its fee of 0.25 USDC taken on the input. */
const shown = (over: Partial<ShownSwap['amounts']> = {}): ShownSwap => ({
  wallet: WALLET,
  amounts: { amountIn: '100000000', fee: '250000', feeMint: USDC, minOut: '500000000', ...over },
  certificate: { input: { mint: USDC }, output: { mint: SOL } },
  policy: { takerRent: '0', routeRefund: '0' },
});
const entry = (n: number, over: Partial<PilotEntry> = {}): PilotEntry => ({ id: `order-${n}`, signature: sig(n), outcome: 'confirmed', prepared: shown(), ...over });
const honest: ChainSwap = { ok: true, blockTime: 1_800_000_000, treasuryGained: 250_000n, walletReceived: 600_000_000n };
const report = (entries: PilotEntry[], chain: (e: PilotEntry) => ChainSwap | null = () => honest, extra: { kept?: string[]; limits?: { maxAmountIn?: Record<string, string>; maxAmountInPerDay?: Record<string, string> } } = {}) =>
  pilotReport(entries, { chain: async e => chain(e), kept: new Set(extra.kept ?? []), treasury: TREASURY, ...(extra.limits ? { limits: extra.limits } : {}) });

describe('the pilot report', () => {
  it('passes swaps whose fee reached the treasury and whose wallet received at least its minimum', async () => {
    const r = await report([entry(1), entry(2)]);
    expect(r.failures).toEqual([]);
    expect(r.rows).toHaveLength(2);
  });

  it('fails a fee that did not reach the treasury as shown, and a wallet that received less than its minimum', async () => {
    const r = await report([entry(1), entry(2)], e => (e.signature === sig(1) ? { ...honest, treasuryGained: 100_000n } : { ...honest, walletReceived: 499_999_999n }));
    expect(r.failures.join('\n')).toMatch(/treasury gained 100000 .* fee of 250000/);
    expect(r.failures.join('\n')).toMatch(/received 499999999, below the minimum it was shown, 500000000/);
  });

  it('fails an order carried out twice, and a bot that says failed what the chain confirmed', async () => {
    const r = await report([entry(1), entry(2, { id: 'order-1' }), entry(3, { outcome: 'failed' })]);
    expect(r.failures.join('\n')).toMatch(/order order-1 was carried out 2 times/);
    expect(r.failures.join('\n')).toMatch(/says failed, the chain says it confirmed/);
  });

  it('fails an unknown outcome no state directory keeps, and notes one that is kept', async () => {
    const lost = await report([entry(1, { outcome: 'unknown' })], () => null);
    expect(lost.failures.join('\n')).toMatch(/no state directory keeps it for recovery/);
    const kept = await report([entry(1, { outcome: 'unknown' })], () => null, { kept: [sig(1)] });
    expect(kept.failures).toEqual([]);
    expect(kept.incomplete.join('\n')).toMatch(/kept for recovery .* run recover/);
  });

  it("fails a wallet above the owner's limits, in one swap and within 24 hours", async () => {
    const one = await report([entry(1)], undefined, { limits: { maxAmountIn: { [USDC]: '50000000' } } });
    expect(one.failures.join('\n')).toMatch(/in one swap, above the owner's 50000000/);
    const day = await report([entry(1), entry(2), entry(3)], e => ({ ...honest, blockTime: 1_800_000_000 + Number(e.signature.slice(-1)) * 3_600 }), { limits: { maxAmountInPerDay: { [USDC]: '250000000' } } });
    expect(day.failures.join('\n')).toMatch(/300000000 of .* within 24 hours, above the owner's 250000000/);
  });

  it("reads a protectedSwap result with its id, and orientim-verify's finalize beside prepare's checked", () => {
    expect(entryOf({ id: 'a', signature: sig(1), outcome: 'confirmed', prepared: shown() })?.id).toBe('a');
    expect(entryOf({ checked: { prepared: shown(), intent: { id: 'b' } }, signature: sig(2), outcome: 'unknown' })?.id).toBe('b');
    expect(entryOf({ signature: sig(3), outcome: 'confirmed' })).toBeNull();
  });

  it('reads the treasury and the wallet from the transaction: a fee in USDC, SOL received with the network fee added back', async () => {
    const rpc = {
      getTransaction: () => ({
        send: async () => ({
          blockTime: 1_800_000_000,
          transaction: { message: { accountKeys: [WALLET, TREASURY] } },
          meta: {
            err: null, fee: 5_000, preBalances: [1_000_000_000, 10], postBalances: [1_599_995_000, 10],
            preTokenBalances: [{ accountIndex: 3, mint: USDC, owner: TREASURY, uiTokenAmount: { amount: '1000' } }],
            postTokenBalances: [{ accountIndex: 3, mint: USDC, owner: TREASURY, uiTokenAmount: { amount: '251000' } }],
          },
        }),
      }),
    };
    const got = await chainSwapOf(rpc as never, entry(1), TREASURY);
    expect(got).toEqual({ ok: true, blockTime: 1_800_000_000, treasuryGained: 250_000n, walletReceived: 600_000_000n });
  });
});
