import { MAX_CHOSEN_SLIPPAGE_BPS } from '@orientim/core/constants';
import type { SwapSettings } from '@orientim/jupiter';

/**
 * The slippage setting (⚙️ on the card). "auto" is Orientim's own tolerance: 0.5%, or 3% for a token on
 * a Pump.fun launch curve. A number is the person's own choice, in bps, for every route: the swap is
 * built at it and the verifier holds the route to it, never above 15% (MAX_CHOSEN_SLIPPAGE_BPS).
 */
export type SlippageChoice = 'auto' | number;

export const SLIPPAGE_PRESETS = [50, 100, 300] as const;
/** The least a person may choose: 0.1%. Below it almost every swap would cancel itself. */
export const MIN_CHOSEN_BPS = 10;
export const MAX_CHOSEN_BPS = MAX_CHOSEN_SLIPPAGE_BPS;
/** Above this the page warns, and the choice lasts for this visit only. */
export const WARN_ABOVE_BPS = 500;

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
