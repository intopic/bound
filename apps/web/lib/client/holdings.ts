'use client';

import { address } from '@solana/kit';
import type { Address } from '@solana/kit';
import type { TokenInfo } from '@orientim/jupiter';
import { getRpc } from './chain';
import { loadTokens, SOL_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, usablePrice } from './tokens';

/**
 * The tokens a connected wallet holds, for the top of the token window, as swap sites show them: read
 * from the chain through Orientim's RPC, named and priced from Jupiter's list. Display only: the
 * swap reads its own balances again from the chain.
 */
export type Holding = { mint: string; program: string; amount: bigint; decimals: number };
export type OwnedToken = { token: TokenInfo; amount: bigint; usd: number | null };
export type Holdings = { shown: OwnedToken[]; hidden: OwnedToken[] };

/**
 * An unverified token worth less than this is kept under "hidden": wallets collect airdropped spam,
 * and a list led by it would invite a swap into a token nobody chose.
 */
export const HIDE_UNVERIFIED_BELOW_USD = 1;
/** Named from Jupiter's list at most this many, 40 to a request; the rest are listed by address. */
const MAX_NAMED = 120;
const MINTS_PER_REQUEST = 40;

type ParsedAccount = { account: { data: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } } } };

async function tokenAccounts(owner: Address, program: string): Promise<Holding[]> {
  const { value } = await getRpc()
    .getTokenAccountsByOwner(owner, { programId: address(program) }, { encoding: 'jsonParsed', commitment: 'confirmed' })
    .send();
  return (value as unknown as ParsedAccount[]).flatMap(a => {
    const info = a.account.data.parsed?.info;
    const amount = info?.tokenAmount?.amount;
    const decimals = info?.tokenAmount?.decimals;
    // Wrapped SOL is not the SOL the swap pays from, so it is not added to it.
    if (!info?.mint || info.mint === SOL_MINT || !amount || !/^\d+$/.test(amount) || typeof decimals !== 'number') return [];
    return [{ mint: info.mint, program, amount: BigInt(amount), decimals }];
  });
}

/** Every balance above zero, one per mint (a wallet may hold a mint in more than one account). */
export function mergeHoldings(list: readonly Holding[]): Holding[] {
  const byMint = new Map<string, Holding>();
  for (const h of list) {
    if (h.amount <= 0n) continue;
    const seen = byMint.get(h.mint);
    byMint.set(h.mint, seen ? { ...seen, amount: seen.amount + h.amount } : h);
  }
  return [...byMint.values()];
}

/**
 * The wallet's tokens, the most valuable first. Shown: SOL, verified tokens, and any other worth a
 * dollar or more. Hidden, behind a toggle: the rest, and tokens Jupiter does not list.
 */
export function rankHoldings(holdings: readonly Holding[], infos: readonly TokenInfo[]): Holdings {
  const byMint = new Map(infos.map(t => [t.id, t]));
  const shown: OwnedToken[] = [];
  const hidden: OwnedToken[] = [];
  for (const h of mergeHoldings(holdings)) {
    const listed = byMint.get(h.mint);
    const token: TokenInfo = listed ?? {
      id: h.mint, symbol: `${h.mint.slice(0, 4)}…${h.mint.slice(-4)}`, name: 'Not listed on Jupiter',
      decimals: h.decimals, tokenProgram: h.program, isVerified: false,
    };
    const price = usablePrice(token);
    const usd = price === null ? null : (Number(h.amount) / 10 ** h.decimals) * price;
    const owned = { token, amount: h.amount, usd };
    const keep = listed && (h.mint === SOL_MINT || token.isVerified || (usd !== null && usd >= HIDE_UNVERIFIED_BELOW_USD));
    (keep ? shown : hidden).push(owned);
  }
  const order = (a: OwnedToken, b: OwnedToken) =>
    (b.usd ?? -1) - (a.usd ?? -1) || a.token.symbol.localeCompare(b.token.symbol);
  return { shown: shown.sort(order), hidden: hidden.sort(order) };
}

/** The wallet's SOL and tokens, named and priced; throws when the chain cannot be read. */
export async function readHoldings(owner: Address): Promise<Holdings> {
  const [lamports, classic, token2022] = await Promise.all([
    getRpc().getBalance(owner, { commitment: 'confirmed' }).send().then(r => BigInt(r.value)),
    tokenAccounts(owner, TOKEN_PROGRAM),
    tokenAccounts(owner, TOKEN_2022_PROGRAM),
  ]);
  const holdings = mergeHoldings([{ mint: SOL_MINT, program: TOKEN_PROGRAM, amount: lamports, decimals: 9 }, ...classic, ...token2022]);
  const mints = holdings.map(h => h.mint).slice(0, MAX_NAMED);
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += MINTS_PER_REQUEST) chunks.push(mints.slice(i, i + MINTS_PER_REQUEST));
  // A list that cannot be named is still shown, by address, rather than not at all.
  const infos = (await Promise.all(chunks.map(c => loadTokens(c).catch(() => [] as TokenInfo[])))).flat();
  return rankHoldings(holdings, infos);
}
