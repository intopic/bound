'use client';

import { useEffect, useRef, useState } from 'react';
import type { TokenInfo } from '@bound/jupiter';
import { isSupported, searchTokens } from '@/lib/client/tokens';
import { shortAddress } from '@/lib/client/format';

/**
 * Icons are served by Bound's own origin (audit B-08): the browser never contacts the hosts that
 * token creators choose, and the page's img-src stays 'self' data:. A letter is shown when the
 * icon is missing or its host is not on the server's list.
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

export function TokenPicker(props: {
  popular: readonly TokenInfo[];
  exclude?: string;
  onPick: (token: TokenInfo) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TokenInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    setLoading(true);
    // Only the answer for the query on screen may fill the list: a slower answer for an older
    // query is dropped, even if its request already started (audit C-10).
    let stale = false;
    const timer = setTimeout(() => {
      searchTokens(q)
        .then(list => !stale && setResults(list))
        .catch(() => !stale && setResults([]))
        .finally(() => !stale && setLoading(false));
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);

  const list = (results ?? props.popular).filter(t => t.id !== props.exclude);

  return (
    <div className="picker" role="dialog" aria-label="Select a token">
      <div className="picker-head">
        <input
          ref={input}
          className="picker-search"
          placeholder="Search by name, symbol or address"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Escape' && props.onClose()}
        />
        <button className="ghost" onClick={props.onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <ul className="picker-list">
        {loading && <li className="picker-empty">Searching…</li>}
        {!loading && list.length === 0 && <li className="picker-empty">No tokens found</li>}
        {!loading &&
          list.map(t => {
            const supported = isSupported(t);
            return (
              <li key={t.id}>
                <button className="picker-item" disabled={!supported} onClick={() => props.onPick(t)}>
                  <TokenIcon token={t} size={28} />
                  <span className="picker-text">
                    <span className="picker-symbol">
                      {t.symbol}
                      {t.isVerified && <span className="badge ok">Verified</span>}
                      {!supported && <span className="badge">Not supported yet</span>}
                    </span>
                    <span className="picker-name">
                      {t.name} · {shortAddress(t.id)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
      </ul>
    </div>
  );
}
