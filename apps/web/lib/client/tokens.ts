'use client';

import { address, isAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { ataOf, tokenAccountSizeFor } from '@bound/core';
import type { TokenInfo } from '@bound/jupiter';
import { hasPermanentDelegate, hasTransferFee, transferFeeOf, transferFeeOn, unsupportedExtension } from '@bound/verifier';
import type { TransferFee } from '@bound/verifier';
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
 * Classic SPL and Token-2022 both belong here; whether a particular Token-2022 mint can be
 * isolated is decided by its extensions, which only the mint account itself shows (`readMint`).
 * This reads Jupiter's metadata, so it only decides what the picker shows.
 */
export const isSupported = (t: TokenInfo) => t.tokenProgram === TOKEN_PROGRAM || t.tokenProgram === TOKEN_2022_PROGRAM;

/**
 * What the chain says about a mint. These, not token metadata, convert amounts (audit C-01).
 * `unsupported` names the extension that makes a protected swap impossible, and comes from the
 * verifier itself, so the page and the rules cannot disagree.
 */
export type MintFacts = {
  decimals: number;
  program: string;
  unsupported: string | null;
  /** The tax the token itself charges on every transfer this epoch, or null. */
  transferFee: TransferFee | null;
  /** Size of a new account of this token, which decides the rent it costs to open one. */
  accountSize: number;
  /** The issuer can move or burn this token in any account, without its owner (Token-2022). */
  issuerCanMove: boolean;
  /** The mint account names a freeze authority, or a mint authority (read from the chain). */
  freezeAuthority: boolean;
  mintAuthority: boolean;
};

/**
 * An ATA includes the token program id in its seeds. The mint owner read from the chain therefore
 * has to travel with every derivation: the same wallet and mint have different classic and
 * Token-2022 ATA addresses.
 */
export const mintAta = (
  owner: Address,
  mint: string,
  facts: Pick<MintFacts, 'program'>,
) => ataOf(owner, address(mint), address(facts.program));

/**
 * What actually reaches the route: a taxing token keeps a cut of the transfer into the protected
 * account, so a price asked for the full amount would be a price for money that never arrives.
 */
export const amountReachingRoute = (amount: bigint, facts: Pick<MintFacts, 'transferFee'> | null | undefined) =>
  facts?.transferFee ? amount - transferFeeOn(amount, facts.transferFee) : amount;

const mintFacts = new Map<string, Promise<MintFacts | null>>();

/**
 * Which of a mint's two fee settings applies depends on the epoch. Read once per page load; an
 * epoch lasts days, and the exact number only matters at the moment a fee schedule changes.
 */
let epoch: Promise<bigint> | null = null;
const currentEpoch = () => (epoch ??= getRpc().getEpochInfo({ commitment: 'confirmed' }).send()
  .then(e => BigInt(e.epoch))
  .catch(e => {
    epoch = null; // a failed read is retried next time
    throw e; // never price a transfer fee using a guessed epoch
  }));

/** Reads the active schedule only when the mint actually carries the extension; never guesses. */
export const currentTransferFee = async (
  data: Uint8Array,
  readEpoch: () => Promise<bigint> = currentEpoch,
): Promise<TransferFee | null> => hasTransferFee(data) ? transferFeeOf(data, await readEpoch()) : null;

/** Decimals and token program from the mint account itself; null if it is not a token mint. */
export function readMint(mint: string): Promise<MintFacts | null> {
  if (!isAddress(mint)) return Promise.resolve(null);
  let facts = mintFacts.get(mint);
  if (!facts) {
    facts = (async () => {
      const { value } = await getRpc().getAccountInfo(address(mint), { encoding: 'base64', commitment: 'confirmed' }).send();
      if (!value || (value.owner !== TOKEN_PROGRAM && value.owner !== TOKEN_2022_PROGRAM)) return null;
      const data = Uint8Array.from(atob(value.data[0]), c => c.charCodeAt(0));
      if (data.length < 82) return null;
      return {
        decimals: data[44],
        program: value.owner,
        // The swap's own mints may charge a transfer fee; the cleanup harvests it before closing.
        unsupported: value.owner === TOKEN_2022_PROGRAM ? unsupportedExtension(data, { allowTransferFee: true }) : null,
        transferFee: value.owner === TOKEN_2022_PROGRAM
          ? await currentTransferFee(data)
          : null,
        accountSize: tokenAccountSizeFor(address(value.owner), data),
        issuerCanMove: value.owner === TOKEN_2022_PROGRAM && hasPermanentDelegate(data),
        // COption tags: 1 when the authority is set.
        mintAuthority: new DataView(data.buffer).getUint32(0, true) === 1,
        freezeAuthority: new DataView(data.buffer).getUint32(46, true) === 1,
      };
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

/**
 * Warnings about the token itself. Bound protects the wallet, not the value of what you buy.
 *
 * For a token Jupiter has not verified, including a pasted one it does not list, the authorities
 * come from the mint account, not from metadata (review BR-11). For a verified token Jupiter's audit
 * decides, as before: the regulated stablecoins all keep a freeze authority, and a warning on every
 * USDC swap would teach people to skip warnings.
 */
export function tokenWarnings(t: TokenInfo, facts?: Pick<MintFacts, 'freezeAuthority' | 'mintAuthority'> | null): string[] {
  const w: string[] = [];
  if (!t.isVerified) w.push(`${t.symbol} is not verified by Jupiter: check the address before you swap`);
  const onChain = !t.isVerified && facts ? facts : null;
  const freezes = onChain ? onChain.freezeAuthority : t.audit?.freezeAuthorityDisabled === false;
  const mints = onChain ? onChain.mintAuthority : t.audit?.mintAuthorityDisabled === false;
  if (freezes) w.push(`${t.symbol} has a freeze authority: its issuer can freeze your balance`);
  if (mints) w.push(`${t.symbol} can still be minted by its issuer`);
  return w;
}

/** A USD price is only used when it is a real, positive number (second review, C-01). */
export const usablePrice = (t: TokenInfo | null) =>
  t && typeof t.usdPrice === 'number' && Number.isFinite(t.usdPrice) && t.usdPrice > 0 ? t.usdPrice : null;
