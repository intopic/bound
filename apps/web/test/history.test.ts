import { describe, expect, it } from 'vitest';
import { settledHistoryStatus } from '../lib/client/history.ts';
import type { HistoryEntry } from '../lib/client/history.ts';

const entry = (lastValidBlockHeight?: string): HistoryEntry => ({
  at: 1,
  signature: 'signature',
  status: 'pending',
  lastValidBlockHeight,
  paid: '1 USDC',
  received: '1 SOL',
  exposed: '1 USDC',
});

describe('persisted swap settlement', () => {
  it('uses the signature status for confirmed and failed outcomes', () => {
    expect(settledHistoryStatus(entry('100'), { confirmationStatus: 'confirmed', err: null }, 50n)).toBe('confirmed');
    expect(settledHistoryStatus(entry('100'), { confirmationStatus: 'confirmed', err: { InstructionError: [] } }, 50n)).toBe('failed');
    // An error seen only at processed may be on a fork: not an outcome yet (review FA-07).
    expect(settledHistoryStatus(entry('100'), { confirmationStatus: 'processed', err: { InstructionError: [] } }, 50n)).toBeNull();
  });

  it('expires only after the recorded last valid block height', () => {
    expect(settledHistoryStatus(entry('100'), null, 100n)).toBeNull();
    expect(settledHistoryStatus(entry('100'), null, 101n)).toBe('expired');
  });

  it('keeps old, malformed and processed entries unknown', () => {
    expect(settledHistoryStatus(entry(), null, 1_000n)).toBeNull();
    expect(settledHistoryStatus(entry('not-a-height'), null, 1_000n)).toBeNull();
    expect(settledHistoryStatus(entry('100'), { confirmationStatus: 'processed', err: null }, 101n)).toBeNull();
    expect(settledHistoryStatus(entry('100'), null, null)).toBeNull();
  });
});
