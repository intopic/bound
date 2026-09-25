// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import {
  addHistory, historyWorks, HistoryNotSaved, lifetimeOver, readHistory, settledHistoryStatus, unsettledFor, updateHistory,
} from '../lib/client/history.ts';
import type { HistoryEntry } from '../lib/client/history.ts';

const entry = (lastValidBlockHeight?: string, more: Partial<HistoryEntry> = {}): HistoryEntry => ({
  at: 1,
  signature: 'signature',
  status: 'pending',
  lastValidBlockHeight,
  paid: '1 USDC',
  received: '1 SOL',
  exposed: '1 USDC',
  ...more,
});

/** A node's view: the finalized height it had reached, and 40 slots ahead of it, as a processed node is. */
const view = (covered: bigint | null, ahead = 40n) => ({ coveredHeight: covered, reachHeight: covered === null ? null : covered + ahead });

describe('persisted swap settlement', () => {
  it('uses the signature status for confirmed and failed outcomes', () => {
    expect(settledHistoryStatus(entry('100'), { confirmationStatus: 'confirmed', err: null }, view(50n))).toBe('confirmed');
    expect(settledHistoryStatus(entry('100'), { confirmationStatus: 'confirmed', err: { InstructionError: [] } }, view(50n))).toBe('failed');
    // An error seen only at processed may be on a fork: not an outcome yet (review FA-07).
    expect(settledHistoryStatus(entry('100'), { confirmationStatus: 'processed', err: { InstructionError: [] } }, view(50n))).toBeNull();
  });

  it('expires only after the recorded last valid block height', () => {
    expect(settledHistoryStatus(entry('1000'), null, view(1_000n))).toBeNull();
    expect(settledHistoryStatus(entry('1000'), null, view(1_001n))).toBe('expired');
  });

  it('keeps old, malformed and processed entries unknown', () => {
    expect(settledHistoryStatus(entry(), null, view(1_000n))).toBeNull();
    expect(settledHistoryStatus(entry('not-a-height'), null, view(1_000n))).toBeNull();
    expect(settledHistoryStatus(entry('100'), { confirmationStatus: 'processed', err: null }, view(101n))).toBeNull();
    expect(settledHistoryStatus(entry('100'), null, view(null))).toBeNull();
  });
});

describe('"no record" proves nothing once the node may have forgotten (third audit, F1)', () => {
  // The page's blockhash: the swap could land in blocks 851 to 1,000. A node's status cache holds its
  // last 300 blocks, so from about 1,120 on "no record" may only mean a pruned history.
  it('a visit right after the lifetime proves expiry; a later one does not', () => {
    expect(settledHistoryStatus(entry('1000'), null, view(1_020n))).toBe('expired');
    expect(settledHistoryStatus(entry('1000'), null, view(1_100n))).toBeNull();
    expect(settledHistoryStatus(entry('1000'), null, view(100_000n))).toBeNull();
  });

  it('a node far ahead of the finalized view (another node, perhaps) proves nothing either', () => {
    expect(settledHistoryStatus(entry('1000'), null, view(1_020n, 5_000n))).toBeNull();
  });

  it('a swap past its lifetime is marked over, so the user may set it aside once they looked it up', () => {
    expect(lifetimeOver(entry('1000'), view(1_000n))).toBe(false);
    expect(lifetimeOver(entry('1000'), view(100_000n))).toBe(true);
    expect(lifetimeOver(entry(), view(100_000n), 1_000)).toBe(false);
  });

  it('an entry that does not name its last block can be set aside once no transaction could still live', () => {
    const old = entry(undefined, { at: 0 });
    expect(lifetimeOver(old, view(null), 60_000)).toBe(false);
    expect(lifetimeOver(old, view(null), 16 * 60_000)).toBe(true);
    expect(lifetimeOver(entry('not-a-height', { at: 0 }), view(1n), 16 * 60_000)).toBe(true);
  });
});

/** A localStorage that can be made to refuse writes, as blocked or full site storage does. */
function fakeStorage() {
  const data = new Map<string, string>();
  const state = { refuse: false };
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (state.refuse) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k: string) => { data.delete(k); },
  };
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return state;
}

describe('a swap is sent only once its record is kept (third audit, F3)', () => {
  afterEach(() => { delete (globalThis as { window?: unknown }).window; });

  it('a browser that will not keep the record is told before the wallet opens, and the send stops', () => {
    const storage = fakeStorage();
    expect(historyWorks()).toBe(true);
    storage.refuse = true;
    expect(historyWorks()).toBe(false);
    expect(() => addHistory(entry('1000', { signature: 'a' }))).toThrow(HistoryNotSaved);
  });

  it('kept, it reads back', () => {
    fakeStorage();
    addHistory(entry('1000', { signature: 'a' }));
    expect(readHistory().map(h => h.signature)).toEqual(['a']);
  });

  it('an unsettled swap is never dropped to make room: only settled ones are', () => {
    fakeStorage();
    addHistory(entry('1000', { signature: 'open', at: 0 }));
    for (let i = 1; i <= 60; i++) addHistory(entry('1000', { signature: `done-${i}`, at: i, status: 'confirmed' }));
    const kept = readHistory();
    expect(kept).toHaveLength(50);
    expect(kept.some(h => h.signature === 'open')).toBe(true);
    expect(kept[0].signature).toBe('done-60');
  });
});

describe('a wallet with an unsettled swap starts no new one (third audit, F2)', () => {
  afterEach(() => { delete (globalThis as { window?: unknown }).window; });

  it("holds back only that wallet's swaps, and an older entry without a wallet holds back every wallet", () => {
    const list = [entry('1000', { signature: 'a', owner: 'W1' }), entry('1000', { signature: 'b', owner: 'W2', status: 'confirmed' })];
    expect(unsettledFor(list, 'W1').map(h => h.signature)).toEqual(['a']);
    expect(unsettledFor(list, 'W2')).toEqual([]);
    expect(unsettledFor([entry('1000', { signature: 'old' })], 'W2').map(h => h.signature)).toEqual(['old']);
  });

  it('set aside by the user once over, it no longer holds anything back', () => {
    fakeStorage();
    addHistory(entry('1000', { signature: 'a', owner: 'W1' }));
    updateHistory('a', 'unknown', undefined, { over: true });
    expect(unsettledFor(readHistory(), 'W1')).toHaveLength(1);
    updateHistory('a', 'checked');
    expect(unsettledFor(readHistory(), 'W1')).toEqual([]);
  });
});
