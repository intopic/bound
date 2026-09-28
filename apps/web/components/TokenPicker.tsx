'use client';

import { useEffect, useRef, useState } from 'react';
import { isAddress } from '@solana/kit';
import type { TokenInfo } from '@orientim/jupiter';
import { isSupported, searchTokens, SOL_MINT } from '@/lib/client/tokens';
import { formatUnits, formatUsd, shortAddress } from '@/lib/client/format';
import type { Holdings, OwnedToken } from '@/lib/client/holdings';
import { Modal } from './Modal';

/**
 * Icons are served by Orientim's own origin: the browser never contacts the hosts that token creators
 * choose, and the page's img-src stays 'self' data:. A letter is shown when the icon is missing or
 * its host is not on the server's list.
 */
export function TokenIcon({ token, size = 24 }: { token: TokenInfo | null; size?: 24 | 28 }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (!token?.icon || broken === token.id) {
    return (
      <span className={`token-icon fallback s${size}`} aria-hidden="true">
        {token?.symbol?.slice(0, 1) ?? '?'}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="token-icon"
      src={`/api/token-icon?mint=${encodeURIComponent(token.id)}`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setBroken(token.id)}
    />
  );
}

/** The quick picks at the top of the window, as swap sites show them. */
const QUICK_PICKS = 6;

/**
 * The token window: a search by name, symbol or address, quick picks, and the list. With a wallet
 * connected, the tokens it holds come first, with their balances, as on other swap sites. Picking the
 * token already on the other side swaps the two sides, as swap sites do.
 */
export function TokenPicker(props: {
  popular: readonly TokenInfo[];
  /** The connected wallet's tokens; null without a wallet or before they are read. */
  holdings?: Holdings | null;
  holdingsLoading?: boolean;
  /** The token this side has now, marked in the list. */
  selected?: string;
  onPick: (token: TokenInfo) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TokenInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const owned = new Map<string, OwnedToken>(
    [...(props.holdings?.shown ?? []), ...(props.holdings?.hidden ?? [])].map(o => [o.token.id, o]),
  );

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    // Only the answer for the query on screen may fill the list: a slower answer for an older
    // query is dropped, even if its request already started.
    let stale = false;
    // A pasted address is looked up at once; typed words wait for the typing to pause.
    const timer = setTimeout(() => {
      searchTokens(q)
        .then(list => !stale && setResults(list))
        .catch(() => !stale && setResults([]))
        .finally(() => !stale && setLoading(false));
    }, isAddress(q) ? 0 : 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Searching: the answers, with the balance of any the wallet holds. Otherwise: the wallet's tokens,
  // then the popular ones it does not hold.
  const mine = props.holdings ? [...props.holdings.shown, ...(showHidden ? props.holdings.hidden : [])].map(o => o.token) : [];
  const list = results ?? props.popular.filter(t => !mine.some(m => m.id === t.id));
  const pickFirst = () => {
    const first = !loading && [...(results ? [] : mine), ...list].find(isSupported);
    if (first) props.onPick(first);
  };
  const row = (t: TokenInfo) => {
    const supported = isSupported(t);
    const held = owned.get(t.id);
    return (
      <li key={t.id}>
        <button
          className={`picker-item${t.id === props.selected ? ' selected' : ''}`}
          disabled={!supported}
          onClick={() => props.onPick(t)}
          aria-current={t.id === props.selected ? 'true' : undefined}
        >
          <TokenIcon token={t} size={28} />
          <span className="picker-text">
            <span className="picker-symbol">
              {t.symbol}
              {t.isVerified && <span className="badge ok">Verified</span>}
              {!supported && <span className="badge">Not supported yet</span>}
            </span>
            <span className="picker-name">
              {t.id === SOL_MINT ? 'Solana' : t.name} · {shortAddress(t.id)}
            </span>
          </span>
          {held && (
            <span className="picker-balance">
              <span className="num">{formatUnits(held.amount, held.token.decimals, 4)}</span>
              {held.usd !== null && <span className="picker-usd">{formatUsd(held.usd)}</span>}
            </span>
          )}
        </button>
      </li>
    );
  };
  const hiddenCount = props.holdings?.hidden.length ?? 0;

  return (
    <Modal title="Select a token" onClose={props.onClose}>
      <input
        ref={input}
        className="picker-search"
        placeholder="Search by name, symbol or address"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && pickFirst()}
        spellCheck={false}
        autoComplete="off"
      />
      {props.popular.length > 0 && (
        <div className="quick-picks">
          {props.popular.slice(0, QUICK_PICKS).map(t => (
            <button key={t.id} className={`quick-pick${t.id === props.selected ? ' selected' : ''}`} onClick={() => props.onPick(t)}>
              <TokenIcon token={t} /> {t.symbol}
            </button>
          ))}
        </div>
      )}
      <ul className="picker-list">
        {loading && <li className="picker-empty">Searching…</li>}
        {!loading && results && results.length === 0 && (
          <li className="picker-empty">No tokens found. Paste the token&apos;s address to find any token.</li>
        )}
        {!loading && !results && props.holdingsLoading && <li className="picker-empty">Loading your tokens…</li>}
        {!loading && !results && props.holdings && (mine.length > 0 || hiddenCount > 0) && (
          <>
            <li className="picker-section">Your tokens</li>
            {mine.map(row)}
            {hiddenCount > 0 && (
              <li>
                <button className="link picker-more" onClick={() => setShowHidden(v => !v)}>
                  {showHidden ? 'Hide small and unverified tokens' : `Show ${hiddenCount} small or unverified ${hiddenCount === 1 ? 'token' : 'tokens'}`}
                </button>
              </li>
            )}
            {list.length > 0 && <li className="picker-section">Popular tokens</li>}
          </>
        )}
        {!loading && list.map(row)}
      </ul>
    </Modal>
  );
}
