/**
 * The settings a deployment is built with. A wrong one stops the build with what to fix: a fee typed
 * as a percentage stopped the page from loading, an empty one made every swap fail as "too small",
 * and a mistyped treasury ran the page and the agent API without a fee.
 */
import { describe, expect, it } from 'vitest';
import { checkDeploymentSettings, feeBpsSetting, maxNetworkFeeSetting, treasurySetting } from '../lib/settings.ts';

const TREASURY = 'ARzSA3sZGhf5t4UnYrmB3TWyZ5m3Wo1nA9zWBcoiTqLE';

describe('deployment settings', () => {
  it('the fee is whole basis points, 30 when unset or empty', () => {
    expect(feeBpsSetting(undefined)).toBe(30n);
    expect(feeBpsSetting('')).toBe(30n);
    expect(feeBpsSetting(' 30 ')).toBe(30n);
    expect(feeBpsSetting('100')).toBe(100n);
    for (const wrong of ['0.3', '0,3', '0.3%', '30bps', '101', '-5', 'abc']) expect(() => feeBpsSetting(wrong)).toThrow('NEXT_PUBLIC_BOUND_FEE_BPS');
  });

  it('the treasury is an address, or empty for test mode', () => {
    expect(treasurySetting(undefined)).toBeNull();
    expect(treasurySetting('  ')).toBeNull();
    expect(treasurySetting(` ${TREASURY} `)).toBe(TREASURY);
    expect(() => treasurySetting(`${TREASURY}x`)).toThrow('NEXT_PUBLIC_BOUND_TREASURY');
    expect(() => treasurySetting('0x1234')).toThrow('not one');
  });

  it('the network fee limit is lamports, at least two signatures, 500,000 when unset', () => {
    expect(maxNetworkFeeSetting(undefined)).toBe(500_000n);
    expect(maxNetworkFeeSetting('200000')).toBe(200_000n);
    for (const wrong of ['0', '5000', '0.0005', 'lots']) expect(() => maxNetworkFeeSetting(wrong)).toThrow('BOUND_MAX_NETWORK_FEE_LAMPORTS');
  });

  it('the build refuses the first wrong setting, and a treasury with no fee', () => {
    expect(() => checkDeploymentSettings({ NEXT_PUBLIC_BOUND_TREASURY: TREASURY, NEXT_PUBLIC_BOUND_FEE_BPS: '30' })).not.toThrow();
    expect(() => checkDeploymentSettings({})).not.toThrow();
    expect(() => checkDeploymentSettings({ NEXT_PUBLIC_BOUND_TREASURY: TREASURY, NEXT_PUBLIC_BOUND_FEE_BPS: '0.3' })).toThrow('basis points');
    expect(() => checkDeploymentSettings({ NEXT_PUBLIC_BOUND_TREASURY: TREASURY, NEXT_PUBLIC_BOUND_FEE_BPS: '0' })).toThrow('every swap would be refused');
    expect(() => checkDeploymentSettings({ NEXT_PUBLIC_BOUND_FEE_BPS: '0' })).not.toThrow();
  });
});
