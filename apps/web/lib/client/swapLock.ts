'use client';

/**
 * One Bound swap at a time into the same output token, across this browser's tabs (decision A on
 * the second review's question 2).
 *
 * The minimum-output check compares the output account with its balance when the swap was
 * prepared. A second swap into the same account while the first is still open could count the
 * first one's tokens toward its own minimum. This lock keeps Bound's own swaps from overlapping;
 * a transfer from someone else at the same moment is outside it and is stated in the guarantee.
 *
 * Best effort over localStorage (no server, no database). Without storage, the page's own busy
 * state still prevents two swaps from this tab.
 */
const PREFIX = 'bound.swap-lock.v1:';
const ACTIVE_MS = 180_000; // prepare, wallet and send; refreshed on release
const UNSETTLED_MS = 150_000; // an unknown outcome: until the transaction can no longer land

type Stored = { token: string; until: number };
export type SwapLock = { release(settled: boolean): void };

const read = (key: string): Stored | null => {
  const raw = window.localStorage.getItem(key);
  return raw ? (JSON.parse(raw) as Stored) : null;
};

export function acquireSwapLock(owner: string, outputMint: string): SwapLock | null {
  const key = `${PREFIX}${owner}:${outputMint}`;
  const token = crypto.randomUUID();
  try {
    const current = read(key);
    if (current && current.until > Date.now()) return null;
    window.localStorage.setItem(key, JSON.stringify({ token, until: Date.now() + ACTIVE_MS }));
    if (read(key)?.token !== token) return null; // another tab won the race
  } catch {
    return { release() {} };
  }
  return {
    /** `settled`: the outcome is final. Otherwise the lock is kept while the swap could still land. */
    release(settled) {
      try {
        if (read(key)?.token !== token) return;
        if (settled) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, JSON.stringify({ token, until: Date.now() + UNSETTLED_MS }));
      } catch {
        // nothing to release
      }
    },
  };
}
