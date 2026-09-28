import { describe, expect, it } from 'vitest';
import type { WalletAccount } from '@wallet-standard/base';
import { mainnetAccounts } from '../lib/client/wallets.ts';

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
