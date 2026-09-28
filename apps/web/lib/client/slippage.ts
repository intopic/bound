import { MAX_CHOSEN_SLIPPAGE_BPS } from '@orientim/core/constants';
import type { SwapSettings } from '@orientim/jupiter';

/**
 * The slippage setting (⚙️ on the card). "auto" follows Jupiter's own estimate for the token, from 0.5%
 * to 3% (autoToleranceBps), and is 3% for a token on a Pump.fun launch curve. A number is the person's
 * own choice, in bps, for every route: the swap is built at it and the verifier holds the route to it,
 * never above 15% (MAX_CHOSEN_SLIPPAGE_BPS).
 */
export type SlippageChoice = 'auto' | number;

export const SLIPPAGE_PRESETS = [50, 100, 300] as const;
/** The least a person may choose: 0.1%. Below it almost every swap would cancel itself. */
export const MIN_CHOSEN_BPS = 10;
export const MAX_CHOSEN_BPS = MAX_CHOSEN_SLIPPAGE_BPS;
/** Above this the page warns, and the choice lasts for this visit only. */
export const WARN_ABOVE_BPS = 500;
/** Below this the page warns that the swap may cancel itself: 0.3%, under the 0.5% of Auto. */
export const WARN_BELOW_BPS = 30;

/**
 * What the page says about a tolerance the person chose, as swap sites do: too tight, and the swap
 * may cancel itself; too wide, and less may arrive. Auto says nothing.
 */
export function slippageWarning(choice: SlippageChoice): { level: 'low' | 'high'; text: string } | null {
  if (choice === 'auto') return null;
  if (choice < WARN_BELOW_BPS) {
    return { level: 'low', text: `Slippage ${percentText(choice)} is very tight: your swap may cancel itself if the price moves even slightly.` };
  }
  if (choice > WARN_ABOVE_BPS) {
    return { level: 'high', text: `Slippage ${percentText(choice)} is high: you may receive much less than the quote, and trading bots can take the difference.` };
  }
  return null;
}

/** Auto never goes below 0.5%, Orientim's tolerance before it followed Jupiter's estimate. */
export const AUTO_MIN_BPS = 50;
/** Nor above 3%, the tolerance of a token on its launch curve: a wider one is the person's choice. */
export const AUTO_MAX_BPS = 300;

/**
 * Auto for one quote: the tolerance Jupiter estimated for this trade (asked with `estimateSlippage`),
 * read from its answer's threshold and held from 0.5% to 3%. A token that moves fast gets more room,
 * as it does on Jupiter; one Jupiter would hold tighter than 0.5% keeps 0.5%.
 */
export function autoToleranceBps(r: { outAmount: string; otherAmountThreshold: string }): number {
  const out = BigInt(r.outAmount);
  const threshold = BigInt(r.otherAmountThreshold);
  if (out <= 0n || threshold <= 0n || threshold >= out) return AUTO_MIN_BPS;
  // Rounded to the nearest bps: the threshold itself was rounded down from the quote.
  const bps = Number(((out - threshold) * 20_000n + out) / (2n * out));
  return Math.min(AUTO_MAX_BPS, Math.max(AUTO_MIN_BPS, bps));
}

const KEY = 'orientim.slippage.v1';

export const isChoice = (v: unknown): v is SlippageChoice =>
  v === 'auto' || (typeof v === 'number' && Number.isInteger(v) && v >= MIN_CHOSEN_BPS && v <= MAX_CHOSEN_BPS);

/** A percentage a person typed ("1", "2.5", "0,5", "3%") in bps, or null unless it is one from 0.1% to 15%. */
export function parsePercent(text: string): number | null {
  const t = text.trim().replace(/%$/, '').trim().replace(',', '.');
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return isChoice(bps) ? bps : null;
}

/** 50 → "0.5%", 250 → "2.5%", 1500 → "15%". */
export const percentText = (bps: number) => `${bps / 100}%`;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const stores = (): { local: Store | null; session: Store | null } => {
  const get = (name: 'localStorage' | 'sessionStorage') => {
    try {
      return window[name];
    } catch {
      return null;
    }
  };
  return { local: get('localStorage'), session: get('sessionStorage') };
};
const read = (s: Store | null): SlippageChoice | null => {
  try {
    const raw = s?.getItem(KEY);
    if (raw === null || raw === undefined) return null;
    const v = raw === 'auto' ? 'auto' : Number(raw);
    return isChoice(v) ? v : null;
  } catch {
    return null;
  }
};

/** The choice kept in this browser: this visit's first (a high one), then the lasting one, else "auto". */
export function loadSlippage(from = stores()): SlippageChoice {
  return read(from.session) ?? read(from.local) ?? 'auto';
}

/**
 * Keeps the choice. Up to 5% it lasts; above, for this visit only, so that a high tolerance set for
 * one fast-moving token is not left on for every swap after it.
 */
export function saveSlippage(choice: SlippageChoice, to = stores()) {
  try {
    if (choice !== 'auto' && choice > WARN_ABOVE_BPS) {
      to.session?.setItem(KEY, String(choice));
    } else {
      to.session?.removeItem(KEY);
      to.local?.setItem(KEY, String(choice));
    }
  } catch {
    // Storage refused (a private window): the choice holds until the page is closed.
  }
}

/** The swap settings with the person's choice: unchanged for "auto". */
export function withSlippage<T extends Pick<SwapSettings, 'slippageBps' | 'curveSlippageBps'>>(settings: T, choice: SlippageChoice): T & { chosenSlippageBps?: number } {
  return choice === 'auto' ? settings : { ...settings, chosenSlippageBps: choice };
}
