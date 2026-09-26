/**
 * The slippage setting (⚙️ on the card): what a person may type, what is kept and for how long, and
 * what reaches the swap's settings. The verifier's side is in packages/verifier/test/verifier.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@orientim/jupiter';
import { MAX_CHOSEN_SLIPPAGE_BPS } from '@orientim/core/constants';
import { isChoice, loadSlippage, parsePercent, percentText, saveSlippage, withSlippage } from '../lib/client/slippage.ts';

const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};

describe('the slippage a person may choose', () => {
  it('reads a percentage as typed, from 0.1% to 15%', () => {
    expect(parsePercent('1')).toBe(100);
    expect(parsePercent('2.5')).toBe(250);
    expect(parsePercent('0,5')).toBe(50);
    expect(parsePercent(' 3% ')).toBe(300);
    expect(parsePercent('15')).toBe(MAX_CHOSEN_SLIPPAGE_BPS);
    expect(parsePercent('0.1')).toBe(10);
    for (const bad of ['', 'abc', '0', '0.05', '15.01', '16', '50', '-1', '1e1', '1.234']) expect(parsePercent(bad), bad).toBeNull();
  });

  it('knows a choice when it sees one', () => {
    expect(isChoice('auto')).toBe(true);
    expect(isChoice(300)).toBe(true);
    expect(isChoice(1_501)).toBe(false);
    expect(isChoice(2.5)).toBe(false);
    expect(isChoice('300')).toBe(false);
  });

  it('shows bps as a percentage', () => {
    expect(percentText(50)).toBe('0.5%');
    expect(percentText(250)).toBe('2.5%');
    expect(percentText(1_500)).toBe('15%');
  });
});

describe('what is kept, and for how long', () => {
  it('up to 5% lasts; above, for this visit only', () => {
    const local = store();
    const session = store();
    saveSlippage(100, { local, session });
    expect(loadSlippage({ local, session })).toBe(100);
    saveSlippage(1_000, { local, session });
    expect(loadSlippage({ local, session })).toBe(1_000);
    // A new visit: the session is gone, the lasting choice is back.
    expect(loadSlippage({ local, session: store() })).toBe(100);
    saveSlippage('auto', { local, session });
    expect(loadSlippage({ local, session })).toBe('auto');
  });

  it('anything kept that is not a choice, or storage that refuses, is Auto', () => {
    const local = store();
    local.setItem('orientim.slippage.v1', '99999');
    expect(loadSlippage({ local, session: null })).toBe('auto');
    const refusing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
    expect(loadSlippage({ local: refusing, session: refusing })).toBe('auto');
    expect(() => saveSlippage(100, { local: refusing, session: refusing })).not.toThrow();
  });
});

describe("what reaches the swap's settings", () => {
  it('Auto leaves them as they are; a choice is the tolerance of every route', () => {
    expect(withSlippage(DEFAULT_SETTINGS, 'auto')).toBe(DEFAULT_SETTINGS);
    expect(withSlippage(DEFAULT_SETTINGS, 'auto').chosenSlippageBps).toBeUndefined();
    const chosen = withSlippage(DEFAULT_SETTINGS, 300);
    expect(chosen.chosenSlippageBps).toBe(300);
    expect(chosen.slippageBps).toBe(DEFAULT_SETTINGS.slippageBps);
  });
});
