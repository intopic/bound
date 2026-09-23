'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { address, getTransactionEncoder } from '@solana/kit';
import type { Address, KeyPairSigner } from '@solana/kit';
import { feeFor, JUPITER_PROGRAM } from '@bound/core';
import type { TxVersion } from '@bound/core';
import {
  BoundError, DEFAULT_SETTINGS, finalizeProtectedSwap, isCurveRoute, prepareProtectedSwap, quotedMinimum,
} from '@bound/jupiter';
import type { PreparedSwap, TokenInfo } from '@bound/jupiter';
import { createEphemeral } from '@bound/solana';
import type { SendOutcome } from '@bound/solana';
import type { PublicStatus } from '@/lib/server/config';
import { getJupiter, getRpc } from '@/lib/client/chain';
import { FEE_BPS, TREASURY, V1_ENABLED } from '@/lib/client/config';
import {
  chooseVersion, connectWallet, disconnectWallet, onAccountChange, supportedVersions, useWallets, walletSign,
} from '@/lib/client/wallets';
import { formatExact, formatUnits, formatUsd, parseUnits, shortAddress } from '@/lib/client/format';
import {
  amountReachingRoute, loadTokens, mintAta, POPULAR, readMint, SOL_MINT, tokenWarnings, usablePrice, USDC_MINT,
} from '@/lib/client/tokens';
import type { MintFacts } from '@/lib/client/tokens';
import { addHistory, isUnsettled, readHistory, settledHistoryStatus, STATUS_LABEL, updateHistory } from '@/lib/client/history';
import type { HistoryEntry, HistoryStatus } from '@/lib/client/history';
import { acquireSwapLock } from '@/lib/client/swapLock';
import { receivedFromMeta } from '@/lib/client/received';
import type { ConfirmedMeta } from '@/lib/client/received';
import { TokenIcon, TokenPicker } from './TokenPicker';

type Phase = 'idle' | 'checking' | 'confirm' | 'wallet' | 'sending';
type Notice = { kind: 'error' | 'success' | 'info'; title: string; body?: string; link?: string };
/**
 * `curve`: the route trades on a Pump.fun bonding curve, so its tolerance is the wider one.
 * `impact`: how much this amount moves the market price, as Jupiter reports it: a fraction, so
 * 0.132 is 13.2% (checked 2026-09-23 against the rates of a small and a large quote).
 */
type Quote = { out: bigint; minOut: bigint; curve: boolean; impact: number; at: number };
/** What the wallet is about to be asked to sign, shown while it is open. */
type Pending = {
  minReceived: string; networkFee: string; oneTimeCost: string | null; removesDelegate: string | null;
  tokenTax: string | null;
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
const TOKEN_ACCOUNT_SIZE = 165n;
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
        title: `This route gives ${o.gap} less than the best price on the market`,
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
/** A transaction lives about a minute; one that waited longer than this on a question is rebuilt. */
const STALE_AFTER_QUESTION_MS = 15_000;

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
};
const plainRefusal = (reason: string) => PLAIN_REFUSAL[reason] ?? `it uses ${reason}`;

/**
 * What a prepared swap costs beyond what the page showed before the click. It is said before the
 * wallet opens, because on a phone the wallet covers the page (review BR-03).
 */
function extrasOf(p: PreparedSwap, t: { inSymbol: string; outSymbol: string; inDecimals: number }): string[] {
  const lines: string[] = [];
  if (p.oneTimeCosts.routeRent > 0n) {
    lines.push(`Market account fee: ${formatExact(p.oneTimeCosts.routeRent, 9)} SOL. This market charges it to every new buyer, and it does not come back.`);
  }
  if (p.tokenTax) {
    lines.push(`Token tax: ${formatExact(p.tokenTax.extraOnInput, t.inDecimals)} ${t.inSymbol} goes to the token's issuer, not to Bound.`);
  }
  if (p.notices.removesDelegate) lines.push(`This also removes the spending permission you gave on your ${t.outSymbol} account.`);
  return lines;
}

/** Does a rebuilt swap cost more than the one the user just accepted? */
const costsMoreThan = (next: PreparedSwap, accepted: PreparedSwap) =>
  next.oneTimeCosts.routeRent > accepted.oneTimeCosts.routeRent
  || (next.tokenTax?.extraOnInput ?? 0n) > (accepted.tokenTax?.extraOnInput ?? 0n)
  || (next.notices.removesDelegate && !accepted.notices.removesDelegate);

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
        solOutput: prepared.policy.variant === 'A', routeRent: prepared.policy.takerRent,
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
 * largest thing Bound would spend its rate limit on and none of it is a swap.
 */
const AUTO_REFRESHES = 3;
/** Token amounts are 64-bit on Solana; beyond this nothing on chain can hold the balance. */
const MAX_U64 = 2n ** 64n - 1n;
const solscan = (signature: string) => `https://solscan.io/tx/${signature}`;

function explainError(e: unknown): Notice {
  if (e instanceof BoundError) {
    const titles: Record<BoundError['code'], string> = {
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
    };
    const rules = e.violations.length ? ` (${[...new Set(e.violations.map(v => v.rule))].join(', ')})` : '';
    if (e.code === 'wallet-changed-transaction') {
      const details = e.violations.map(v => v.detail);
      const title = details.includes('the wallet did not sign')
        ? "Your wallet didn't sign the transaction"
        : details.includes('the wallet changed the transaction message')
          ? 'Your wallet changed the transaction'
          : "Your wallet's response didn't pass the check";
      return { kind: 'error', title, body: `Bound stopped before adding the last signature${rules}. Nothing was sent and no funds moved.` };
    }
    // A route can be priced perfectly and still not fit: 64 accounts per transaction is Solana's
    // limit, and a very large swap needs more pools than that.
    const title = e.code === 'no-route' && e.message.includes('does not fit')
      ? 'This amount is too large for one protected transaction'
      : titles[e.code];
    return { kind: 'error', title, body: `${e.message}${rules} No funds moved.` };
  }
  const message = String((e as Error)?.message ?? e);
  if (/reject|denied|cancel|4001/i.test(message)) return { kind: 'info', title: 'Swap cancelled in your wallet', body: 'No funds moved.' };
  if (/paused/i.test(message)) return { kind: 'info', title: 'Protected swaps are paused', body: 'Nothing was sent. Your funds are not affected.' };
  if (/429|too many requests/i.test(message)) return { kind: 'info', title: 'Too many requests', body: 'Wait a minute and try again. No funds moved.' };
  if (/ed25519/i.test(message)) {
    return { kind: 'error', title: "This browser can't create Bound's one-time key", body: "Update it, or open Bound in your wallet's browser. No funds moved." };
  }
  return {
    kind: 'error', title: 'Something went wrong',
    body: `${message.slice(0, 200)} Bound stopped before adding its signature, so this swap can never run. No funds moved.`,
  };
}

/**
 * What happened, in words that only claim what the network proved (audit C-03): "no funds moved"
 * appears only when the transaction was refused before broadcast or can no longer execute.
 */
function outcomeNotice(status: SendOutcome, signature: string, t: SwapTexts, error: string | null): Notice {
  const link = solscan(signature);
  switch (status) {
    case 'confirmed':
      return {
        kind: 'success', title: t.received ? `Swapped ${t.paid} for ${t.received}` : `Swapped ${t.paid} for at least ${t.minimum}`,
        body: `${t.received ? `At least ${t.minimum} was guaranteed. ` : ''}Only ${t.exposed} was exposed to the swap; nothing else in your wallet was.`,
        link,
      };
    case 'failed':
      return { kind: 'error', title: 'The swap failed on chain and was reverted', body: 'Only the network fee was paid.', link };
    case 'expired':
      return { kind: 'info', title: "The swap didn't land in time", body: 'It expired without executing and can no longer execute. No funds moved.', link };
    case 'rejected':
      return {
        kind: 'info', title: 'Solana refused the swap before sending it',
        body: `It was never broadcast, so no funds moved. This usually means the price moved; try again.${error ? ` (${error.slice(0, 120)})` : ''}`,
      };
    default:
      return {
        kind: 'info', title: "We couldn't confirm the result yet",
        body: 'The swap may still go through or may already have. Check it on Solscan before trying again.', link,
      };
  }
}

/** Pending or unknown swaps from earlier visits, settled from the chain (audit C-03). */
async function settleHistory(): Promise<HistoryEntry[] | null> {
  const open = readHistory().filter(isUnsettled);
  if (!open.length) return null;
  const rpc = getRpc();
  const { value } = await rpc
    .getSignatureStatuses(open.map(h => h.signature as never), { searchTransactionHistory: true })
    .send();
  const needsHeight = open.some((h, i) => !value[i] && h.lastValidBlockHeight !== undefined);
  const blockHeight = needsHeight
    ? await rpc.getBlockHeight({ commitment: 'confirmed' }).send().then(BigInt).catch(() => null)
    : null;
  // Once the recorded lifetime is over, ask full history again. A status read made just before the
  // height read may have lagged a transaction that landed near the boundary; one empty read is not
  // enough evidence for the UI to invite a retry.
  const needsSecondLookup = open.some((h, i) =>
    settledHistoryStatus(h, value[i] ?? null, blockHeight) === 'expired');
  const second = needsSecondLookup
    ? (await rpc.getSignatureStatuses(open.map(h => h.signature as never), { searchTransactionHistory: true }).send()).value
    : [];
  let list: HistoryEntry[] | null = null;
  for (const [i, h] of open.entries()) {
    const state = value[i] ?? second[i] ?? null;
    const next: HistoryStatus | null = settledHistoryStatus(h, state, blockHeight);
    if (next) list = updateHistory(h.signature, next);
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
  const [balances, setBalances] = useState<{ sol: bigint; tokenIn: bigint } | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  // What the chain says about each selected mint: decimals and token program (audit C-01).
  const [facts, setFacts] = useState<Record<string, MintFacts | 'missing'>>({});
  // Rent for a new token account, from the cluster (audit C-09).
  const [rent, setRent] = useState<bigint | null>(null);
  // Accounts that decide the Bound fee and the one-time costs shown before signing (audit B-09).
  const [feeAccountExists, setFeeAccountExists] = useState(true);
  const [outputAccountExists, setOutputAccountExists] = useState(true);
  const [clock, setClock] = useState(0);
  const [refreshes, setRefreshes] = useState(0);
  const balanceRequest = useRef(0);
  const decideOffer = useRef<((accept: boolean) => void) | null>(null);

  const W = account ? (account.address as Address) : null;
  // The mint owner is the token program. It is part of every ATA derivation, so keep these facts
  // beside the selected tokens instead of falling back to the classic program while they load.
  const inFacts = tokenIn ? facts[tokenIn.id] : undefined;
  const outFacts = tokenOut ? facts[tokenOut.id] : undefined;

  // --- bootstrap
  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then(setStatus)
      .catch(() => setNotice({ kind: 'error', title: "Couldn't reach Bound", body: 'Check your connection and reload.' }));
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

  // Rent for a new account of the selected output token, at the size the token program gives it:
  // a Token-2022 account with a transfer fee or hook is larger than a classic one.
  const outAccountSize = outFacts && outFacts !== 'missing' ? BigInt(outFacts.accountSize) : TOKEN_ACCOUNT_SIZE;
  useEffect(() => {
    let cancelled = false;
    getRpc().getMinimumBalanceForRentExemption(outAccountSize).send()
      .then(v => { if (!cancelled) setRent(BigInt(v)); })
      .catch(() => { if (!cancelled) setRent(null); });
    return () => { cancelled = true; };
  }, [outAccountSize]);

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

  // No treasury account for the input token → the swap is fee-free (Bound never makes the user pay
  // rent for Bound's account). No output account yet → the user pays its rent once and keeps it.
  const refreshAccounts = useCallback(async () => {
    const exists = async (a: Address) =>
      (await getRpc().getAccountInfo(a, { encoding: 'base64', commitment: 'confirmed' }).send()).value !== null;
    const fee = TREASURY && tokenIn && tokenIn.id !== SOL_MINT && inFacts && inFacts !== 'missing'
      ? await exists(await mintAta(TREASURY, tokenIn.id, inFacts))
      : true;
    const out = W && tokenOut && tokenOut.id !== SOL_MINT && outFacts && outFacts !== 'missing'
      ? await exists(await mintAta(W, tokenOut.id, outFacts))
      : true;
    return { fee, out };
  }, [tokenIn, tokenOut, W, inFacts, outFacts]);

  useEffect(() => {
    let cancelled = false;
    refreshAccounts()
      .then(r => {
        if (cancelled) return;
        setFeeAccountExists(r.fee);
        setOutputAccountExists(r.out);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshAccounts]);

  // --- amounts, always with the mints' on-chain decimals (audit C-01)
  const inDecimals = inFacts && inFacts !== 'missing' ? inFacts.decimals : null;
  const outDecimals = outFacts && outFacts !== 'missing' ? outFacts.decimals : null;
  const chargesFee = !!TREASURY && feeAccountExists;
  const amountIn = tokenIn && inDecimals !== null ? parseUnits(amountText, inDecimals) : null;
  const fee = amountIn && chargesFee ? feeFor(amountIn, { feeBps: FEE_BPS, treasury: TREASURY }) : 0n;
  const swapAmount = amountIn ? amountIn - fee : null;
  const price = usablePrice(tokenIn);
  const usdValue = amountIn && price !== null && inDecimals !== null ? (Number(amountIn) / 10 ** inDecimals) * price : null;

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
          // Shown only if it answers this exact trade; the minimum is computed by Bound (C-02), with
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
        .catch(() => !cancelled && setQuote(null))
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
  }, [tokenIn, tokenOut, swapAmount]);

  // --- what blocks the swap button
  const blocker = useMemo((): string | null => {
    if (status && !status.enabled) return 'Protected swaps are paused';
    if (!W) return null;
    if (!tokenIn || !tokenOut) return 'Select tokens';
    if (tokenIn.id === tokenOut.id) return 'Choose two different tokens';
    if (inFacts === 'missing' || outFacts === 'missing') return 'That address is not a token';
    if (!inFacts || !outFacts) return 'Reading token details…';
    const refused = inFacts.unsupported ?? outFacts.unsupported;
    if (refused) return `Bound can't swap this token safely: ${plainRefusal(refused)}`;
    if (!amountIn || amountIn <= 0n) return 'Enter an amount';
    if (amountIn > MAX_U64) return 'Amount is too large';
    if (swapAmount !== null && swapAmount <= 0n) return 'Amount is too small';
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
    if (!quote) return quoting ? 'Getting a price…' : 'No price for this pair right now';
    if (Date.now() - quote.at > QUOTE_MAX_AGE_MS) {
      return refreshes >= AUTO_REFRESHES ? 'Refresh the price to continue' : 'Refreshing price…';
    }
    return null;
    // `clock` re-evaluates the age of the quote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, W, tokenIn, tokenOut, inFacts, outFacts, amountIn, swapAmount, balances, usdValue, quote, quoting, clock, refreshes]);

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
    if (wallet) await disconnectWallet(wallet).catch(() => undefined);
    setWallet(null);
    setAccount(null);
    setBalances(null);
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
  async function prepareAccepted(args: {
    E: KeyPairSigner; owner: Address; inToken: TokenInfo; outToken: TokenInfo; amountIn: bigint;
    inDecimals: number; outDecimals: number; acceptedMinOut: bigint; version: TxVersion; status: PublicStatus;
  }): Promise<PreparedSwap | null> {
    let accepted = args.acceptedMinOut;
    let acceptedCost: bigint | undefined;
    for (let round = 0; ; round++) {
      try {
        return await prepareProtectedSwap(
          {
            rpc: getRpc(),
            jupiter: getJupiter(),
            settings: {
              ...DEFAULT_SETTINGS,
              feeBps: FEE_BPS,
              treasury: TREASURY,
              excludeDexes: args.status.excludeDexes,
              maxNetworkFeeLamports: BigInt(args.status.maxNetworkFeeLamports),
              jupiterProgram: JUPITER_PROGRAM,
            },
          },
          {
            owner: args.owner, ephemeral: args.E, inputMint: address(args.inToken.id), outputMint: address(args.outToken.id),
            amountIn: args.amountIn, inputDecimals: args.inDecimals, outputDecimals: args.outDecimals,
            acceptedMinOut: accepted, acceptedCostBps: acceptedCost, version: args.version,
          },
        );
      } catch (e) {
        if (!(e instanceof BoundError) || round >= 2) throw e;
        if (e.code === 'price-moved' && e.priceMoved) {
          const symbol = args.outToken.symbol;
          const accept = await askAboutOffer({
            kind: 'price',
            was: `${formatExact(accepted, args.outDecimals)} ${symbol}`,
            now: `${formatExact(e.priceMoved.newMinOut, args.outDecimals)} ${symbol}`,
          });
          if (!accept) return null;
          accepted = e.priceMoved.newMinOut;
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

  // --- the protected swap: build + verify → wallet signs first → re-verify → E signs last → send
  async function swap() {
    if (!wallet || !account || !W || !tokenIn || !tokenOut || !amountIn || !status || !quote || blocker) return;
    if (inDecimals === null || outDecimals === null) return;
    const inToken = tokenIn;
    const outToken = tokenOut;
    const version: TxVersion | null = chooseVersion(supportedVersions(wallet), V1_ENABLED);
    if (version === null) {
      setNotice({
        kind: 'error', title: `${wallet.name} can't sign this kind of transaction`,
        body: 'Bound needs a wallet that supports versioned transactions. Nothing was signed.',
      });
      return;
    }
    // Decision A: one Bound swap at a time into the same token, across tabs.
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
    try {
      const E = await createEphemeral();
      const build = (acceptedMinOut: bigint) => prepareAccepted({
        E, owner: W, inToken, outToken, amountIn, inDecimals, outDecimals, acceptedMinOut, version, status,
      });
      // A large price impact is asked about before anything is built, as other swap pages do.
      if (quote.impact >= IMPACT_ASK) {
        if (!(await askAboutOffer({ kind: 'impact', pct: impactText(quote.impact) }))) return cancelled();
        setPhase('checking');
      }
      let prepared = await build(quote.minOut);
      if (!prepared) return cancelled();
      // Costs the page did not show before the click are shown before the wallet opens (BR-03).
      const facts = { inSymbol: inToken.symbol, outSymbol: outToken.symbol, inDecimals };
      const extras = extrasOf(prepared, facts);
      if (extras.length) {
        const askedAt = Date.now();
        if (!(await askAboutOffer({ kind: 'extras', lines: extras }))) return cancelled();
        // A swap that waited on the question is built again, and asked about again only if the new
        // build costs more than what was just accepted.
        if (Date.now() - askedAt > STALE_AFTER_QUESTION_MS) {
          setPhase('checking');
          const again = await build(prepared.quote.minOut);
          if (!again) return cancelled();
          if (costsMoreThan(again, prepared) && !(await askAboutOffer({ kind: 'extras', lines: extrasOf(again, facts) }))) return cancelled();
          prepared = again;
        }
      }
      texts.minimum = `${formatExact(prepared.quote.minOut, outDecimals)} ${outToken.symbol}`;
      texts.exposed = `${formatUnits(prepared.policy.swapAmount, inDecimals)} ${inToken.symbol}`;
      const newAccountRent = prepared.oneTimeCosts.outputAccountRent;
      const routeRent = prepared.oneTimeCosts.routeRent;
      setPending({
        minReceived: `${formatExact(prepared.quote.minOut, outDecimals)} ${outToken.symbol}`,
        networkFee: `${formatExact(prepared.networkFeeLamports, 9)} SOL`,
        oneTimeCost: [
          newAccountRent > 0n ? `${formatExact(newAccountRent, 9)} SOL opens your ${outToken.symbol} account (one time, stays yours)` : '',
          // Pump.fun charges every new buyer a small account deposit, and it does not come back.
          routeRent > 0n ? `${formatExact(routeRent, 9)} SOL account fee charged by this market` : '',
        ].filter(Boolean).join('; ') || null,
        removesDelegate: prepared.notices.removesDelegate
          ? `It also removes an existing spending permission (delegate) on your ${outToken.symbol} account.`
          : null,
        tokenTax: prepared.tokenTax
          ? `${inToken.symbol} charges ${prepared.tokenTax.inputBps / 100}% on every transfer. Moving your ${inToken.symbol} into the protected account costs `
            + `${formatExact(prepared.tokenTax.extraOnInput, inDecimals)} ${inToken.symbol} of that tax, which goes to the token, not to Bound.`
          : null,
      });
      setPhase('wallet');
      lock.refresh();
      const toSend = prepared;
      const signed = await walletSign(wallet, account, new Uint8Array(getTransactionEncoder().encode(toSend.transaction)));

      setPhase('sending');
      lock.refresh();
      const result = await finalizeProtectedSwap({
        rpc: getRpc(), prepared: toSend, walletSignedBytes: signed, ephemeral: E,
        onStatus: (s, signature) => {
          if (s !== 'sending') return;
          // Recorded before anything is sent, so it is never lost (C-03).
          sent.signature = signature;
          setHistory(addHistory({
            at: Date.now(), signature, status: 'pending',
            lastValidBlockHeight: toSend.lifetime.lastValidBlockHeight.toString(),
            ...texts, received: `at least ${texts.minimum}`,
          }));
        },
      });
      if (result.status === 'confirmed') {
        const got = await actualReceived(result.signature, toSend);
        if (got !== null) texts.received = `${formatExact(got, outDecimals)} ${outToken.symbol}`;
      }
      setHistory(updateHistory(result.signature, result.status, texts.received || undefined));
      settled = result.status !== 'unknown';
      setNotice(outcomeNotice(result.status, result.signature, texts, result.error));
      if (result.status === 'confirmed') setAmountText('');
    } catch (e) {
      if (sent.signature) {
        // It may have been broadcast: never say that nothing moved (C-03).
        settled = false;
        setHistory(updateHistory(sent.signature, 'unknown'));
        setNotice(outcomeNotice('unknown', sent.signature, texts, null));
      } else {
        setNotice(explainError(e));
      }
    } finally {
      lock.release(settled);
      setPhase('idle');
      setPending(null);
      refreshBalances().catch(() => undefined);
      refreshAccounts()
        .then(r => {
          setFeeAccountExists(r.fee);
          setOutputAccountExists(r.out);
        })
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

  const setMax = () => {
    if (!balances || !tokenIn || inDecimals === null) return;
    const max = tokenIn.id === SOL_MINT ? balances.tokenIn - SOL_RESERVE_LAMPORTS * 2n : balances.tokenIn;
    if (max > 0n) setAmountText(formatExact(max, inDecimals).replace(/,/g, ''));
  };

  const inWarnings = tokenIn ? tokenWarnings(tokenIn, inFacts && inFacts !== 'missing' ? inFacts : null) : [];
  if (quote && quote.impact >= IMPACT_WARN) inWarnings.unshift(`Price impact ${impactText(quote.impact)}: this amount moves the market price.`);
  const outWarnings = tokenOut ? tokenWarnings(tokenOut, outFacts && outFacts !== 'missing' ? outFacts : null) : [];
  // A token that taxes its own transfers costs more through Bound, because the protected account
  // is one extra transfer. Said before the swap, not after it.
  if (tokenIn && inFacts && inFacts !== 'missing' && inFacts.transferFee) {
    inWarnings.push(
      `${tokenIn.symbol} charges ${inFacts.transferFee.bps / 100}% on every transfer, and a protected swap makes one transfer more than an unprotected one, so you pay it twice. The tax goes to the token, not to Bound.`,
    );
  }
  if (tokenOut && outFacts && outFacts !== 'missing' && outFacts.transferFee) {
    outWarnings.push(
      `${tokenOut.symbol} charges ${outFacts.transferFee.bps / 100}% on every transfer: the amount shown is what arrives after it.`,
    );
  }
  // An issuer that can move the token anywhere is the token's nature, not something Bound grants:
  // it can, in this wallet as in any other. What protects this swap from it is the minimum output,
  // which counts what reaches your account (review BR-05). The user is told before they hold it.
  for (const [token, f, list] of [[tokenIn, inFacts, inWarnings], [tokenOut, outFacts, outWarnings]] as const) {
    if (token && f && f !== 'missing' && f.issuerCanMove) {
      list.push(`${token.symbol}'s issuer can move or freeze it in any wallet at any time. That is true wherever you hold it; Bound neither adds nor changes it, and your minimum output still holds in this swap.`);
    }
  }
  const deepLink = typeof window !== 'undefined' ? encodeURIComponent(window.location.href) : '';
  const origin = typeof window !== 'undefined' ? encodeURIComponent(window.location.origin) : '';

  return (
    <main className="page">
      <header className="top">
        <span className="brand">
          <ShieldIcon /> Bound
        </span>
        {W ? (
          <button className="ghost wallet-pill" onClick={disconnect} title="Disconnect">
            {wallet?.icon && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={wallet.icon} alt="" width={18} height={18} />
            )}
            {shortAddress(W)}
          </button>
        ) : (
          <button className="ghost" onClick={() => setWalletMenu(v => !v)}>
            Connect wallet
          </button>
        )}
      </header>

      {walletMenu && !W && (
        <section className="card wallets">
          <p className="label">Choose a wallet</p>
          {wallets.length === 0 ? (
            <div className="muted">
              <p>No Solana wallet was found in this browser.</p>
              <p>
                On a phone, open Bound inside your wallet:{' '}
                <a href={`https://phantom.app/ul/browse/${deepLink}?ref=${origin}`}>Phantom</a>
                {' · '}
                <a href={`https://solflare.com/ul/v1/browse/${deepLink}?ref=${origin}`}>Solflare</a>
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
        </section>
      )}

      {status && !status.enabled && (
        <div className="banner error">Protected swaps are paused while we check something. Your funds are not affected.</div>
      )}
      {!TREASURY && <div className="banner info">Test mode: no Bound fee is charged.</div>}

      <section className="card swap">
        <div className="box">
          <div className="box-top">
            <span className="label">You pay</span>
            {balances && tokenIn && inDecimals !== null && (
              <button className="link" onClick={setMax}>
                Balance {formatUnits(balances.tokenIn, inDecimals, 6)}
              </button>
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
            ↓
          </button>
        </div>

        <div className="box">
          <div className="box-top">
            <span className="label">You receive</span>
          </div>
          <div className="box-row">
            <span className={`amount ${quote ? '' : 'placeholder'}`}>
              {quote && outDecimals !== null ? `~${formatUnits(quote.out, outDecimals, 6)}` : quoting ? '…' : '0'}
            </span>
            <button className="token" onClick={() => setPicking('out')} disabled={busy}>
              <TokenIcon token={tokenOut} /> {tokenOut?.symbol ?? 'Select'} ▾
            </button>
          </div>
          <p className="hint">
            {quote && tokenOut && outDecimals !== null
              ? `Minimum received ${formatExact(quote.minOut, outDecimals)} ${tokenOut.symbol} · if less would arrive, the swap cancels itself`
                + (quote.curve ? ' · 3% tolerance: this token is still on its Pump.fun launch curve and moves fast' : '')
              : ' '}
            {quote && refreshes >= AUTO_REFRESHES && (
              <>
                {' · '}
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
            <li>Bound protects your wallet during the swap. It can&apos;t tell you whether a token is worth buying.</li>
          </ul>
        )}

        <div className="protection">
          <p className="protection-title">
            <ShieldIcon /> Wallet authority protected
          </p>
          <p className="protection-note">The swap can use only the amount you swap. It can&apos;t touch anything else in your wallet.</p>
        </div>

        <div className="details">
          {tokenIn && swapAmount !== null && swapAmount > 0n && inDecimals !== null && (
            <div className="detail-row">
              <span>Swap amount</span>
              <span>{`${formatUnits(swapAmount, inDecimals, 6)} ${tokenIn.symbol}`}</span>
            </div>
          )}
          <div className="detail-row">
            <span>{chargesFee ? `Bound fee ${Number(FEE_BPS) / 100}%` : 'Bound fee'}</span>
            <span>
              {!TREASURY
                ? '0 (test mode)'
                : !chargesFee
                  ? 'Free for this token'
                  : tokenIn && amountIn && inDecimals !== null
                    ? `${formatUnits(fee, inDecimals, 6)} ${tokenIn.symbol}`
                    : '—'}
            </span>
          </div>
          <div className="detail-row">
            <span>Network fee</span>
            <span>~0.00002 SOL, exact amount shown before you sign</span>
          </div>
          {W && !outputAccountExists && tokenOut && (
            <div className="detail-row" title="Solana keeps this deposit in your new token account. You get it back if you close the account.">
              <span>New {tokenOut.symbol} account</span>
              <span>{rent !== null ? `${formatExact(rent, 9)} SOL, one time, stays yours` : 'one-time deposit, stays yours'}</span>
            </div>
          )}
        </div>

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
                {pending.oneTimeCost && <> Also: {pending.oneTimeCost}.</>}
                {pending.removesDelegate && <> {pending.removesDelegate}</>}
                {pending.tokenTax && <> {pending.tokenTax}</>}
              </p>
            )}
            <p>
              {wallet?.name} will show the amounts and a second signer. That second signer is Bound&apos;s temporary key, which
              is normal.
            </p>
          </div>
        )}

        <button className="primary" onClick={onButton} disabled={busy || (!!W && !!blocker)}>
          {buttonLabel}
        </button>

        {notice && (
          <div className={`banner ${notice.kind}`} role="status">
            <p className="banner-title">{notice.title}</p>
            {notice.body && <p>{notice.body}</p>}
            {notice.link && (
              <a href={notice.link} target="_blank" rel="noreferrer">
                View on Solscan
              </a>
            )}
          </div>
        )}
      </section>

      {picking && (
        <TokenPicker
          popular={popular}
          exclude={picking === 'in' ? tokenOut?.id : tokenIn?.id}
          onClose={() => setPicking(null)}
          onPick={t => {
            if (picking === 'in') setTokenIn(t);
            else setTokenOut(t);
            setPicking(null);
          }}
        />
      )}

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

      <footer className="foot">
        <p>
          Bound never asks for your seed phrase.
          {status?.maxUsdPerSwap != null && ` Swaps are limited to ${formatUsd(status.maxUsdPerSwap)} while we run in alpha.`}
        </p>
        <p>What you approve is all the swap can touch.</p>
        <p>
          Bound works with any token pair Jupiter can route and Bound can safely isolate. It protects your wallet, not the
          price or value of the token you buy.
        </p>
      </footer>
    </main>
  );
}

function ShieldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
