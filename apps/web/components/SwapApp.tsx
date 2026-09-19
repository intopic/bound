'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { address, getTransactionEncoder } from '@solana/kit';
import type { Address, KeyPairSigner } from '@solana/kit';
import { ataOf, feeFor, JUPITER_PROGRAM } from '@bound/core';
import type { TxVersion } from '@bound/core';
import { BoundError, DEFAULT_SETTINGS, finalizeProtectedSwap, prepareProtectedSwap, routeFloor } from '@bound/jupiter';
import type { PreparedSwap, TokenInfo } from '@bound/jupiter';
import type { Certificate } from '@bound/verifier';
import { createEphemeral } from '@bound/solana';
import type { SendOutcome } from '@bound/solana';
import type { PublicStatus } from '@/lib/server/config';
import { getJupiter, getRpc, getSecondaryRpc } from '@/lib/client/chain';
import { FEE_BPS, TREASURY } from '@/lib/client/config';
import {
  connectWallet, disconnectWallet, onAccountChange, supportedVersions, useWallets, walletSign,
} from '@/lib/client/wallets';
import { formatExact, formatUnits, formatUsd, parseUnits, shortAddress } from '@/lib/client/format';
import {
  loadTokens, POPULAR, readMint, SOL_MINT, TOKEN_PROGRAM, tokenWarnings, usablePrice, USDC_MINT,
} from '@/lib/client/tokens';
import type { MintFacts } from '@/lib/client/tokens';
import { addHistory, isUnsettled, readHistory, STATUS_LABEL, updateHistory } from '@/lib/client/history';
import type { HistoryEntry, HistoryStatus } from '@/lib/client/history';
import { acquireSwapLock } from '@/lib/client/swapLock';
import { TokenIcon, TokenPicker } from './TokenPicker';

type Phase = 'idle' | 'checking' | 'confirm' | 'wallet' | 'sending';
type Notice = { kind: 'error' | 'success' | 'info'; title: string; body?: string; link?: string };
type Quote = { out: bigint; minOut: bigint; route: string[]; at: number };
/** What the wallet is about to be asked to sign, shown while it is open. */
type Pending = {
  minReceived: string; networkFee: string; oneTimeCost: string | null; removesDelegate: string | null;
  certificate: Certificate; inSymbol: string; outSymbol: string;
};
/** The market moved beyond the tolerance since the user looked: the new minimum to accept or not. */
type Offer = { was: string; now: string };
type SwapTexts = { paid: string; received: string; exposed: string };

// Quotes are asked for a neutral taker, so Jupiter never sees the user's address before a swap.
const QUOTE_TAKER = '11111111111111111111111111111111';
const SOL_RESERVE_LAMPORTS = 10_000_000n; // fees plus temporary rent, returned in the same transaction
const TOKEN_ACCOUNT_SIZE = 165n;
const OFFER_TIMEOUT_MS = 45_000;
// A quote is refreshed every 20 s while the page is idle, and one older than 45 s is not offered
// (idea 23): the user always accepts a recent price.
const QUOTE_REFRESH_MS = 20_000;
const QUOTE_MAX_AGE_MS = 45_000;
const solscan = (signature: string) => `https://solscan.io/tx/${signature}`;

function explainError(e: unknown): Notice {
  if (e instanceof BoundError) {
    const titles: Record<BoundError['code'], string> = {
      'unsupported-token': 'This token is not supported yet',
      'token-data-mismatch': "The token data didn't match the chain",
      'output-account-restricted': 'Your account for this token is restricted',
      'no-route': 'No protected route right now',
      'bad-quote': 'Only bad prices were offered',
      'price-moved': 'The price moved',
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
    return { kind: 'error', title: titles[e.code], body: `${e.message}${rules} No funds moved.` };
  }
  const message = String((e as Error)?.message ?? e);
  if (/reject|denied|cancel|4001/i.test(message)) return { kind: 'info', title: 'Swap cancelled in your wallet', body: 'No funds moved.' };
  if (/paused/i.test(message)) return { kind: 'info', title: 'Protected swaps are paused', body: 'Nothing was sent. Your funds are not affected.' };
  if (/429|too many requests/i.test(message)) return { kind: 'info', title: 'Too many requests', body: 'Wait a minute and try again. No funds moved.' };
  return { kind: 'error', title: 'Something went wrong', body: `${message.slice(0, 200)} Nothing was signed, so no funds moved.` };
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
        kind: 'success', title: `Swapped ${t.paid} for ~${t.received}`,
        body: `The swap program could only touch ${t.exposed}. Nothing else in your wallet was exposed.`, link,
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
  const { value } = await getRpc()
    .getSignatureStatuses(open.map(h => h.signature as never), { searchTransactionHistory: true })
    .send();
  let list: HistoryEntry[] | null = null;
  for (const [i, s] of value.entries()) {
    const h = open[i];
    const next: HistoryStatus | null = s?.err
      ? 'failed'
      : s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')
        ? 'confirmed'
        : !s && Date.now() - h.at > 180_000
          ? 'expired' // its blockhash expired long ago and the cluster has no record of it
          : null;
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
  const balanceRequest = useRef(0);
  const decideOffer = useRef<((accept: boolean) => void) | null>(null);

  const W = account ? (account.address as Address) : null;

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
    getRpc().getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE).send().then(v => setRent(BigInt(v))).catch(() => setRent(null));
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
    if (!W || !tokenIn) return setBalances(null);
    const rpc = getRpc();
    const sol = (await rpc.getBalance(W, { commitment: 'confirmed' }).send()).value;
    let tokenBalance: bigint = sol;
    if (tokenIn.id !== SOL_MINT) {
      try {
        const ata = await ataOf(W, address(tokenIn.id));
        tokenBalance = BigInt((await rpc.getTokenAccountBalance(ata, { commitment: 'confirmed' }).send()).value.amount);
      } catch {
        tokenBalance = 0n;
      }
    }
    if (request === balanceRequest.current) setBalances({ sol, tokenIn: tokenBalance });
  }, [W, tokenIn]);

  useEffect(() => {
    refreshBalances().catch(() => setBalances(null));
  }, [refreshBalances]);

  // No treasury account for the input token → the swap is fee-free (Bound never makes the user pay
  // rent for Bound's account). No output account yet → the user pays its rent once and keeps it.
  const refreshAccounts = useCallback(async () => {
    const exists = async (a: Address) =>
      (await getRpc().getAccountInfo(a, { encoding: 'base64', commitment: 'confirmed' }).send()).value !== null;
    const fee = TREASURY && tokenIn && tokenIn.id !== SOL_MINT ? await exists(await ataOf(TREASURY, address(tokenIn.id))) : true;
    const out = W && tokenOut && tokenOut.id !== SOL_MINT ? await exists(await ataOf(W, address(tokenOut.id))) : true;
    return { fee, out };
  }, [tokenIn, tokenOut, W]);

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
  const inFacts = tokenIn ? facts[tokenIn.id] : undefined;
  const outFacts = tokenOut ? facts[tokenOut.id] : undefined;
  const inDecimals = inFacts && inFacts !== 'missing' ? inFacts.decimals : null;
  const outDecimals = outFacts && outFacts !== 'missing' ? outFacts.decimals : null;
  const chargesFee = !!TREASURY && feeAccountExists;
  const amountIn = tokenIn && inDecimals !== null ? parseUnits(amountText, inDecimals) : null;
  const fee = amountIn && chargesFee ? feeFor(amountIn, { feeBps: FEE_BPS, treasury: TREASURY }) : 0n;
  const swapAmount = amountIn ? amountIn - fee : null;
  const price = usablePrice(tokenIn);
  const usdValue = amountIn && price !== null && inDecimals !== null ? (Number(amountIn) / 10 ** inDecimals) * price : null;

  // --- a clock for quote freshness: ticks only while the page is visible and idle
  useEffect(() => {
    if (phase !== 'idle') return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setClock(c => c + 1);
    }, QUOTE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [phase]);

  // --- live quote (price only; the protected transaction is built and verified on click)
  useEffect(() => {
    // On a refresh tick the current quote stays on screen until the new one arrives.
    if (!tokenIn || !tokenOut || !swapAmount || swapAmount <= 0n || tokenIn.id === tokenOut.id) return setQuote(null);
    let cancelled = false;
    setQuoting(true);
    const timer = setTimeout(() => {
      getJupiter()
        .build({
          inputMint: address(tokenIn.id), outputMint: address(tokenOut.id), amount: swapAmount,
          taker: address(QUOTE_TAKER), slippageBps: DEFAULT_SETTINGS.slippageBps, maxAccounts: 64,
          excludeDexes: status?.excludeDexes ?? DEFAULT_SETTINGS.excludeDexes,
        })
        .then(r => {
          if (cancelled) return;
          // Shown only if it answers this exact trade; the minimum is computed by Bound (C-02).
          const answersThis = r.inputMint === tokenIn.id && r.outputMint === tokenOut.id && BigInt(r.inAmount) === swapAmount;
          setQuote(answersThis
            ? { out: BigInt(r.outAmount), minOut: routeFloor(r, DEFAULT_SETTINGS.slippageBps), route: r.routePlan.map(p => p.swapInfo.label), at: Date.now() }
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
  }, [tokenIn, tokenOut, swapAmount, status, clock]);

  // A change of pair or amount makes the shown quote meaningless at once.
  useEffect(() => setQuote(null), [tokenIn, tokenOut, swapAmount]);

  // --- what blocks the swap button
  const blocker = useMemo((): string | null => {
    if (status && !status.enabled) return 'Protected swaps are paused';
    if (!W) return null;
    if (!tokenIn || !tokenOut) return 'Select tokens';
    if (tokenIn.id === tokenOut.id) return 'Choose two different tokens';
    if (inFacts === 'missing' || outFacts === 'missing') return 'That address is not a token';
    if (!inFacts || !outFacts) return 'Reading token details…';
    if (inFacts.program !== TOKEN_PROGRAM || outFacts.program !== TOKEN_PROGRAM) return 'Token-2022 tokens are not supported yet';
    if (!amountIn || amountIn <= 0n) return 'Enter an amount';
    if (swapAmount !== null && swapAmount <= 0n) return 'Amount is too small';
    if (balances && amountIn > balances.tokenIn) return `Insufficient ${tokenIn.symbol}`;
    const solNeeded = SOL_RESERVE_LAMPORTS + (tokenIn.id === SOL_MINT ? amountIn : 0n);
    if (balances && balances.sol < solNeeded) return 'Not enough SOL for network fees';
    // The alpha cap fails closed: a token without a USD price cannot be checked, so it is blocked (B-05).
    if (!status) return 'Loading limits…';
    if (usdValue === null) return `No USD price for ${tokenIn.symbol} yet`;
    if (usdValue > status.maxUsdPerSwap) return `Alpha limit: ${formatUsd(status.maxUsdPerSwap)} per swap`;
    // The user accepts a minimum they have seen; without a price there is nothing to accept (C-02).
    if (!quote) return quoting ? 'Getting a price…' : 'No price for this pair right now';
    if (Date.now() - quote.at > QUOTE_MAX_AGE_MS) return 'Refreshing price…';
    return null;
    // `clock` re-evaluates the age of the quote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, W, tokenIn, tokenOut, inFacts, outFacts, amountIn, swapAmount, balances, usdValue, quote, quoting, clock]);

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
    for (let round = 0; ; round++) {
      try {
        return await prepareProtectedSwap(
          {
            rpc: getRpc(),
            secondaryRpc: args.status.secondaryRpc ? getSecondaryRpc() : undefined,
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
            acceptedMinOut: accepted, version: args.version,
          },
        );
      } catch (e) {
        if (!(e instanceof BoundError) || e.code !== 'price-moved' || !e.priceMoved || round >= 2) throw e;
        const symbol = args.outToken.symbol;
        const accept = await askAboutOffer({
          was: `${formatExact(accepted, args.outDecimals)} ${symbol}`,
          now: `${formatExact(e.priceMoved.newMinOut, args.outDecimals)} ${symbol}`,
        });
        if (!accept) return null;
        accepted = e.priceMoved.newMinOut;
        setPhase('checking');
      }
    }
  }

  // --- the protected swap: build + verify → wallet signs first → re-verify → E signs last → send
  async function swap() {
    if (!wallet || !account || !W || !tokenIn || !tokenOut || !amountIn || !status || !quote || blocker) return;
    if (inDecimals === null || outDecimals === null) return;
    const inToken = tokenIn;
    const outToken = tokenOut;
    const versions = supportedVersions(wallet).map(String);
    const version: TxVersion | null = versions.includes('1') ? 1 : versions.includes('0') ? 0 : null;
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
    const texts: SwapTexts = { paid: `${formatUnits(amountIn, inDecimals)} ${inToken.symbol}`, received: '', exposed: '' };
    try {
      const E = await createEphemeral();
      const prepared = await prepareAccepted({
        E, owner: W, inToken, outToken, amountIn, inDecimals, outDecimals, acceptedMinOut: quote.minOut, version, status,
      });
      if (!prepared) {
        setNotice({ kind: 'info', title: 'Swap cancelled', body: 'The price moved and you kept the earlier minimum. Nothing was signed.' });
        return;
      }
      texts.received = `${formatUnits(prepared.quote.outAmount, outDecimals)} ${outToken.symbol}`;
      texts.exposed = `${formatUnits(prepared.policy.swapAmount, inDecimals)} ${inToken.symbol}`;
      const newAccountRent = prepared.oneTimeCosts.outputAccountRent;
      setPending({
        minReceived: `${formatExact(prepared.quote.minOut, outDecimals)} ${outToken.symbol}`,
        networkFee: `${formatExact(prepared.networkFeeLamports, 9)} SOL`,
        oneTimeCost: newAccountRent > 0n
          ? `${formatExact(newAccountRent, 9)} SOL opens your ${outToken.symbol} account (one time, stays yours)`
          : null,
        removesDelegate: prepared.notices.removesDelegate
          ? `It also removes an existing spending permission (delegate) on your ${outToken.symbol} account.`
          : null,
        certificate: prepared.certificate,
        inSymbol: inToken.symbol,
        outSymbol: outToken.symbol,
      });
      setPhase('wallet');
      const signed = await walletSign(wallet, account, new Uint8Array(getTransactionEncoder().encode(prepared.transaction)));

      setPhase('sending');
      const result = await finalizeProtectedSwap({
        rpc: getRpc(), prepared, walletSignedBytes: signed, ephemeral: E,
        onStatus: (s, signature) => {
          if (s !== 'sending') return;
          // Recorded before anything is sent, so it is never lost (C-03).
          sent.signature = signature;
          setHistory(addHistory({ at: Date.now(), signature, status: 'pending', ...texts }));
        },
      });
      setHistory(updateHistory(result.signature, result.status));
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

  const inWarnings = tokenIn ? tokenWarnings(tokenIn) : [];
  const outWarnings = tokenOut ? tokenWarnings(tokenOut) : [];
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
              ? `Minimum output ${formatExact(quote.minOut, outDecimals)} ${tokenOut.symbol} · enforced on successful execution`
              : ' '}
          </p>
        </div>

        {[...inWarnings, ...outWarnings].length > 0 && (
          <ul className="warnings">
            {[...inWarnings, ...outWarnings].map(w => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}

        <div className="protection">
          <p className="protection-title">
            <ShieldIcon /> Wallet authority protected
          </p>
          <div className="protection-row">
            <span>Other tokens and NFTs</span>
            <span>Not exposed</span>
          </div>
          <div className="protection-row">
            <span>Wallet authority</span>
            <span>Never shared</span>
          </div>
          <div className="protection-row">
            <span>Persistent permissions</span>
            <span>None created</span>
          </div>
          <div className="protection-row">
            <span>Temporary key</span>
            <span>Used once, never stored</span>
          </div>
          <details className="how">
            <summary>How it works</summary>
            <p>
              Bound moves exactly the amount you swap into a temporary account controlled by a one-time key, and only that
              account is given to the swap program. No spending authority is granted over your other wallet assets, and no
              permission outlives the transaction. Before your wallet opens, 7 rules check the exact transaction; after you
              sign, Bound checks it again and only then adds the temporary key&apos;s signature, the last one required. The
              minimum output is enforced on successful execution: if less would arrive, the whole swap reverts.
            </p>
          </details>
        </div>

        <div className="details">
          {quote && (
            <div className="detail-row">
              <span>Route</span>
              <span>{quote.route.join(' → ')}</span>
            </div>
          )}
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
          <div className="banner info" role="alertdialog" aria-label="The price moved">
            <p className="banner-title">The price moved since you looked</p>
            <p>
              Minimum received is now <strong>{offer.now}</strong> (was {offer.was}). Nothing has been signed.
            </p>
            <div className="banner-actions">
              <button className="primary" onClick={() => decideOffer.current?.(true)}>
                Continue with the new minimum
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
              </p>
            )}
            {pending && <CertificateCard pending={pending} />}
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
        <p>Bound never asks for your seed phrase. Alpha: swaps are limited to {status ? formatUsd(status.maxUsdPerSwap) : '$100'}.</p>
        <p>What you approve is all the swap can touch.</p>
        <p>
          Bound works with any token pair Jupiter can route and Bound can safely isolate. It protects your wallet, not the
          price or value of the token you buy.
        </p>
      </footer>
    </main>
  );
}

/**
 * The certificate of the transaction the wallet is signing (idea 35): issued by the verifier only
 * after every rule held, and bound to the exact message by its SHA-256.
 */
function CertificateCard({ pending }: { pending: Pending }) {
  const c = pending.certificate;
  const amount = (v: bigint, decimals: number, symbol: string) => `${formatExact(v, decimals)} ${symbol}`;
  const rows: [string, string][] = [
    ['Approved total debit', amount(c.input.totalDebit, c.input.decimals, pending.inSymbol)],
    ['Swap amount', amount(c.input.swapAmount, c.input.decimals, pending.inSymbol)],
    ['Bound fee', amount(c.input.boundFee, c.input.decimals, pending.inSymbol)],
    ['Minimum output enforced', amount(c.output.minimumOutput, c.output.decimals, pending.outSymbol)],
    ['Other assets debited', 'None'],
    ['Persistent permissions', 'None'],
    ['Temporary authority', shortAddress(c.temporaryAuthority)],
    ['Programs invoked', String(c.programs.length)],
    ['Verifier', `${c.verifierVersion} · message ${c.messageSha256.slice(0, 12)}…`],
  ];
  return (
    <details className="certificate">
      <summary>Bound certificate for this transaction</summary>
      {rows.map(([label, value]) => (
        <div className="detail-row" key={label}>
          <span>{label}</span>
          <span>{value}</span>
        </div>
      ))}
    </details>
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
