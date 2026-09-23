import { describe, expect, it } from 'vitest';
import type { WalletAccount } from '@wallet-standard/base';
import { chooseVersion, mainnetAccounts } from '../lib/client/wallets.ts';

const account = (name: string, chains: readonly `${string}:${string}`[]) => ({
  address: name,
  publicKey: new Uint8Array(32),
  chains,
  features: [],
}) as unknown as WalletAccount;

describe('wallet chain selection', () => {
  it('keeps only accounts that explicitly support Solana mainnet', () => {
    const devnet = account('devnet', ['solana:devnet']);
    const mainnet = account('mainnet', ['solana:mainnet']);
    expect(mainnetAccounts([devnet, mainnet])).toEqual([mainnet]);
  });

  it('does not fall back to an account from another chain', () => {
    expect(mainnetAccounts([
      account('devnet', ['solana:devnet']),
      account('ethereum', ['ethereum:mainnet']),
    ])).toEqual([]);
  });
});

describe('the transaction version (review BR-12)', () => {
  it('v0 even when the wallet advertises v1, until a build enables it', () => {
    expect(chooseVersion(['legacy', 0, 1], false)).toBe(0);
  });

  it('v1 when the build enables it and the wallet signs it', () => {
    expect(chooseVersion(['legacy', 0, 1], true)).toBe(1);
    expect(chooseVersion(['legacy', 0], true)).toBe(0);
  });

  it('nothing for a wallet that signs only legacy transactions', () => {
    expect(chooseVersion(['legacy'], true)).toBeNull();
  });
});

