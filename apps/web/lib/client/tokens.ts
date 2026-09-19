'use client';

import { address, isAddress } from '@solana/kit';
import type { TokenInfo } from '@bound/jupiter';
import { getJupiter, getRpc } from './chain';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Popular tokens shown before the user searches. */
export const POPULAR = [
  SOL_MINT, USDC_MINT,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', // JTO
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', // PYTH
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', // TRUMP
  '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv', // PENGU
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', // POPCAT
  'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', // RENDER
];

/**
 * v0.1 supports classic SPL tokens and SOL only (D5). This reads Jupiter's metadata, so it only
 * decides what the picker shows; the swap itself checks the mint on chain.
 */
export const isSupported = (t: TokenInfo) => t.tokenProgram === TOKEN_PROGRAM;

/** What the chain says about a mint. These, not token metadata, convert amounts (audit C-01). */
export type MintFacts = { decimals: number; program: string };

const mintFacts = new Map<string, Promise<MintFacts | null>>();

/** Decimals and token program from the mint account itself; null if it is not a token mint. */
export function readMint(mint: string): Promise<MintFacts | null> {
  if (!isAddress(mint)) return Promise.resolve(null);
  let facts = mintFacts.get(mint);
  if (!facts) {
    facts = (async () => {
      const { value } = await getRpc().getAccountInfo(address(mint), { encoding: 'base64', commitment: 'confirmed' }).send();
      if (!value || (value.owner !== TOKEN_PROGRAM && value.owner !== TOKEN_2022_PROGRAM)) return null;
      const data = Uint8Array.from(atob(value.data[0]), c => c.charCodeAt(0));
      return data.length >= 82 ? { decimals: data[44], program: value.owner } : null;
    })();
    facts.catch(() => mintFacts.delete(mint)); // a failed read is retried next time
    mintFacts.set(mint, facts);
  }
  return facts;
}

export async function loadTokens(mints: readonly string[]): Promise<TokenInfo[]> {
  const found = await getJupiter().searchTokens(mints.join(','));
  const byMint = new Map(found.map(t => [t.id, t]));
  return mints.flatMap(m => (byMint.has(m) ? [byMint.get(m)!] : []));
}

/**
 * Search by name, symbol or address. A pasted address that Jupiter's list does not know is read
 * from the chain, so any token can be found; it is marked as not listed.
 */
export async function searchTokens(query: string): Promise<TokenInfo[]> {
  const q = query.trim();
  const found = (await getJupiter().searchTokens(q).catch(() => [] as TokenInfo[])).slice(0, 30);
  if (isAddress(q) && !found.some(t => t.id === q)) {
    const facts = await readMint(q).catch(() => null);
    if (facts) {
      found.unshift({
        id: q, symbol: `${q.slice(0, 4)}…${q.slice(-4)}`, name: 'Not listed on Jupiter', decimals: facts.decimals,
        tokenProgram: facts.program, isVerified: false,
      });
    }
  }
  return found;
}

/** Warnings about the token itself. Bound protects the wallet, not the value of what you buy. */
export function tokenWarnings(t: TokenInfo): string[] {
  const w: string[] = [];
  if (!t.isVerified) w.push(`${t.symbol} is not verified by Jupiter: check the address before you swap`);
  if (t.audit && t.audit.freezeAuthorityDisabled === false) w.push(`${t.symbol} has a freeze authority: its issuer can freeze your balance`);
  if (t.audit && t.audit.mintAuthorityDisabled === false) w.push(`${t.symbol} can still be minted by its issuer`);
  return w;
}

/** A USD price is only used when it is a real, positive number (second review, C-01). */
export const usablePrice = (t: TokenInfo | null) =>
  t && typeof t.usdPrice === 'number' && Number.isFinite(t.usdPrice) && t.usdPrice > 0 ? t.usdPrice : null;
