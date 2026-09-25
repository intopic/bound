'use client';

import { BLOCKHASH_LIFE_BLOCKS, provesNeverLanded } from '@bound/solana';
import type { StatusView } from '@bound/solana';

/**
 * Swap history lives only in this browser (no accounts, no database). Browsing works without
 * storage; swapping does not (third audit, F3).
 *
 * A swap is recorded as `pending` the moment its signature exists, before anything is sent, and it
 * is sent only once that record is stored, so a lost connection or a closed tab never loses track
 * of a transaction that may have landed (audit C-03). `pending` and `unknown` entries are settled
 * from the chain, and while one from a wallet is unsettled that wallet starts no new swap: a retry
 * waits for the chain's answer, not for a timer (third audit, F2).
 */
export type HistoryStatus = 'pending' | 'confirmed' | 'failed' | 'expired' | 'rejected' | 'unknown' | 'checked';

export type HistoryEntry = {
  at: number;
  signature: string;
  status: HistoryStatus;
  /** Decimal string because localStorage cannot serialize bigint; absent on entries from older builds. */
  lastValidBlockHeight?: string;
  /** The wallet that signed it. Entries from older builds have none and count for every wallet. */
  owner?: string;
  /**
   * The finalized chain is past its last valid block, so it can no longer land. Only then may the
   * user, having looked it up, set an outcome the chain could not prove aside (`checked`).
   */
  over?: boolean;
  paid: string;
  received: string;
  exposed: string;
};

export type SignatureState = {
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null;
  err?: unknown;
} | null;

const lastValidOf = (entry: HistoryEntry): bigint | null => {
  try {
    return entry.lastValidBlockHeight === undefined ? null : BigInt(entry.lastValidBlockHeight);
  } catch {
    // Old or malformed local data is not evidence of anything.
    return null;
  }
};

/**
 * A persisted swap changes state only when the chain proves the outcome. `view`: the heights the
 * status answer covers (see `statusesCovering`). "No record" proves the swap never landed only while
 * the answering node still holds every block it could have landed in (`provesNeverLanded`, third
 * audit F1); a later visit finds no proof either way, and the swap stays unknown.
 */
export function settledHistoryStatus(
  entry: HistoryEntry,
  state: SignatureState,
  view: Pick<StatusView, 'coveredHeight' | 'reachHeight'>,
): HistoryStatus | null {
  // Only a confirmed status is an outcome: an error seen at `processed` may be on a fork (FA-07).
  const confirmed = !!state && (state.confirmationStatus === 'confirmed' || state.confirmationStatus === 'finalized');
  if (confirmed) return state!.err ? 'failed' : 'confirmed';
  const lastValid = lastValidOf(entry);
  if (state || lastValid === null) return null;
  // The page's own blockhash: the first block the swap could land in is 149 below its last.
  return provesNeverLanded(view, lastValid, lastValid - BLOCKHASH_LIFE_BLOCKS + 1n) ? 'expired' : null;
}

/**
 * A transaction lives 150 blocks, about a minute: one recorded longer ago than this can no longer
 * land, whatever its entry says. Used only for an entry that does not name its last block (an older
 * build's, or one this browser damaged), which would otherwise hold its wallet back for good.
 */
const LIFETIME_BOUND_MS = 15 * 60_000;

/** Is the finalized chain past this swap's last valid block, so that it can no longer land? */
export function lifetimeOver(entry: HistoryEntry, view: Pick<StatusView, 'coveredHeight'>, now = Date.now()): boolean {
  const lastValid = lastValidOf(entry);
  if (lastValid === null) return typeof entry.at === 'number' && now - entry.at > LIFETIME_BOUND_MS;
  return view.coveredHeight !== null && view.coveredHeight > lastValid;
}

/** Where the history is kept; other tabs of the page watch it (a `storage` event). */
export const HISTORY_KEY = 'bound.history.v1';
const KEY = HISTORY_KEY;
const PROBE = 'bound.history.probe';
const MAX = 50;

export const isUnsettled = (h: HistoryEntry) => h.status === 'pending' || h.status === 'unknown';

/** This wallet's swaps that may still land, or whose outcome nobody knows yet. */
export const unsettledFor = (list: readonly HistoryEntry[], owner: string) =>
  list.filter(h => isUnsettled(h) && (h.owner === undefined || h.owner === owner));

/** The swap was not sent because this browser would not keep its record. */
export class HistoryNotSaved extends Error {
  constructor() {
    super("This browser didn't save the swap's record, so Bound did not send it.");
  }
}

export function readHistory(): HistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Can this browser keep a record at all (storage allowed and not full)? Asked before the wallet opens. */
export function historyWorks(): boolean {
  try {
    window.localStorage.setItem(PROBE, '1');
    const ok = window.localStorage.getItem(PROBE) === '1';
    window.localStorage.removeItem(PROBE);
    return ok;
  } catch {
    return false;
  }
}

function write(next: HistoryEntry[]): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/** The newest 50, and every swap that is not settled yet, however old: those are never dropped. */
function trim(list: HistoryEntry[]): HistoryEntry[] {
  const open = list.filter(isUnsettled).length;
  let settledRoom = Math.max(0, MAX - open);
  return list.filter(h => isUnsettled(h) || settledRoom-- > 0);
}

/**
 * Records a swap before it is sent. Throws `HistoryNotSaved` unless the record is stored and reads
 * back, and the caller then sends nothing.
 */
export function addHistory(entry: HistoryEntry): HistoryEntry[] {
  const next = trim([entry, ...readHistory().filter(h => h.signature !== entry.signature)]);
  if (!write(next) || !readHistory().some(h => h.signature === entry.signature && h.status === entry.status)) throw new HistoryNotSaved();
  return next;
}

/** `received`: what the chain recorded, once known; it replaces the minimum stored at send. */
export function updateHistory(signature: string, status: HistoryStatus, received?: string, patch: Partial<Pick<HistoryEntry, 'over'>> = {}): HistoryEntry[] {
  const next = readHistory().map(h => (h.signature === signature ? { ...h, ...patch, status, ...(received ? { received } : {}) } : h));
  write(next);
  return next;
}

export const STATUS_LABEL: Record<HistoryStatus, string> = {
  pending: 'pending',
  confirmed: 'confirmed',
  failed: 'failed, reverted',
  expired: 'expired',
  rejected: 'not sent',
  unknown: 'check Solscan',
  checked: 'checked by you',
};
