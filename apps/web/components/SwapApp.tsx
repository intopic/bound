'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { address, getTransactionEncoder } from '@solana/kit';
import type { Address, KeyPairSigner } from '@solana/kit';
import { FEE_TOKENS, feeFor, feeSideFor, JUPITER_PROGRAM, outputFeeFor, tokenAmountOf } from '@orientim/core';
import type { FeeSide, TxVersion } from '@orientim/core';
import {
  OrientimError, DEFAULT_SETTINGS, finalizeProtectedSwap, isCurveRoute, JupiterError, MIN_FEE, prepareProtectedSwap, quotedMinimum,
  revertedOnPrice,
} from '@orientim/jupiter';
import type { PreparedSwap, TokenInfo } from '@orientim/jupiter';
import { createEphemeral, fetchAccounts, httpStatusOf, statusesCovering } from '@orientim/solana';
import type { SendOutcome, SendRefusal } from '@orientim/solana';
import type { PublicStatus } from '@/lib/server/config';
import { getJupiter, getRpc } from '@/lib/client/chain';
import { FEE_BPS, TREASURY, V1_ENABLED } from '@/lib/client/config';
import {
  chooseVersion, connectWallet, disconnectWallet, onAccountChange, supportedVersions, useWallets, v1Fallback, walletSign,
} from '@/lib/client/wallets';
import { formatExact, formatUnits, formatUsd, parseUnits, shortAddress } from '@/lib/client/format';
import {
  amountReachingRoute, loadTokens, mintAta, POPULAR, readMint, SOL_MINT, tokenWarnings, usablePrice, USDC_MINT,
} from '@/lib/client/tokens';
import type { MintFacts } from '@/lib/client/tokens';
import {
  addHistory, HISTORY_KEY, historyWorks, HistoryNotSaved, isUnsettled, lifetimeOver, readHistory, settledHistoryStatus, STATUS_LABEL, unsettledFor,
  updateHistory,
} from '@/lib/client/history';
import type { HistoryEntry, HistoryStatus, SignatureState } from '@/lib/client/history';
import { acquireSwapLock } from '@/lib/client/swapLock';
import { costsMoreThan, keptByMarket } from '@/lib/client/rebuild';
import { receivedFromMeta } from '@/lib/client/received';
import type { ConfirmedMeta } from '@/lib/client/received';
import { errorDetail, problemsReport, recordProblem, watchUncaught } from '@/lib/client/problems';
import type { Problem } from '@/lib/client/problems';
import { Modal } from './Modal';
import { TokenIcon, TokenPicker } from './TokenPicker';
import { ShieldIcon, SiteHeader } from './site/Brand';

type Phase = 'idle' | 'checking' | 'confirm' | 'wallet' | 'sending';
/** `detail`: the raw error behind the words, kept in this browser for when help is asked (never shown by itself). */
type Notice = { kind: 'error' | 'success' | 'info'; title: string; body?: string; link?: string; detail?: string };
/**
 * `curve`: the route trades on a Pump.fun bonding curve, so its tolerance is the wider one.
 * `impact`: how much this amount moves the market price, as Jupiter reports it: a fraction, so
 * 0.132 is 13.2% (checked 2026-09-23 against the rates of a small and a large quote).
 */
type Quote = { out: bigint; minOut: bigint; curve: boolean; impact: number; at: number };
/** What the wallet is about to be asked to sign, shown while it is open. */
type Pending = {
  minReceived: string; networkFee: string; oneTimeCost: string | null; removesDelegate: string | null;
  tokenTax: string | null; busyNetwork: string | null;
  /** Orientim's fee when it is paid in SOL from the wallet: its exact amount, priced when the swap was built. */
  solFee: string | null;
};
/** The market moved beyond the tolerance since the user looked: the new minimum to accept or not. */
/** A question the page puts to the user mid-swap, with nothing signed yet. */
type Offer =
  | { kind: 'price'; was: string; now: string }
  | { kind: 'cost'; gap: string; severe: boolean }
  | { kind: 'impact'; pct: string }
  | { kind: 'extras'; lines: string[] };
/** `received`: what the chain recorded, once confirmed; empty until then. */
type SwapTexts = { paid: string; received: string; exposed: string; minimum: string };

// Quotes are asked for a neutral taker, so Jupiter never sees the user's address before a swap.
const QUOTE_TAKER = '11111111111111111111111111111111';
const SOL_RESERVE_LAMPORTS = 10_000_000n; // fees plus temporary rent, returned in the same transaction
const OFFER_TIMEOUT_MS = 45_000;
/** Price impact: a warning from 1%, a question before building from 5%, as swap pages usually do. */
const IMPACT_WARN = 0.01;
const IMPACT_ASK = 0.05;
const impactText = (fraction: number) => `${(fraction * 100).toFixed(fraction < 0.1 ? 2 : 1)}%`;

/**
 * Each question the page asks, in plain words. The protected route's distance from the best price is
 * stated as a fact, not as a cost of the protection; price impact is its own, separate warning.
 */
function offerCopy(o: Offer): { title: string; body: ReactNode; go: string } {
  switch (o.kind) {
    case 'price':
      return {
        title: 'The protected route pays less than the price you saw',
        body: <p>Minimum received is now <strong>{o.now}</strong> (was {o.was}). Nothing has been signed.</p>,
        go: 'Continue with the new minimum',
      };
    case 'cost':
      return {
        title: `This route gives ${o.gap} less than the best unprotected route`,
        body: <p>{o.severe ? 'A smaller amount often gets a better price. ' : ''}Nothing has been signed.</p>,
        go: 'Continue',
      };
    case 'impact':
      return {
        title: `Price impact is ${o.pct}`,
        body: <p>This amount moves the market price a lot, so you get less per token than a smaller swap would. Nothing has been signed.</p>,
        go: 'Continue',
      };
    case 'extras':
      return {
        title: 'Before your wallet opens',
        body: <ul className="extras">{o.lines.map(line => <li key={line}>{line}</li>)}</ul>,
        go: 'Continue to wallet',
      };
  }
}
/**
 * A transaction lives 150 blocks: about 41 s at the 272 ms blocks measured in September 2026, and
 * less as slots get shorter. What the wallet is left with is therefore counted in blocks, not
 * seconds (research audit F-05): a swap built ahead of the click, or one that waited on a question,
 * is used only while at least this many blocks are left (about 27 s today), and is built again
 * otherwise.
 */
const MIN_BLOCKS_FOR_WALLET = 100n;
/** A swap built ahead of the click is used only this soon after its build started (its price). */
const AHEAD_MAX_AGE_MS = 20_000;
/** A build ahead starts only once the amount has stayed the same this long (the owner's rule). */
const AHEAD_SETTLE_MS = 2_000;
/** And at most this many a minute, per page. */
const AHEAD_PER_MINUTE = 3;
/** The smallest swap Orientim takes, in dollars, when the price is known (the pipeline holds to it too). */
const MIN_SWAP_USD = 1;
/**
 * Under load. A price Jupiter refused as busy is asked for again this many times, later each time;
 * after a busy answer the page builds nothing ahead of the click for a while, because every user
 * of the site shares one Jupiter key and the builds nobody clicks on are the first thing to cut.
 */
const QUOTE_BUSY_RETRIES = 4;
const BUSY_BACKOFF_MS = 30_000;
/** Jupiter overloaded or silent (not the kill switch, which answers 503 with its own words). */
const jupiterBusy = (e: unknown) =>
  e instanceof JupiterError && (e.status === 429 || (e.status >= 500 && !/paused/i.test(e.message)));
const busyError = (e: unknown) => e instanceof OrientimError && (e.code === 'busy' || e.code === 'unavailable');
const UNREACHABLE = "Couldn't reach Orientim";

/**
 * Why a token cannot be swapped safely, in words rather than the name of a Token-2022 extension.
 */
const PLAIN_REFUSAL: Record<string, string> = {
  'transfer hook': 'it runs its own program on every transfer',
  'permanent delegate controlled by a program': 'a program can move it out of any wallet',
  'accounts frozen by default': 'new accounts of it start frozen',
  pausable: 'its issuer can pause all transfers',
  'non-transferable': "it can't be transferred",
  'interest-bearing': 'the balance a wallet shows differs from the amount on chain',
  'scaled UI amount': 'the balance a wallet shows differs from the amount on chain',
  'memo required on transfer': 'it requires a note on every transfer',
  'confidential mint and burn': 'its supply can change in ways the chain does not show',
  'pausable accounts': 'its issuer can pause transfers',
  'permissioned burn': 'it uses a burn rule Orientim has not reviewed yet',
};
const plainRefusal = (reason: string) => PLAIN_REFUSAL[reason] ?? `it uses ${reason}`;

/**
 * What a prepared swap costs beyond what the page showed before the click. It is said before the
 * wallet opens, because on a phone the wallet covers the page (review BR-03).
 */
function extrasOf(
  p: PreparedSwap,
  t: { inSymbol: string; outSymbol: string; inDecimals: number; shownSolFee: bigint | null },
): string[] {
  const lines: string[] = [];
  // A fee in SOL is priced when the swap is built. Asked about when the page did not show it before
  // the click, or showed less than it came to (engineering audit S1-M-02).
  if (p.policy.feeSide === 'sol' && p.policy.fee > 0n && (t.shownSolFee === null || p.policy.fee * 100n > t.shownSolFee * 105n)) {
    lines.push(
      `Orientim fee: ${formatExact(p.policy.fee, 9)} SOL from your wallet, ${Number(FEE_BPS) / 100}% of what this swap is worth in SOL now`
      + (t.shownSolFee !== null ? ` (the page estimated ~${formatExact(t.shownSolFee, 9)} SOL).` : '. Neither token of this pair can carry it.'),
    );
  }
  const { routeRent, routeRefund } = p.oneTimeCosts;
  // When closing the account returns all of it (PumpSwap), the market keeps nothing: nothing to ask.
  if (routeRent > 0n && routeRefund > 0n && routeRefund < routeRent) {
    lines.push(
      `Market account fee: ${formatExact(routeRent - routeRefund, 9)} SOL. This market takes ${formatExact(routeRent, 9)} SOL from every new buyer for an account; `
      + `Orientim closes that account in the same swap, so ${formatExact(routeRefund, 9)} SOL comes straight back to you.`,
    );
  } else if (routeRent > 0n && routeRefund === 0n) {
    lines.push(`Market account fee: ${formatExact(routeRent, 9)} SOL. This market charges it to every new buyer, and it does not come back.`);
  }
  if (p.tokenTax) {
    lines.push(`Token tax: ${formatExact(p.tokenTax.extraOnInput, t.inDecimals)} ${t.inSymbol} goes to the token's issuer, not to Orientim.`);
  }
  if (p.notices.removesDelegate) lines.push(`This also removes the spending permission you gave on your ${t.outSymbol} account.`);
  return lines;
}

/**
 * Identifies the inputs a build ahead of the click was made for, the minimum the user sees among
 * them: a build made for another fee side keeps another minimum (engineering review H-04).
 */
const aheadKey = (owner: string, input: string, output: string, amountIn: bigint, quotedAt: number, version: TxVersion, minReceived: bigint) =>
  [owner, input, output, String(amountIn), quotedAt, version, String(minReceived)].join('|');

/**
 * A build made ahead is used only if the output account still holds what its minimum was built on
 * (B and C: the check is that balance plus the minimum). Another swap into the same token since
 * then, even from another device, sends the click back to building. Null when the balance could not
 * be read: not a change, and not "unchanged" either.
 */
async function outputBalanceUnchanged(p: PreparedSwap): Promise<boolean | null> {
  const wOut = p.policy.accounts.wOut;
  if (!wOut) return true;
  const now = await fetchAccounts(getRpc(), [wOut]).then(m => tokenAmountOf(m.get(wOut)?.data)).catch(() => null);
  return now === null ? null : now === p.outputBalanceBefore;
}

/**
 * Blocks left in a prepared swap's lifetime, at the RPC's confirmed height, asked a few times; null
 * when the RPC cannot say at all.
 */
async function blocksLeft(p: PreparedSwap): Promise<bigint | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 400));
    const height = await getRpc().getBlockHeight({ commitment: 'confirmed' }).send().catch(() => null);
    if (height !== null) return p.lifetime.lastValidBlockHeight - BigInt(height);
  }
  return null;
}


/** What the confirmed transaction delivered (review BR-03), or null if the RPC does not say in time. */
async function actualReceived(signature: string, prepared: PreparedSwap): Promise<bigint | null> {
  for (let i = 0; i < 3; i++) {
    const tx = await getRpc()
      .getTransaction(signature as never, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: prepared.version } as never)
      .send()
      .catch(() => null);
    const meta = (tx as unknown as { meta?: ConfirmedMeta | null } | null)?.meta;
    if (meta) {
      return receivedFromMeta(meta, {
        owner: prepared.policy.owner, outputMint: prepared.policy.outputMint,
        solOutput: prepared.policy.variant === 'A', routeRent: prepared.policy.takerRent, routeRefund: prepared.policy.routeRefund,
      });
    }
    await new Promise(r => setTimeout(r, 1_000));
  }
  return null;
}
// A quote is refreshed every 20 s while the page is idle, and one older than 45 s is not offered
// (idea 23): the user always accepts a recent price.
const QUOTE_REFRESH_MS = 20_000;
const QUOTE_MAX_AGE_MS = 45_000;
/**
 * How many times a price refreshes on its own before the page waits to be asked. A tab left open
 * would otherwise ask for a price every 20 seconds for as long as it stays open, which is the
 * largest thing Orientim would spend its rate limit on and none of it is a swap.
 */
const AUTO_REFRESHES = 3;
/** Token amounts are 64-bit on Solana; beyond this nothing on chain can hold the balance. */
const MAX_U64 = 2n ** 64n - 1n;
const solscan = (signature: string) => `https://solscan.io/tx/${signature}`;
/** How often a swap the wallet waits on is looked up again (third audit, F2). */
const SETTLE_EVERY_MS = 10_000;
const SETTLE_BY_HAND_MS = 30_000;

/** Said when this browser will not keep a swap's record: without it, a swap whose answer is lost could be forgotten. */
const NO_STORAGE: Notice = {
  kind: 'error', title: "Your browser isn't saving this site's data",
  body: 'Orientim keeps every swap it sends in this browser, so that a lost connection or a closed tab never loses track of it. '
    + 'Allow site data (storage) for this site, or free some space, and try again. Nothing was sent and no funds moved.',
};

/** The words for a failure, with the raw error kept beside them (lib/client/problems). */
function explainError(e: unknown): Notice {
  return { ...wordsFor(e), detail: errorDetail(e) };
}

function wordsFor(e: unknown): Notice {
  if (e instanceof HistoryNotSaved) return NO_STORAGE;
  if (e instanceof OrientimError) {
    const titles: Record<OrientimError['code'], string> = {
      'unsupported-token': 'This token is not supported yet',
      'token-data-mismatch': "The token's data could not be confirmed on chain",
      'output-account-restricted': 'Your account for this token is restricted',
      'no-route': 'No protected route right now',
      'bad-quote': 'Only bad prices were offered',
      'price-moved': 'The price moved',
      'insufficient-sol': 'Not enough SOL',
      'costs-more': 'This route gives less than the best price',
      'simulation-failed': 'The swap would fail',
      'verification-failed': "We couldn't build a protected swap",
      'wallet-changed-transaction': 'Your wallet changed the transaction',
      expired: 'The swap expired',
      busy: 'Too many requests right now',
      unavailable: "The price service didn't answer",
      'insufficient-balance': 'Not enough of this token',
      'input-account-restricted': 'Your account for this token is restricted',
      'route-format': 'Protected swaps are waiting for an update',
      'fee-unavailable': "Orientim's fee can't be collected right now",
      'amount-too-small': 'This amount is too small',
      'network-unavailable': "Couldn't reach the network",
    };
    // Load or an upstream change, not the swap: the message already says that nothing was signed.
    if (e.code === 'busy' || e.code === 'unavailable' || e.code === 'route-format' || e.code === 'fee-unavailable' || e.code === 'network-unavailable') {
      return { kind: 'info', title: titles[e.code], body: e.message };
    }
    // The rule behind a refusal is for whoever investigates, not for the person swapping (final audit).
    if (e.violations.length) console.warn('Orientim refused this swap:', e.violations);
    const rules = '';
    if (e.code === 'wallet-changed-transaction') {
      const details = e.violations.map(v => v.detail);
      const title = details.includes('the wallet did not sign')
        ? "Your wallet didn't sign the transaction"
        : details.includes('the wallet changed the transaction message')
          ? 'Your wallet changed the transaction'
          : "Your wallet's response didn't pass the check";
      return { kind: 'error', title, body: `Orientim stopped before adding the last signature${rules}. Nothing was sent and no funds moved.` };
    }
    // A route can be priced perfectly and still not fit: 64 accounts per transaction is Solana's
    // limit, and a very large swap needs more pools than that.
    const title = e.code === 'no-route' && e.message.includes('does not fit')
      ? 'This amount is too large for one protected transaction'
      : titles[e.code];
    return { kind: 'error', title, body: `${e.message}${rules} No funds moved.` };
  }
  const message = String((e as Error)?.message ?? e);
  // An RPC failure is read from its HTTP status: a production build of kit replaces the message
  // with "Solana error #<code>", so its words cannot be matched.
  const http = httpStatusOf(e);
  if (/reject|denied|cancel|4001/i.test(message)) return { kind: 'info', title: 'Swap cancelled in your wallet', body: 'No funds moved.' };
  if (/paused/i.test(message)) return { kind: 'info', title: 'Protected swaps are paused', body: 'Nothing was sent. Your funds are not affected.' };
  if (http === 429 || (e instanceof JupiterError && e.status === 429)) {
    return { kind: 'info', title: 'Too many requests right now', body: 'Wait a few seconds and try again. Nothing was sent and no funds moved.' };
  }
  if (/ed25519/i.test(message)) {
    return { kind: 'error', title: "This browser can't create Orientim's one-time key", body: "Update it, or open Orientim in your wallet's browser. No funds moved." };
  }
  if ((http !== null && http >= 500) || jupiterBusy(e) || /failed to fetch|fetch failed|networkerror|load failed/i.test(message)) {
    return {
      kind: 'info', title: "Couldn't reach the network",
      body: 'The connection to Solana or the price service failed. Nothing was sent and no funds moved; try again in a moment.',
    };
  }
  // The raw error is for the console, not the page: it is rarely readable, and never actionable.
  console.error(e);
  return {
    kind: 'error', title: 'Something went wrong',
    body: 'Orientim stopped before adding its signature, so this swap can never run. No funds moved. Try again.',
  };
}

/**
 * What happened, in words that only claim what the network proved (audit C-03): "no funds moved"
 * appears only when the transaction was refused before broadcast or can no longer execute.
 */
function outcomeNotice(
  status: SendOutcome, signature: string, t: SwapTexts, why: { refusal?: SendRefusal; onPrice?: boolean } = {},
): Notice {
  const link = solscan(signature);
  switch (status) {
    case 'confirmed':
      return {
        kind: 'success', title: t.received ? `Swapped ${t.paid} for ${t.received}` : `Swapped ${t.paid} for at least ${t.minimum}`,
        body: `${t.received ? `At least ${t.minimum} was guaranteed. ` : ''}The swap could spend only ${t.exposed} from your wallet.`,
        link,
      };
    case 'failed':
      // The usual reason, and the one that needs no support: the market moved past the minimum.
      return why.onPrice
        ? {
          kind: 'error', title: 'The price moved before the swap landed',
          body: `Less than your minimum of ${t.minimum} would have arrived, so the swap reverted and nothing was swapped. Only the network fee was paid; you can try again.`,
          link,
        }
        : { kind: 'error', title: 'The swap failed on chain and was reverted', body: 'Only the network fee was paid.', link };
    case 'expired':
      return { kind: 'info', title: "The swap didn't land in time", body: 'It expired without executing and can no longer execute. No funds moved.', link };
    case 'rejected':
      if (why.refusal === 'paused') {
        return { kind: 'info', title: 'Protected swaps were paused', body: 'Orientim paused new swaps before this one was sent. It was never broadcast, so no funds moved.' };
      }
      if (why.refusal === 'busy') {
        return { kind: 'info', title: 'Too many requests right now', body: 'This swap was never broadcast, so no funds moved. Wait a few seconds and try again.' };
      }
      return {
        kind: 'info', title: 'Solana refused the swap before sending it',
        body: 'It was never broadcast, so no funds moved. This usually means the price moved; try again.',
      };
    default:
      return {
        kind: 'info', title: "We couldn't confirm the result yet",
        body: 'The swap may still go through or may already have. Orientim keeps checking, and starts no new swap from this wallet until the network settles it.', link,
      };
  }
}

/**
 * Pending or unknown swaps, settled from the chain (audit C-03): on every visit, and every few
 * seconds while one of them holds the wallet's next swap back (third audit, F2).
 */
async function settleHistory(): Promise<HistoryEntry[] | null> {
  const open = readHistory().filter(isUnsettled);
  if (!open.length) return null;
  const rpc = getRpc();
  const signatures = open.map(h => h.signature);
  // One coherent view (engineering audit S1-H-01): the statuses come from a node that had reached
  // the finalized slot whose height they are compared with; a lagging node proves no expiry (FA-07).
  const first = await statusesCovering(rpc, signatures);
  // Once the recorded lifetime is over, look again: one empty read is not enough evidence for the UI
  // to invite a retry, and the second view must prove it too (the lower covered height, the higher
  // reach: the two together must still hold every block the swap could have landed in).
  const needsSecondLookup = open.some((h, i) =>
    settledHistoryStatus(h, first.statuses[i] as SignatureState, first) === 'expired');
  const second = needsSecondLookup ? await statusesCovering(rpc, signatures) : null;
  const lower = (a: bigint | null, b: bigint | null) => (a === null || b === null ? null : a < b ? a : b);
  const higher = (a: bigint | null, b: bigint | null) => (a === null || b === null ? null : a > b ? a : b);
  const view = !second ? first : {
    coveredHeight: lower(first.coveredHeight, second.coveredHeight),
    reachHeight: higher(first.reachHeight, second.reachHeight),
  };
  let list: HistoryEntry[] | null = null;
  for (const [i, h] of open.entries()) {
    const state = (first.statuses[i] ?? second?.statuses[i] ?? null) as SignatureState;
    const next: HistoryStatus | null = settledHistoryStatus(h, state, view);
    if (next) list = updateHistory(h.signature, next);
    // It can no longer land, and nothing proves whether it did: unknown until someone looks it up.
    else if (lifetimeOver(h, view) && !h.over) list = updateHistory(h.signature, 'unknown', undefined, { over: true });
  }
  return list;
}

export function SwapApp() {
  const wallets = useWallets();
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [popular, setPopular] = useState<TokenInfo[]>([]);
  const [tokenIn, setTokenIn] = useState<TokenInfo | null>(null);
  const [tokenOut, setTokenOut] = useState<TokenInfo | null>(null);
  const [picking, setPicking] = useState<'in' | 'out' | null>(null);
  const [amountText, setAmountText] = useState('');
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [walletMenu, setWalletMenu] = useState(false);
  // The connected wallet's menu (copy the address, disconnect), as swap sites have it.
  const [accountMenu, setAccountMenu] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  // The rate reads "1 input ≈ x output" until the user turns it around.
  const [rateInverted, setRateInverted] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [balances, setBalances] = useState<{ sol: bigint; tokenIn: bigint } | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [detailsCopied, setDetailsCopied] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  // What the chain says about each selected mint: decimals and token program (audit C-01).
  const [facts, setFacts] = useState<Record<string, MintFacts | 'missing'>>({});
  // Accounts that decide the Orientim fee and the one-time costs shown before signing (audit B-09).
  /** Where the Orientim fee is taken, like Jupiter's: SOL first, then USDC and USDT, on either side; else the input. */
  const [feeSide, setFeeSide] = useState<FeeSide | null>('input');
  const [clock, setClock] = useState(0);
  const [refreshes, setRefreshes] = useState(0);
  // How many times in a row Jupiter refused the price as busy, and until when nothing is built ahead.
  const [busyTries, setBusyTries] = useState(0);
  const busyUntil = useRef(0);
  const balanceRequest = useRef(0);
  const decideOffer = useRef<((accept: boolean) => void) | null>(null);

  const W = account ? (account.address as Address) : null;
  // The mint owner is the token program. It is part of every ATA derivation, so keep these facts
  // beside the selected tokens instead of falling back to the classic program while they load.
  const inFacts = tokenIn ? facts[tokenIn.id] : undefined;
  const outFacts = tokenOut ? facts[tokenOut.id] : undefined;

  // --- every message other than a success is kept in this browser with the raw error behind it, so
  // one replaced by the next click can still be read (lib/client/problems). Nothing is sent anywhere.
  const shown = useRef<Problem | null>(null);
  useEffect(() => watchUncaught(), []);
  useEffect(() => {
    setDetailsCopied(false);
    if (!notice || notice.kind === 'success') return;
    const pair = tokenIn && tokenOut ? `${amountText || '?'} ${tokenIn.symbol} → ${tokenOut.symbol}` : 'no pair';
    const who = wallet ? `${wallet.name} ${wallet.version}` : 'no wallet';
    shown.current = {
      at: Date.now(), kind: notice.kind, title: notice.title, body: notice.body, detail: notice.detail,
      context: `${pair}, ${who}${notice.link ? `, ${notice.link}` : ''}`,
    };
    recordProblem(shown.current);
    // Recorded once per message; the pair and wallet are read as they are when it appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice]);

  function copyDetails() {
    if (!shown.current) return;
    navigator.clipboard.writeText(problemsReport([shown.current], navigator.userAgent))
      .then(() => setDetailsCopied(true), () => setDetailsCopied(false));
  }

  // --- bootstrap
  // The page's settings and the kill switch. Without them nothing can be swapped, so a failure is
  // retried, later each time, instead of leaving the button on "Loading limits…" for good.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      fetch('/api/status')
        .then(r => {
          if (!r.ok) throw new Error(`status ${r.status}`);
          return r.json() as Promise<PublicStatus>;
        })
        .then(s => {
          if (stopped) return;
          setStatus(s);
          setNotice(n => (n?.title === UNREACHABLE ? null : n));
        })
        .catch(() => {
          if (stopped) return;
          if (attempt === 0) setNotice({ kind: 'error', title: UNREACHABLE, body: 'Check your connection. Trying again…' });
          timer = setTimeout(() => load(attempt + 1), Math.min(30_000, 2_000 * 2 ** attempt));
        });
    };
    load(0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    loadTokens(POPULAR)
      .then(list => {
        setPopular(list);
        setTokenIn(list.find(t => t.id === USDC_MINT) ?? null);
        setTokenOut(list.find(t => t.id === SOL_MINT) ?? null);
      })
      .catch(() => setNotice({ kind: 'error', title: "Couldn't load the token list", body: 'Check your connection and reload.' }));
    setHistory(readHistory());
    settleHistory().then(list => list && setHistory(list)).catch(() => undefined);
  }, []);

  // --- on-chain facts for the selected tokens
  useEffect(() => {
    for (const t of [tokenIn, tokenOut]) {
      if (!t || facts[t.id]) continue;
      readMint(t.id)
        .then(f => setFacts(prev => ({ ...prev, [t.id]: f ?? 'missing' })))
        .catch(() => undefined);
    }
  }, [tokenIn, tokenOut, facts]);

  // --- wallet account changes
  useEffect(() => {
    if (!wallet) return;
    return onAccountChange(wallet, accounts => {
      const next = accounts[0] ?? null;
      setAccount(next);
      if (!next) setWallet(null);
    });
  }, [wallet]);

  const refreshBalances = useCallback(async () => {
    const request = ++balanceRequest.current; // only the latest request may set balances (C-10)
    if (!W || !tokenIn || !inFacts || inFacts === 'missing') return setBalances(null);
    const rpc = getRpc();
    const sol = (await rpc.getBalance(W, { commitment: 'confirmed' }).send()).value;
    let tokenBalance: bigint = sol;
    if (tokenIn.id !== SOL_MINT) {
      try {
        const ata = await mintAta(W, tokenIn.id, inFacts);
        tokenBalance = BigInt((await rpc.getTokenAccountBalance(ata, { commitment: 'confirmed' }).send()).value.amount);
      } catch {
        tokenBalance = 0n;
      }
    }
    if (request === balanceRequest.current) setBalances({ sol, tokenIn: tokenBalance });
  }, [W, tokenIn, inFacts]);

  useEffect(() => {
    refreshBalances().catch(() => setBalances(null));
  }, [refreshBalances]);

  // The fee is taken like Jupiter's: in SOL first, then USDC or USDT, on whichever side of the swap
  // the treasury can receive them; otherwise in the input token; otherwise not at all (Orientim never
  // makes the user pay rent for Orientim's account). A new output account's deposit is Solana's and
  // stays the user's, as on every swap site, so it is not listed as a cost (the owner's choice).
  const refreshAccounts = useCallback(async () => {
    const exists = async (a: Address) =>
      (await getRpc().getAccountInfo(a, { encoding: 'base64', commitment: 'confirmed' }).send()).value !== null;
    // A fee account frozen by the token's issuer cannot receive, so that swap is fee-free (FA-12).
    const receives = async (a: Address) => {
      const { value } = await getRpc().getAccountInfo(a, { encoding: 'base64', commitment: 'confirmed' }).send();
      if (!value) return false;
      const data = Uint8Array.from(atob((value.data as unknown as [string, string])[0]), c => c.charCodeAt(0));
      return !(data.length > 108 && data[108] === 2);
    };
    // The treasury wallet receives a fee in SOL: on a pair with SOL, and on one that neither token
    // can carry the fee for, which pays it in SOL from the wallet.
    const walletReady = !!TREASURY && await exists(TREASURY).catch(() => false);
    const inputOk = !!TREASURY && !!tokenIn && tokenIn.id !== SOL_MINT && !!inFacts && inFacts !== 'missing'
      && await receives(await mintAta(TREASURY, tokenIn.id, inFacts));
    const outputOk = !!TREASURY && !!tokenOut && tokenOut.id !== SOL_MINT && FEE_TOKENS.includes(tokenOut.id)
      && !!outFacts && outFacts !== 'missing' && await receives(await mintAta(TREASURY, tokenOut.id, outFacts));
    const fee = TREASURY && tokenIn && tokenOut
      ? feeSideFor(address(tokenIn.id), address(tokenOut.id), {
        input: tokenIn.id === SOL_MINT ? walletReady : inputOk,
        output: tokenOut.id === SOL_MINT ? walletReady : outputOk,
        sol: walletReady,
      })
      : null;
    return { fee };
  }, [tokenIn, tokenOut, inFacts, outFacts]);

  useEffect(() => {
    let cancelled = false;
    refreshAccounts()
      .then(r => {
        if (cancelled) return;
        setFeeSide(r.fee);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshAccounts]);

  // --- amounts, always with the mints' on-chain decimals (audit C-01)
  const inDecimals = inFacts && inFacts !== 'missing' ? inFacts.decimals : null;
  const outDecimals = outFacts && outFacts !== 'missing' ? outFacts.decimals : null;
  const chargesFee = !!TREASURY && feeSide !== null;
  const amountIn = tokenIn && inDecimals !== null ? parseUnits(amountText, inDecimals) : null;
  // A fee on the input comes out of the amount; a fee on the output out of what arrives.
  const fee = amountIn && chargesFee && feeSide === 'input' ? feeFor(amountIn, { feeBps: FEE_BPS, treasury: TREASURY }) : 0n;
  const swapAmount = amountIn ? amountIn - fee : null;
  const outputFee = chargesFee && feeSide === 'output' && quote ? outputFeeFor(quote.minOut, FEE_BPS) : null;
  // The minimum the page shows, what the wallet keeps after a fee from the output: the one a build
  // must hold to, whichever side the fee turns out to be on when it is built (engineering review H-04).
  const minReceived = quote ? quote.minOut - (outputFee ?? 0n) : null;
  const price = usablePrice(tokenIn);
  const usdValue = amountIn && price !== null && inDecimals !== null ? (Number(amountIn) / 10 ** inDecimals) * price : null;
  // A fee in SOL is priced when the swap is built; before that it is estimated from USD prices.
  const solPrice = usablePrice(popular.find(t => t.id === SOL_MINT) ?? null);
  const solFeeEstimate = chargesFee && feeSide === 'sol' && usdValue !== null && solPrice !== null
    ? BigInt(Math.floor(((usdValue * Number(FEE_BPS)) / 10_000 / solPrice) * 1e9)) : null;

  // --- a clock for quote freshness: ticks while the page is visible and idle, and only until the
  // price has refreshed itself a few times. After that the page waits for the user.
  useEffect(() => {
    // Nothing to refresh until an amount is entered, so an idle visitor costs nothing at all.
    if (phase !== 'idle' || refreshes >= AUTO_REFRESHES || !swapAmount) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setClock(c => c + 1);
      setRefreshes(n => n + 1);
    }, QUOTE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [phase, refreshes, swapAmount]);

  /** Asked for by the user, so the count starts again. */
  const refreshNow = () => {
    setRefreshes(0);
    setBusyTries(0);
    setClock(c => c + 1);
  };

  // --- live quote (price only; the protected transaction is built and verified on click)
  useEffect(() => {
    // On a refresh tick the current quote stays on screen until the new one arrives.
    if (!tokenIn || !tokenOut || !swapAmount || swapAmount <= 0n || tokenIn.id === tokenOut.id) return setQuote(null);
    let cancelled = false;
    setQuoting(true);
    const timer = setTimeout(() => {
      getJupiter()
        .build({
          // The same amount the swap itself will route: what is left after the token's own tax.
          inputMint: address(tokenIn.id), outputMint: address(tokenOut.id),
          amount: amountReachingRoute(swapAmount, inFacts === 'missing' ? null : inFacts),
          taker: address(QUOTE_TAKER), slippageBps: DEFAULT_SETTINGS.slippageBps, maxAccounts: 64,
          excludeDexes: status?.excludeDexes ?? DEFAULT_SETTINGS.excludeDexes,
        })
        .then(r => {
          if (cancelled) return;
          setBusyTries(0);
          // Shown only if it answers this exact trade; the minimum is computed by Orientim (C-02), with
          // the wider tolerance when the route trades on a Pump.fun bonding curve.
          const routed = amountReachingRoute(swapAmount, inFacts === 'missing' ? null : inFacts);
          const answersThis = r.inputMint === tokenIn.id && r.outputMint === tokenOut.id && BigInt(r.inAmount) === routed;
          setQuote(answersThis
            ? {
              out: BigInt(r.outAmount), minOut: quotedMinimum(r, DEFAULT_SETTINGS), curve: isCurveRoute(r),
              impact: Number.isFinite(Number(r.priceImpactPct)) ? Math.max(0, Number(r.priceImpactPct)) : 0, at: Date.now(),
            }
            : null);
        })
        .catch(e => {
          if (cancelled) return;
          // Busy is not "no price": the price on screen stays while it is fresh, and it is asked
          // for again shortly.
          if (jupiterBusy(e)) {
            busyUntil.current = Date.now() + BUSY_BACKOFF_MS;
            setBusyTries(n => n + 1);
            return;
          }
          setQuote(null);
        })
        .finally(() => !cancelled && setQuoting(false));
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setQuoting(false);
    };
  }, [tokenIn, tokenOut, swapAmount, status, clock, inFacts]);

  // A change of pair or amount makes the shown quote meaningless at once, and it is the user
  // acting, so the automatic refreshes start over.
  useEffect(() => {
    setQuote(null);
    setRefreshes(0);
    setBusyTries(0);
  }, [tokenIn, tokenOut, swapAmount]);

  // A price refused as busy is asked for again, later each time and at a random moment, so the pages
  // refused together do not all come back together.
  useEffect(() => {
    if (busyTries === 0 || busyTries > QUOTE_BUSY_RETRIES || phase !== 'idle') return;
    const wait = Math.min(30_000, 2_000 * 2 ** (busyTries - 1)) * (0.5 + Math.random());
    const timer = setTimeout(() => setClock(c => c + 1), wait);
    return () => clearTimeout(timer);
  }, [busyTries, phase]);

  // --- what blocks the swap button
  const blocker = useMemo((): string | null => {
    if (status && !status.enabled) return 'Protected swaps are paused';
    if (!W) return null;
    // A swap from this wallet that the chain has not settled holds the next one back, whatever the
    // time: a retry waits for the chain's answer, so the same swap never runs twice (third audit, F2).
    if (unsettledFor(history, W).length) return 'Waiting for your last swap';
    if (!tokenIn || !tokenOut) return 'Select tokens';
    if (tokenIn.id === tokenOut.id) return 'Choose two different tokens';
    if (inFacts === 'missing' || outFacts === 'missing') return 'That address is not a token';
    if (!inFacts || !outFacts) return 'Reading token details…';
    const refused = inFacts.unsupported ?? outFacts.unsupported;
    if (refused) return `Orientim can't swap this token safely: ${plainRefusal(refused)}`;
    if (!amountIn || amountIn <= 0n) return 'Enter an amount';
    if (amountIn > MAX_U64) return 'Amount is too large';
    if (swapAmount !== null && swapAmount <= 0n) return 'Amount is too small';
    // Said before anything is asked of Jupiter or the chain; the pipeline holds to it too.
    if (TREASURY && usdValue !== null && usdValue < MIN_SWAP_USD) return `Minimum swap: ${formatUsd(MIN_SWAP_USD)}`;
    if (balances && amountIn > balances.tokenIn) return `Insufficient ${tokenIn.symbol}`;
    const solNeeded = SOL_RESERVE_LAMPORTS + (tokenIn.id === SOL_MINT ? amountIn : 0n);
    if (balances && balances.sol < solNeeded) return 'Not enough SOL for network fees';
    // Any amount is protected the same way, so there is no cap of our own. When an operator does
    // configure one it fails closed: a token without a USD price cannot be checked (B-05).
    if (!status) return 'Loading limits…';
    if (status.maxUsdPerSwap !== null) {
      if (usdValue === null) return `No USD price for ${tokenIn.symbol} yet`;
      if (usdValue > status.maxUsdPerSwap) return `Limit: ${formatUsd(status.maxUsdPerSwap)} per swap`;
    }
    // The user accepts a minimum they have seen; without a price there is nothing to accept (C-02).
    if (!quote) {
      if (quoting) return 'Getting a price…';
      if (busyTries > QUOTE_BUSY_RETRIES) return 'Prices are busy right now';
      return busyTries > 0 ? 'Prices are busy, retrying…' : 'No price for this pair right now';
    }
    if (Date.now() - quote.at > QUOTE_MAX_AGE_MS) {
      return refreshes >= AUTO_REFRESHES ? 'Refresh the price to continue' : 'Refreshing price…';
    }
    return null;
    // `clock` re-evaluates the age of the quote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, W, tokenIn, tokenOut, inFacts, outFacts, amountIn, swapAmount, balances, usdValue, quote, quoting, clock, refreshes, busyTries, history]);

  // --- another tab of this page may record or settle a swap: its history is this tab's too, so a swap
  // started there holds this wallet back here as well (third audit, F2).
  useEffect(() => {
    const sync = (e: StorageEvent) => {
      if (e.key === HISTORY_KEY) setHistory(readHistory());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  // --- a swap this wallet waits on is looked up again while the page is visible: every 10 s while it
  // could still land or be proven expired, every 30 s once only a full history could tell (F2).
  const waitingOn = W ? unsettledFor(history, W) : [];
  const onlyByHand = waitingOn.length > 0 && waitingOn.every(h => h.over);
  useEffect(() => {
    if (!waitingOn.length || phase !== 'idle') return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      settleHistory().then(list => list && setHistory(list)).catch(() => undefined);
    }, onlyByHand ? SETTLE_BY_HAND_MS : SETTLE_EVERY_MS);
    return () => clearInterval(timer);
  }, [waitingOn.length, onlyByHand, phase]);

  // --- connect
  async function connect(w: Wallet) {
    setWalletMenu(false);
    try {
      const acc = await connectWallet(w);
      if (!acc) throw new Error('The wallet returned no account');
      setWallet(w);
      setAccount(acc);
      setNotice(null);
    } catch (e) {
      setNotice(explainError(e));
    }
  }

  async function disconnect() {
    setAccountMenu(false);
    if (wallet) await disconnectWallet(wallet).catch(() => undefined);
    setWallet(null);
    setAccount(null);
    setBalances(null);
  }

  useEffect(() => {
    if (!accountMenu) return;
    const outside = (e: MouseEvent) => {
      if (!accountRef.current?.contains(e.target as Node)) setAccountMenu(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setAccountMenu(false);
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', onKey);
    };
  }, [accountMenu]);

  function copyAddress() {
    if (!W) return;
    navigator.clipboard.writeText(W).then(() => setAddressCopied(true), () => setAddressCopied(false));
    setTimeout(() => setAddressCopied(false), 1_500);
  }

  /** Shows the new minimum and waits for the user; no answer within 45 s counts as no. */
  function askAboutOffer(o: Offer): Promise<boolean> {
    setOffer(o);
    setPhase('confirm');
    return new Promise(resolve => {
      const finish = (accept: boolean) => {
        clearTimeout(timer);
        decideOffer.current = null;
        setOffer(null);
        resolve(accept);
      };
      const timer = setTimeout(() => finish(false), OFFER_TIMEOUT_MS);
      decideOffer.current = finish;
    });
  }

  /**
   * Builds the protected swap with the minimum the user accepted. If the market moved beyond the
   * tolerance, the user sees the new minimum and decides; it is never lowered silently (C-02).
   */
  /** The pipeline's dependencies, with the fee fixed at build time and the server's limits. */
  const swapDeps = (s: PublicStatus) => ({
    rpc: getRpc(),
    jupiter: getJupiter(),
    settings: {
      ...DEFAULT_SETTINGS,
      feeBps: FEE_BPS,
      treasury: TREASURY,
      excludeDexes: s.excludeDexes,
      maxNetworkFeeLamports: BigInt(s.maxNetworkFeeLamports),
      jupiterProgram: JUPITER_PROGRAM,
      // The smallest swap, about $1: none costs more to build than its fee brings.
      ...(TREASURY ? { minFee: MIN_FEE } : {}),
    },
  });

  async function prepareAccepted(args: {
    E: KeyPairSigner; owner: Address; inToken: TokenInfo; outToken: TokenInfo; amountIn: bigint;
    /** The minimum the user accepted, as shown: what the wallet keeps after a fee from the output. */
    inDecimals: number; outDecimals: number; acceptedMinReceived: bigint; version: TxVersion; status: PublicStatus;
    expectCurve: boolean; v1Fallback: boolean;
  }): Promise<PreparedSwap | null> {
    let accepted = args.acceptedMinReceived;
    let acceptedCost: bigint | undefined;
    let version = args.version;
    for (let round = 0; ; round++) {
      try {
        return await prepareProtectedSwap(
          swapDeps(args.status),
          {
            owner: args.owner, ephemeral: args.E, inputMint: address(args.inToken.id), outputMint: address(args.outToken.id),
            amountIn: args.amountIn, inputDecimals: args.inDecimals, outputDecimals: args.outDecimals,
            acceptedMinReceived: accepted, acceptedCostBps: acceptedCost, version, expectCurve: args.expectCurve,
          },
        );
      } catch (e) {
        if (!(e instanceof OrientimError) || round >= 2) throw e;
        // A route too big for v0 may fit in v1, for a wallet that signs it (research audit F-13).
        if (e.code === 'no-route' && e.message.includes('does not fit') && version === 0 && args.v1Fallback) {
          version = 1;
          continue;
        }
        if (e.code === 'price-moved' && e.priceMoved) {
          const symbol = args.outToken.symbol;
          // What the wallet keeps, after a fee taken from the output, like every minimum here.
          const accept = await askAboutOffer({
            kind: 'price',
            was: `${formatExact(accepted, args.outDecimals)} ${symbol}`,
            now: `${formatExact(e.priceMoved.newMinReceived, args.outDecimals)} ${symbol}`,
          });
          if (!accept) return null;
          accepted = e.priceMoved.newMinReceived;
          setPhase('checking');
          continue;
        }
        // The route that fits costs more than the unrestricted market price: that difference is
        // the price of the protection, so the user decides whether to pay it.
        if (e.code === 'costs-more' && e.costsMore) {
          const accept = await askAboutOffer({
            kind: 'cost',
            gap: `${(Number(e.costsMore.gapBps) / 100).toFixed(2)}%`,
            severe: e.costsMore.gapBps > DEFAULT_SETTINGS.warnAboveBps,
          });
          if (!accept) return null;
          acceptedCost = e.costsMore.gapBps;
          setPhase('checking');
          continue;
        }
        throw e;
      }
    }
  }

  // --- built ahead of the click (latency). While the user looks at a quote, the swap for it is
  // built and verified with its own one-time key, so the click opens the wallet at once. Nothing is
  // signed or sent: a build nobody clicks on expires with its blockhash. No question is asked here;
  // a build that would need one (price moved, costs more) is dropped, and the click asks as before.
  // Built once per amount, for its first price (and again when the user refreshes it), not on every
  // automatic refresh; and not while Jupiter is busy, since a build nobody clicks on still spends
  // the site's shared quota.
  //
  // What a build ahead may cost (the owner's rule): it starts only once the amount has stayed the same
  // for AHEAD_SETTLE_MS, one at a time, and at most AHEAD_PER_MINUTE a minute. Someone trying amounts
  // costs a build or two, not one per keystroke; the click builds as before when none is ready.
  const ahead = useRef<{ key: string; startedAt: number; settled: boolean; task: Promise<{ prepared: PreparedSwap; E: KeyPairSigner } | null> } | null>(null);
  const aheadStarts = useRef<number[]>([]);
  // The build ahead passed every rule for exactly these inputs: the card may say "Verified" (and only then).
  const [verifiedKey, setVerifiedKey] = useState<string | null>(null);
  const [aheadSettledAt, setAheadSettledAt] = useState(0);
  useEffect(() => {
    if (phase !== 'idle' || blocker || !wallet || !W || !tokenIn || !tokenOut || !amountIn || !quote || !status || minReceived === null) return;
    if (inDecimals === null || outDecimals === null) return;
    if (refreshes !== 0 || Date.now() < busyUntil.current) return;
    const version = chooseVersion(supportedVersions(wallet), V1_ENABLED);
    if (version === null) return;
    const key = aheadKey(W, tokenIn.id, tokenOut.id, amountIn, quote.at, version, minReceived);
    if (ahead.current?.key === key) return;
    // One at a time: a build still running for an older amount is left to finish, then this runs again.
    if (ahead.current && !ahead.current.settled) return;
    const now = Date.now();
    aheadStarts.current = aheadStarts.current.filter(t => now - t < 60_000);
    if (aheadStarts.current.length >= AHEAD_PER_MINUTE) return;
    const request = {
      owner: W, inputMint: address(tokenIn.id), outputMint: address(tokenOut.id), amountIn,
      inputDecimals: inDecimals, outputDecimals: outDecimals, acceptedMinReceived: minReceived, expectCurve: quote.curve, version,
    };
    const timer = setTimeout(() => {
      aheadStarts.current.push(Date.now());
      const entry = { key, startedAt: Date.now(), settled: false, task: null as unknown as Promise<{ prepared: PreparedSwap; E: KeyPairSigner } | null> };
      entry.task = (async () => {
        const E = await createEphemeral();
        return { prepared: await prepareProtectedSwap(swapDeps(status), { ...request, ephemeral: E }), E };
      })().then(built => {
        setVerifiedKey(key);
        return built;
      }).catch((e: unknown) => {
        if (busyError(e)) busyUntil.current = Date.now() + BUSY_BACKOFF_MS;
        return null;
      }).finally(() => {
        entry.settled = true;
        setAheadSettledAt(Date.now());
      });
      ahead.current = entry;
    }, AHEAD_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [phase, blocker, wallet, W, tokenIn, tokenOut, amountIn, quote, status, inDecimals, outDecimals, refreshes, minReceived, aheadSettledAt]);

  // --- the protected swap: build + verify → wallet signs first → re-verify → E signs last → send
  async function swap() {
    if (!wallet || !account || !W || !tokenIn || !tokenOut || !amountIn || !status || !quote || minReceived === null || blocker) return;
    if (inDecimals === null || outDecimals === null) return;
    const inToken = tokenIn;
    const outToken = tokenOut;
    const version: TxVersion | null = chooseVersion(supportedVersions(wallet), V1_ENABLED);
    if (version === null) {
      setNotice({
        kind: 'error', title: `${wallet.name} can't sign this kind of transaction`,
        body: 'Orientim needs a wallet that supports versioned transactions. Nothing was signed.',
      });
      return;
    }
    // A swap is sent only once its record is kept, so this browser must keep one: asked before the
    // wallet opens, not after the user signed (third audit, F3).
    if (!historyWorks()) {
      setNotice(NO_STORAGE);
      return;
    }
    // Decision A: one Orientim swap at a time into the same token, across tabs.
    const lock = acquireSwapLock(W, outToken.id);
    if (!lock) {
      setNotice({
        kind: 'info', title: `Another swap into ${outToken.symbol} is still open`,
        body: 'Wait until it finishes (it may be in another tab), then try again. Nothing was signed.',
      });
      return;
    }

    setNotice(null);
    setPhase('checking');
    const sent: { signature: string | null } = { signature: null };
    let settled = true;
    const texts: SwapTexts = { paid: `${formatUnits(amountIn, inDecimals)} ${inToken.symbol}`, received: '', exposed: '', minimum: '' };
    const cancelled = () => setNotice({ kind: 'info', title: 'Swap cancelled', body: 'Nothing was signed and no funds moved.' });
    // A build made ahead of the click is used at most once.
    const early = ahead.current;
    ahead.current = null;
    try {
      // Every build holds to the minimum the user saw, net of a fee from the output (H-04), and a fee
      // in SOL to the estimate the user saw, if any (S1-M-02).
      const shown = minReceived;
      const shownSolFee = feeSide === 'sol' ? solFeeEstimate : null;
      const build = (E: KeyPairSigner, acceptedMinReceived: bigint) => prepareAccepted({
        E, owner: W, inToken, outToken, amountIn, inDecimals, outDecimals, acceptedMinReceived, version, status, expectCurve: quote.curve,
        v1Fallback: v1Fallback(supportedVersions(wallet), V1_ENABLED),
      });
      // A large price impact is asked about before anything is built, as other swap pages do.
      if (quote.impact >= IMPACT_ASK) {
        if (!(await askAboutOffer({ kind: 'impact', pct: impactText(quote.impact) }))) return cancelled();
        setPhase('checking');
      }
      // The swap built while the user looked at this quote, if it is recent, is for exactly these
      // inputs and its output balance has not moved since; otherwise it is built now.
      const reused = early && early.key === aheadKey(W, inToken.id, outToken.id, amountIn, quote.at, version, shown)
        && Date.now() - early.startedAt < AHEAD_MAX_AGE_MS ? await early.task : null;
      // Its output balance and its time left, read together: one round trip.
      const [unchanged, left] = reused
        ? await Promise.all([outputBalanceUnchanged(reused.prepared), blocksLeft(reused.prepared)])
        : [false, null];
      const fresh = reused && unchanged && left !== null && left >= MIN_BLOCKS_FOR_WALLET ? reused : null;
      const E = fresh ? fresh.E : await createEphemeral();
      let prepared = fresh ? fresh.prepared : await build(E, shown);
      if (!prepared) return cancelled();
      // Costs the page did not show before the click are shown before the wallet opens (BR-03).
      const facts = { inSymbol: inToken.symbol, outSymbol: outToken.symbol, inDecimals, shownSolFee };
      const extras = extrasOf(prepared, facts);
      if (extras.length && !(await askAboutOffer({ kind: 'extras', lines: extras }))) return cancelled();
      // However it got here (a build ahead, a fresh build that took long, a question), the wallet opens
      // only with at least 100 blocks of the swap's life left. One that ran low is built again, and
      // asked about again only if it costs more than what was accepted (M-06, engineering audit S1-M-03).
      for (let round = 0; ; round++) {
        const left = await blocksLeft(prepared);
        // Without a height, how long the swap stays valid is unknown: the wallet is not opened on a
        // guess (final audit, M-04).
        if (left === null) {
          throw new OrientimError('network-unavailable', "Orientim couldn't read how long this swap stays valid, so your wallet was not opened. Nothing was signed; try again in a moment.");
        }
        if (left >= MIN_BLOCKS_FOR_WALLET) break;
        if (round === 2) throw new OrientimError('expired', "The swap's time ran out while it was being prepared or while you answered. Nothing was signed; try again.");
        setPhase('checking');
        const again = await build(E, prepared.quote.minReceived);
        if (!again) return cancelled();
        if (costsMoreThan(again, prepared) && !(await askAboutOffer({ kind: 'extras', lines: extrasOf(again, facts) }))) return cancelled();
        prepared = again;
      }
      texts.minimum = `${formatExact(prepared.quote.minReceived, outDecimals)} ${outToken.symbol}`;
      texts.exposed = `${formatUnits(prepared.policy.swapAmount, inDecimals)} ${inToken.symbol}`;
      // What the market keeps: the rent it takes, less what closing its account returns (FA-05).
      const routeRent = keptByMarket(prepared);
      setPending({
        minReceived: `${formatExact(prepared.quote.minReceived, outDecimals)} ${outToken.symbol}`,
        networkFee: `${formatExact(prepared.networkFeeLamports, 9)} SOL`,
        // Pump.fun charges every new buyer a small account deposit, and it does not come back.
        oneTimeCost: routeRent > 0n ? `${formatExact(routeRent, 9)} SOL account fee charged by this market` : null,
        busyNetwork: prepared.priorityFeeCapped
          ? 'The network is busy and the network fee is at its limit, so this swap may take longer to land, or expire without executing. An expired swap costs nothing.'
          : null,
        removesDelegate: prepared.notices.removesDelegate
          ? `It also removes an existing spending permission (delegate) on your ${outToken.symbol} account.`
          : null,
        tokenTax: prepared.tokenTax
          ? `${inToken.symbol} charges ${prepared.tokenTax.inputBps / 100}% on every transfer. Moving your ${inToken.symbol} into the protected account costs `
            + `${formatExact(prepared.tokenTax.extraOnInput, inDecimals)} ${inToken.symbol} of that tax, which goes to the token, not to Orientim.`
          : null,
        solFee: prepared.policy.feeSide === 'sol' && prepared.policy.fee > 0n
          ? `${formatExact(prepared.policy.fee, 9)} SOL`
          : null,
      });
      setPhase('wallet');
      lock.refresh();
      const toSend = prepared;
      const signed = await walletSign(wallet, account, new Uint8Array(getTransactionEncoder().encode(toSend.transaction)), toSend.contextSlot);

      // The minimum is checked on chain as W_out's balance before plus the minimum. If that balance
      // moved while the wallet was open (another swap into this token, from another device, or a
      // transfer), the check could count those tokens: stop before E signs (review FA-04).
      const balanceKept = await outputBalanceUnchanged(toSend);
      if (balanceKept === null) {
        setNotice({
          kind: 'info', title: `Orientim couldn't re-read your ${outToken.symbol} balance`,
          body: 'It stopped before adding its signature, so this swap can never run. No funds moved; try again in a moment.',
        });
        return;
      }
      if (!balanceKept) {
        setNotice({
          kind: 'info', title: `Your ${outToken.symbol} balance changed while the wallet was open`,
          body: 'Another swap or a transfer arrived. Orientim stopped before adding its signature, so this swap can never run. No funds moved; try again.',
        });
        return;
      }
      setPhase('sending');
      lock.refresh();
      const result = await finalizeProtectedSwap({
        rpc: getRpc(), prepared: toSend, walletSignedBytes: signed, ephemeral: E,
        onStatus: (s, signature) => {
          if (s !== 'sending') return;
          // Recorded before anything is sent, and never sent unless recorded, so it is never lost
          // (C-03, third audit F3): `addHistory` throws when this browser did not keep the record,
          // and the send stops before its first request.
          setHistory(addHistory({
            at: Date.now(), signature, status: 'pending', owner: W,
            lastValidBlockHeight: toSend.lifetime.lastValidBlockHeight.toString(),
            ...texts, received: `at least ${texts.minimum}`,
          }));
          sent.signature = signature;
        },
      });
      if (result.status === 'confirmed') {
        const got = await actualReceived(result.signature, toSend);
        if (got !== null) texts.received = `${formatExact(got, outDecimals)} ${outToken.symbol}`;
      }
      setHistory(updateHistory(result.signature, result.status, texts.received || undefined));
      settled = result.status !== 'unknown';
      const onPrice = result.status === 'failed' && revertedOnPrice(toSend.transaction, result.error, JUPITER_PROGRAM);
      setNotice(outcomeNotice(result.status, result.signature, texts, { refusal: result.refusal, onPrice }));
      if (result.status === 'confirmed') setAmountText('');
    } catch (e) {
      if (sent.signature) {
        // It may have been broadcast: never say that nothing moved (C-03).
        settled = false;
        setHistory(updateHistory(sent.signature, 'unknown'));
        setNotice(outcomeNotice('unknown', sent.signature, texts));
      } else {
        if (busyError(e) || jupiterBusy(e)) busyUntil.current = Date.now() + BUSY_BACKOFF_MS;
        setNotice(explainError(e));
      }
    } finally {
      lock.release(settled);
      setPhase('idle');
      setPending(null);
      refreshBalances().catch(() => undefined);
      refreshAccounts()
        .then(r => setFeeSide(r.fee))
        .catch(() => undefined);
    }
  }

  // --- rendering helpers
  const busy = phase !== 'idle';
  const buttonLabel = (() => {
    if (phase === 'checking') return 'Checking protection…';
    if (phase === 'confirm') return 'The price moved';
    if (phase === 'wallet') return `Approve in ${wallet?.name ?? 'your wallet'}`;
    if (phase === 'sending') return 'Sending…';
    if (!W) return 'Connect wallet';
    return blocker ?? 'Protected swap';
  })();
  const onButton = () => {
    if (busy) return;
    if (!W) return setWalletMenu(true);
    if (!blocker) void swap();
  };

  const flip = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountText('');
  };

  // Max keeps enough SOL for the fees and the swap's temporary accounts when SOL is what is paid.
  const maxIn = balances && tokenIn ? (tokenIn.id === SOL_MINT ? balances.tokenIn - SOL_RESERVE_LAMPORTS * 2n : balances.tokenIn) : 0n;
  const setShare = (half: boolean) => {
    if (!balances || !tokenIn || inDecimals === null) return;
    const amount = half ? (balances.tokenIn / 2n < maxIn ? balances.tokenIn / 2n : maxIn) : maxIn;
    if (amount > 0n) setAmountText(formatExact(amount, inDecimals).replace(/,/g, ''));
  };

  // What swap sites show under the amounts and above the button: the output's value in USD, the rate,
  // the price impact, the tolerance and the minimum. Display only: every amount that is enforced
  // is computed in base units elsewhere.
  const shownOut = quote ? quote.out - (outputFee ?? 0n) : null;
  const outPrice = usablePrice(tokenOut);
  const outUsd = shownOut !== null && shownOut > 0n && outPrice !== null && outDecimals !== null ? (Number(shownOut) / 10 ** outDecimals) * outPrice : null;
  const rate = (() => {
    if (!quote || shownOut === null || shownOut <= 0n || !amountIn || !tokenIn || !tokenOut || inDecimals === null || outDecimals === null) return null;
    const perIn = (Number(shownOut) / 10 ** outDecimals) / (Number(amountIn) / 10 ** inDecimals);
    const n = (x: number) => x.toLocaleString('en-US', { maximumSignificantDigits: 6 });
    return rateInverted ? `1 ${tokenOut.symbol} ≈ ${n(1 / perIn)} ${tokenIn.symbol}` : `1 ${tokenIn.symbol} ≈ ${n(perIn)} ${tokenOut.symbol}`;
  })();
  const tolerance = quote ? (quote.curve ? DEFAULT_SETTINGS.curveSlippageBps : DEFAULT_SETTINGS.slippageBps) / 100 : null;

  const inWarnings = tokenIn ? tokenWarnings(tokenIn, inFacts && inFacts !== 'missing' ? inFacts : null) : [];
  if (quote && quote.impact >= IMPACT_WARN) inWarnings.unshift(`Price impact ${impactText(quote.impact)}: this amount moves the market price.`);
  const outWarnings = tokenOut ? tokenWarnings(tokenOut, outFacts && outFacts !== 'missing' ? outFacts : null) : [];
  // A token that taxes its own transfers costs more through Orientim, because the protected account
  // is one extra transfer. Said before the swap, not after it.
  if (tokenIn && inFacts && inFacts !== 'missing' && inFacts.transferFee) {
    inWarnings.push(
      `${tokenIn.symbol} charges ${inFacts.transferFee.bps / 100}% on every transfer, and a protected swap makes one transfer more than an unprotected one, so you pay it twice. The tax goes to the token, not to Orientim.`,
    );
  }
  if (tokenOut && outFacts && outFacts !== 'missing' && outFacts.transferFee) {
    outWarnings.push(
      `${tokenOut.symbol} charges ${outFacts.transferFee.bps / 100}% on every transfer: the amount shown is what arrives after it.`,
    );
  }
  // An issuer that can move the token anywhere is the token's nature, not something Orientim grants:
  // it can, in this wallet as in any other. What protects this swap from it is the minimum output,
  // which counts what reaches your account (review BR-05). The user is told before they hold it.
  for (const [token, f, list] of [[tokenIn, inFacts, inWarnings], [tokenOut, outFacts, outWarnings]] as const) {
    if (token && f && f !== 'missing' && f.issuerCanMove) {
      list.push(`${token.symbol}'s issuer can move or freeze it in any wallet at any time. That is true wherever you hold it; Orientim neither adds nor changes it, and your minimum output still holds in this swap.`);
    }
  }
  const deepLink = typeof window !== 'undefined' ? encodeURIComponent(window.location.href) : '';
  const origin = typeof window !== 'undefined' ? encodeURIComponent(window.location.origin) : '';

  const version = wallet ? chooseVersion(supportedVersions(wallet), V1_ENABLED) : null;
  const shownKey = W && tokenIn && tokenOut && amountIn && quote && version !== null && minReceived !== null
    ? aheadKey(W, tokenIn.id, tokenOut.id, amountIn, quote.at, version, minReceived) : null;
  const badge: [string, string] = status && !status.enabled ? ['paused', 'Paused']
    : phase === 'checking' ? ['checking', 'Checking…']
      : phase === 'wallet' || phase === 'sending' || (shownKey !== null && verifiedKey === shownKey) ? ['verified', 'Verified']
        : ['ready', 'Protection on'];

  return (
    <>
      <SiteHeader
        right={W ? (
          <div className="account" ref={accountRef}>
            <button className="ghost wallet-pill" onClick={() => setAccountMenu(v => !v)} aria-expanded={accountMenu}>
              {wallet?.icon && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={wallet.icon} alt="" width={18} height={18} />
              )}
              {shortAddress(W)} ▾
            </button>
            {accountMenu && (
              <div className="account-menu" role="menu">
                <button role="menuitem" onClick={copyAddress}>{addressCopied ? 'Copied' : 'Copy address'}</button>
                <button role="menuitem" onClick={disconnect}>Disconnect</button>
              </div>
            )}
          </div>
        ) : (
          <button className="ghost connect" onClick={() => setWalletMenu(true)}>
            Connect wallet
          </button>
        )}
      />

      {walletMenu && !W && (
        <Modal title="Connect a wallet" onClose={() => setWalletMenu(false)}>
          {wallets.length === 0 ? (
            <div className="muted">
              <p>No Solana wallet was found in this browser.</p>
              <p>
                On a phone, open Orientim inside your wallet:{' '}
                <a href={`https://phantom.app/ul/browse/${deepLink}?ref=${origin}`}>Phantom</a>
                {' · '}
                <a href={`https://solflare.com/ul/v1/browse/${deepLink}?ref=${origin}`}>Solflare</a>
                {' · '}
                <a href={`https://backpack.app/ul/v1/browse/${deepLink}?ref=${origin}`}>Backpack</a>
              </p>
            </div>
          ) : (
            wallets.map(w => (
              <button key={w.name} className="wallet-option" onClick={() => connect(w)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={w.icon} alt="" width={24} height={24} />
                {w.name}
              </button>
            ))
          )}
        </Modal>
      )}

      <section className="hero" id="swap">
        <div className="container hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">Protected trading on Solana</p>
            <h1 className="hero-title">
              The trade gets authority.
              <br />
              Your wallet doesn&apos;t.
            </h1>
            <p className="hero-sub">
              Protected Solana swaps for people and AI agents. Each swap can touch only the amount you approve, never the
              rest of your wallet.
            </p>
            <ul className="hero-points">
              <li>Verified before you sign</li>
              <li>Only the amount you approve</li>
              <li>No lasting permissions</li>
            </ul>
            <a className="text-link hero-agents" href="#developers">Building an agent? Use the API and the skill →</a>
          </div>

          <div className="hero-app">
      {status && !status.enabled && (
        <div className="banner error">Protected swaps are paused while we check something. Your funds are not affected.</div>
      )}
      {!TREASURY && <div className="banner info">Test mode: no Orientim fee is charged.</div>}

      <section className="card swap">
        <div className="swap-head">
          <p className="swap-title"><ShieldIcon /> Protected swap</p>
          <span className={`status-badge ${badge[0]}`}><span className="dot" aria-hidden="true" />{badge[1]}</span>
        </div>

        <div className="box">
          <div className="box-top">
            <span className="label">You pay</span>
            {balances && tokenIn && inDecimals !== null && (
              <span className="balance">
                Balance {formatUnits(balances.tokenIn, inDecimals, 6)}
                <button className="chip" onClick={() => setShare(true)} disabled={busy || maxIn <= 0n}>Half</button>
                <button className="chip" onClick={() => setShare(false)} disabled={busy || maxIn <= 0n}>Max</button>
              </span>
            )}
          </div>
          <div className="box-row">
            <input
              className="amount"
              inputMode="decimal"
              placeholder="0"
              value={amountText}
              onChange={e => setAmountText(e.target.value.replace(',', '.'))}
              disabled={busy}
              aria-label="Amount to pay"
            />
            <button className="token" onClick={() => setPicking('in')} disabled={busy}>
              <TokenIcon token={tokenIn} /> {tokenIn?.symbol ?? 'Select'} ▾
            </button>
          </div>
          <p className="hint">{usdValue !== null ? `≈ ${formatUsd(usdValue)}` : ' '}</p>
        </div>

        <div className="flip">
          <button className="ghost" onClick={flip} disabled={busy} aria-label="Switch tokens">
            <FlipIcon />
          </button>
        </div>

        <div className="box">
          <div className="box-top">
            <span className="label">You receive</span>
          </div>
          <div className="box-row">
            <span className={`amount ${quote ? '' : 'placeholder'}`}>
              {quote && outDecimals !== null ? `~${formatUnits(quote.out - (outputFee ?? 0n), outDecimals, 6)}` : quoting ? '…' : '0'}
            </span>
            <button className="token" onClick={() => setPicking('out')} disabled={busy}>
              <TokenIcon token={tokenOut} /> {tokenOut?.symbol ?? 'Select'} ▾
            </button>
          </div>
          <p className="hint">
            {outUsd !== null ? `≈ ${formatUsd(outUsd)}` : ' '}
            {((quote && refreshes >= AUTO_REFRESHES) || (!quote && busyTries > QUOTE_BUSY_RETRIES)) && (
              <>
                {outUsd !== null && ' · '}
                <button type="button" className="link" onClick={refreshNow}>
                  Refresh price
                </button>
              </>
            )}
          </p>
        </div>

        {[...inWarnings, ...outWarnings].length > 0 && (
          <ul className="warnings">
            {[...inWarnings, ...outWarnings].map(w => (
              <li key={w}>{w}</li>
            ))}
            <li>Orientim protects your wallet during the swap. It can&apos;t tell you whether a token is worth buying.</li>
          </ul>
        )}

        <div className="protection">
          <p className="protection-title">Your order. Your limits.</p>
          <div className="detail-row">
            <span>Approved amount</span>
            <span>{tokenIn && amountIn && inDecimals !== null ? `${formatUnits(amountIn, inDecimals, 6)} ${tokenIn.symbol}` : '—'}</span>
          </div>
          <div className="detail-row">
            <span>Minimum received</span>
            <span>{quote && tokenOut && outDecimals !== null && minReceived !== null ? `${formatExact(minReceived, outDecimals)} ${tokenOut.symbol}` : '—'}</span>
          </div>
          <div className="detail-row">
            <span>Access to your other assets</span>
            <span>None</span>
          </div>
          <div className="detail-row">
            <span>Lasting permissions</span>
            <span>None</span>
          </div>
          <p className="protection-note">
            The swap route gets only this amount, not the rest of your wallet, and a market&apos;s account fee when one is
            shown. If less than the minimum would arrive, the whole swap cancels itself.
          </p>
        </div>

        <details className="details" open={detailsOpen} onToggle={e => setDetailsOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>
            <span>{rate ?? 'Rate and fees'}</span>
            <span className="summary-hint">Fees ▾</span>
          </summary>
          {rate && (
            <div className="detail-row">
              <span>Rate</span>
              <button type="button" className="link rate" onClick={() => setRateInverted(v => !v)} title="Turn the rate around">
                {rate} ⇄
              </button>
            </div>
          )}
          {quote && (
            <div className="detail-row">
              <span>Price impact</span>
              <span className={quote.impact >= IMPACT_WARN ? 'warn-text' : undefined}>
                {quote.impact < 0.0001 ? '<0.01%' : impactText(quote.impact)}
              </span>
            </div>
          )}
          {quote && tolerance !== null && (
            <div className="detail-row" title={quote.curve ? 'This token is still on its Pump.fun launch curve, where prices move fast.' : undefined}>
              <span>Max slippage</span>
              <span>{`${tolerance}%`}</span>
            </div>
          )}
          {tokenIn && swapAmount !== null && swapAmount > 0n && inDecimals !== null && (
            <div className="detail-row">
              <span>Swap amount</span>
              <span>{`${formatUnits(swapAmount, inDecimals, 6)} ${tokenIn.symbol}`}</span>
            </div>
          )}
          <div className="detail-row">
            <span>Orientim fee</span>
            <span>
              {!TREASURY
                ? '0 (test mode)'
                : !chargesFee
                  ? "Can't be collected right now"
                  : feeSide === 'output'
                    ? outputFee !== null && tokenOut && outDecimals !== null
                      ? `~${formatUnits(outputFee, outDecimals, 6)} ${tokenOut.symbol}`
                      : '—'
                    : feeSide === 'sol'
                      ? solFeeEstimate !== null
                        ? `~${formatUnits(solFeeEstimate, 9, 6)} SOL`
                        : '—'
                    : tokenIn && amountIn && inDecimals !== null
                      ? `${formatUnits(fee, inDecimals, 6)} ${tokenIn.symbol}`
                      : '—'}
            </span>
          </div>
          <div className="detail-row" title="The exact amount is shown before you sign.">
            <span>Network fee</span>
            <span>~0.00002 SOL</span>
          </div>
        </details>

        {phase === 'confirm' && offer && (
          <div className="banner info" role="alertdialog" aria-label={offerCopy(offer).title}>
            <p className="banner-title">{offerCopy(offer).title}</p>
            {offerCopy(offer).body}
            <div className="banner-actions">
              <button className="primary" onClick={() => decideOffer.current?.(true)}>
                {offerCopy(offer).go}
              </button>
              <button className="ghost" onClick={() => decideOffer.current?.(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {phase === 'wallet' && (
          <div className="banner info">
            {pending && (
              <p>
                Minimum output enforced on successful execution: <strong>{pending.minReceived}</strong>. If less would arrive,
                the whole transaction reverts. Network fee: {pending.networkFee}.
                {pending.solFee && <> Orientim fee: {pending.solFee}.</>}
                {pending.oneTimeCost && <> Also: {pending.oneTimeCost}.</>}
                {pending.removesDelegate && <> {pending.removesDelegate}</>}
                {pending.tokenTax && <> {pending.tokenTax}</>}
                {pending.busyNetwork && <> {pending.busyNetwork}</>}
              </p>
            )}
            <p>
              {wallet?.name} shows this transaction and a second signer: Orientim&apos;s one-time key for this swap, which is
              normal.
            </p>
          </div>
        )}

        <button className="primary" onClick={onButton} disabled={busy || (!!W && !!blocker)}>
          {buttonLabel}
        </button>

        {waitingOn.length > 0 && !busy && notice?.link !== solscan(waitingOn[0].signature) && (
          <div className="banner info" role="status">
            <p className="banner-title">Your last swap hasn&apos;t settled yet</p>
            <p>
              {waitingOn[0].over
                ? "It can no longer go through, but the network can't prove whether it already did. Look it up on Solscan; once you have, you can swap again."
                : 'Orientim starts no new swap from this wallet until the network says whether the last one went through, so the same swap never runs twice. It checks again every few seconds.'}
            </p>
            <a href={solscan(waitingOn[0].signature)} target="_blank" rel="noreferrer">
              View on Solscan
            </a>
            {waitingOn[0].over && (
              <div className="banner-actions">
                <button className="ghost" onClick={() => setHistory(updateHistory(waitingOn[0].signature, 'checked'))}>
                  I&apos;ve checked it
                </button>
              </div>
            )}
          </div>
        )}

        {notice && (
          <div className={`banner ${notice.kind}`} role="status">
            <p className="banner-title">{notice.title}</p>
            {notice.body && <p>{notice.body}</p>}
            {notice.link && (
              <a href={notice.link} target="_blank" rel="noreferrer">
                View on Solscan
              </a>
            )}
            {notice.kind === 'error' && (
              <div className="banner-actions">
                <button className="ghost" onClick={copyDetails}>{detailsCopied ? 'Copied' : 'Copy details'}</button>
              </div>
            )}
          </div>
        )}
      </section>

      <p className="card-foot">
        You approve the exact transaction in your wallet. Orientim never asks for your seed phrase.
        {status?.maxUsdPerSwap != null && ` Swaps are limited to ${formatUsd(status.maxUsdPerSwap)} while we run in alpha.`}
      </p>

      {history.length > 0 && (
        <section className="card history">
          <details>
            <summary>Your recent swaps (stored only in this browser)</summary>
            <ul>
              {history.map(h => (
                <li key={h.signature}>
                  <span>
                    {h.paid} → {h.received || '…'}
                  </span>
                  <a href={solscan(h.signature)} target="_blank" rel="noreferrer">
                    {STATUS_LABEL[h.status] ?? h.status}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
          </div>
        </div>
      </section>

      {picking && (
        <TokenPicker
          popular={popular}
          selected={picking === 'in' ? tokenIn?.id : tokenOut?.id}
          onClose={() => setPicking(null)}
          onPick={t => {
            const other = picking === 'in' ? tokenOut : tokenIn;
            const same = picking === 'in' ? tokenIn : tokenOut;
            if (other && t.id === other.id) flip();
            else if (!same || t.id !== same.id) (picking === 'in' ? setTokenIn : setTokenOut)(t);
            setPicking(null);
          }}
        />
      )}
    </>
  );
}

function FlipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4" />
    </svg>
  );
}

