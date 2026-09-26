'use client';

import { useEffect, useState } from 'react';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';

type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> };
type DisconnectFeature = { disconnect(): Promise<void> };
type SignFeature = {
  supportedTransactionVersions?: readonly (string | number)[];
  signTransaction(...inputs: {
    account: WalletAccount; transaction: Uint8Array; chain?: string;
    options?: { preflightCommitment?: 'processed' | 'confirmed' | 'finalized'; minContextSlot?: number };
  }[]): Promise<readonly { signedTransaction: Uint8Array }[]>;
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
 * The transaction version to build first for a wallet: v0 whenever it signs v0. v1 is live on
 * mainnet, but no Orientim v1 transaction has landed yet (review BR-12), and not every signer behind a
 * wallet reads it: Ledger's Solana app parses a v1 message as v0 and fails (research audit F-13).
 * So v1 is only for a wallet that signs nothing else, or for a route too big for v0 (`v1Fallback`).
 * Null when the wallet signs neither.
 */
export function chooseVersion(supported: readonly (string | number)[], v1Enabled: boolean): 0 | 1 | null {
  const versions = supported.map(String);
  if (versions.includes('0')) return 0;
  return v1Enabled && versions.includes('1') ? 1 : null;
}

/** May a swap too big for v0 be built again as v1 for this wallet? */
export function v1Fallback(supported: readonly (string | number)[], v1Enabled: boolean): boolean {
  return v1Enabled && supported.map(String).includes('1');
}

export function supportedVersions(wallet: Wallet): readonly (string | number)[] {
  return (wallet.features['solana:signTransaction'] as SignFeature).supportedTransactionVersions ?? ['legacy', 0];
}

/**
 * The wallet signs first, without sending (D4). Orientim checks what comes back before E signs. The
 * wallet is told the commitment and slot the blockhash was read at, so that its own simulation is
 * not run on older state, where the blockhash is unknown and the swap looks broken (research audit
 * F-15). A wallet may ignore them.
 */
export async function walletSign(
  wallet: Wallet, account: WalletAccount, transaction: Uint8Array, minContextSlot?: bigint,
): Promise<Uint8Array> {
  const f = wallet.features['solana:signTransaction'] as SignFeature;
  const options = { preflightCommitment: 'confirmed' as const, ...(minContextSlot ? { minContextSlot: Number(minContextSlot) } : {}) };
  const [out] = await f.signTransaction({ account, transaction, chain: CHAIN, options });
  return out.signedTransaction;
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
