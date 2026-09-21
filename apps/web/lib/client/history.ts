'use client';

/**
 * Swap history lives only in this browser (no accounts, no database). Storage can be unavailable
 * (private mode, blocked site data), so every access is guarded and the app works without it.
 *
 * A swap is recorded as `pending` the moment its signature exists, before anything is sent, so a
 * lost connection or a closed tab never loses track of a transaction that may have landed
 * (audit C-03). `pending` and `unknown` entries are settled from the chain on the next visit.
 */
export type HistoryStatus = 'pending' | 'confirmed' | 'failed' | 'expired' | 'rejected' | 'unknown';

export type HistoryEntry = {
  at: number;
  signature: string;
  status: HistoryStatus;
  /** Decimal string because localStorage cannot serialize bigint; absent on entries from older builds. */
  lastValidBlockHeight?: string;
  paid: string;
  received: string;
  exposed: string;
};

export type SignatureState = {
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null;
  err?: unknown;
} | null;

/** A persisted swap changes state only when the chain proves the outcome. */
export function settledHistoryStatus(
  entry: HistoryEntry,
  state: SignatureState,
  blockHeight: bigint | null,
): HistoryStatus | null {
  if (state?.err) return 'failed';
  if (state && (state.confirmationStatus === 'confirmed' || state.confirmationStatus === 'finalized')) return 'confirmed';
  if (state || blockHeight === null || entry.lastValidBlockHeight === undefined) return null;
  try {
    return blockHeight > BigInt(entry.lastValidBlockHeight) ? 'expired' : null;
  } catch {
    // Old or malformed local data is not evidence of expiry.
    return null;
  }
}

const KEY = 'bound.history.v1';
const MAX = 50;

export function readHistory(): HistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(next: HistoryEntry[]): HistoryEntry[] {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // History is a convenience; the swap itself never depends on it.
  }
  return next;
}

export function addHistory(entry: HistoryEntry): HistoryEntry[] {
  return write([entry, ...readHistory().filter(h => h.signature !== entry.signature)].slice(0, MAX));
}

export function updateHistory(signature: string, status: HistoryStatus): HistoryEntry[] {
  return write(readHistory().map(h => (h.signature === signature ? { ...h, status } : h)));
}

export const isUnsettled = (h: HistoryEntry) => h.status === 'pending' || h.status === 'unknown';

export const STATUS_LABEL: Record<HistoryStatus, string> = {
  pending: 'pending',
  confirmed: 'confirmed',
  failed: 'failed, reverted',
  expired: 'expired',
  rejected: 'not sent',
  unknown: 'check Solscan',
};
