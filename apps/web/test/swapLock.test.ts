import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireSwapLock } from '../lib/client/swapLock.ts';

/** localStorage as a browser tab sees it; two locks in one test stand for two tabs. */
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
}

describe('the swap lock outlives a wallet left open (review BR-02)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal('window', { localStorage: memoryStorage() });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a second tab is refused while the first is still in its wallet, past the first period', () => {
    const first = acquireSwapLock('W', 'MINT');
    expect(first).not.toBeNull();
    vi.setSystemTime(170_000);
    first!.refresh(); // the wallet opens
    vi.setSystemTime(300_000);
    expect(acquireSwapLock('W', 'MINT')).toBeNull();
  });

  it('without a refresh the lock lapses after one period', () => {
    expect(acquireSwapLock('W', 'MINT')).not.toBeNull();
    vi.setSystemTime(181_000);
    expect(acquireSwapLock('W', 'MINT')).not.toBeNull();
  });

  it("a tab cannot refresh a lock another tab now holds", () => {
    const first = acquireSwapLock('W', 'MINT')!;
    vi.setSystemTime(181_000);
    const second = acquireSwapLock('W', 'MINT');
    expect(second).not.toBeNull();
    first.refresh();
    second!.release(true);
    expect(acquireSwapLock('W', 'MINT')).not.toBeNull();
  });
});
