'use client';

import { useEffect, useState } from 'react';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';

type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> };
type DisconnectFeature = { disconnect(): Promise<void> };
type SignFeature = {
  supportedTransactionVersions?: readonly (string | number)[];
  signTransaction(...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]): Promise<readonly { signedTransaction: Uint8Array }[]>;
};
type EventsFeature = { on(event: 'change', listener: (props: { accounts?: readonly WalletAccount[] }) => void): () => void };

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

export async function connectWallet(wallet: Wallet, silent = false): Promise<WalletAccount | null> {
  const { accounts } = await (wallet.features['standard:connect'] as ConnectFeature).connect(silent ? { silent: true } : undefined);
  return mainnetAccounts(accounts)[0] ?? null;
}

export async function disconnectWallet(wallet: Wallet): Promise<void> {
  const f = wallet.features['standard:disconnect'] as DisconnectFeature | undefined;
  await f?.disconnect();
}

export function onAccountChange(wallet: Wallet, listener: (accounts: readonly WalletAccount[]) => void): () => void {
  const f = wallet.features['standard:events'] as EventsFeature | undefined;
  return f ? f.on('change', props => props.accounts && listener(mainnetAccounts(props.accounts))) : () => {};
}

/**
 * The transaction version to build for a wallet: v0, and v1 only when this build enables it. v1 is
 * live on mainnet, but no Bound v1 transaction has landed yet, so a wallet that advertises v1 must
 * not make every swap depend on it (review BR-12). Null when the wallet signs neither.
 */
export function chooseVersion(supported: readonly (string | number)[], v1Enabled: boolean): 0 | 1 | null {
  const versions = supported.map(String);
  if (v1Enabled && versions.includes('1')) return 1;
  return versions.includes('0') ? 0 : null;
}

export function supportedVersions(wallet: Wallet): readonly (string | number)[] {
  return (wallet.features['solana:signTransaction'] as SignFeature).supportedTransactionVersions ?? ['legacy', 0];
}

/** The wallet signs first, without sending (D4). Bound checks what comes back before E signs. */
export async function walletSign(wallet: Wallet, account: WalletAccount, transaction: Uint8Array): Promise<Uint8Array> {
  const f = wallet.features['solana:signTransaction'] as SignFeature;
  const [out] = await f.signTransaction({ account, transaction, chain: CHAIN });
  return out.signedTransaction;
}
