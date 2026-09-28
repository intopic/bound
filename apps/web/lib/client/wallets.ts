'use client';

import { useEffect, useState } from 'react';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';

type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> };

export const CHAIN = 'solana:mainnet';

const isSolanaWallet = (w: Wallet) =>
  'standard:connect' in w.features && 'solana:signTransaction' in w.features && w.chains.includes(CHAIN);

/** Accounts valid for the chain this application builds and broadcasts on. */
export const mainnetAccounts = (accounts: readonly WalletAccount[]): readonly WalletAccount[] =>
  accounts.filter(a => a.chains.includes(CHAIN));

/** Wallets discovered through the Wallet Standard (Phantom, Solflare, Backpack, …). */
export function useWallets(): readonly Wallet[] {
  const [wallets, setWallets] = useState<readonly Wallet[]>([]);
  useEffect(() => {
    const api = getWallets();
    const update = () => setWallets(api.get().filter(isSolanaWallet));
    update();
    const offRegister = api.on('register', update);
    const offUnregister = api.on('unregister', update);
    return () => {
      offRegister();
      offUnregister();
    };
  }, []);
  return wallets;
}

export async function connectWallet(wallet: Wallet): Promise<WalletAccount | null> {
  const { accounts } = await (wallet.features['standard:connect'] as ConnectFeature).connect();
  return mainnetAccounts(accounts)[0] ?? null;
}

type SignMessageFeature = {
  signMessage(...inputs: { account: WalletAccount; message: Uint8Array }[]): Promise<readonly { signedMessage: Uint8Array; signature: Uint8Array }[]>;
};

/** Whether the wallet can sign a plain message (Wallet Standard `solana:signMessage`), which an API key needs. */
export const signsMessages = (wallet: Wallet) => 'solana:signMessage' in wallet.features;

/**
 * The wallet's signature of a plain message. Only for Orientim's API-key message, checked by the
 * caller first: a signature over bytes someone else chose could be a signature for a transaction.
 */
export async function walletSignMessage(wallet: Wallet, account: WalletAccount, message: Uint8Array): Promise<Uint8Array> {
  const f = wallet.features['solana:signMessage'] as SignMessageFeature;
  const [out] = await f.signMessage({ account, message });
  return out.signature;
}
