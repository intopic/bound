'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * How long a message stays before it goes away on its own, as on other swap sites: short, since a
 * message that stays in the way is worse than one read once. The time stops while the pointer or the keyboard is on the message, and
 * while the tab is hidden, so nobody misses one by looking away.
 */
export const TOAST_MS = { success: 4_000, info: 4_000, error: 6_000 } as const;

/**
 * One message in the corner of the page, over the swap: the top right on a computer, the bottom on a
 * phone. A ✕ closes it at once. `sticky` keeps it until the page takes it back (a connection the
 * page is still retrying).
 */
export function Toast(props: {
  kind: 'error' | 'success' | 'info';
  title: string;
  sticky?: boolean;
  onClose: () => void;
  children?: ReactNode;
}) {
  const ms = TOAST_MS[props.kind];
  const [hover, setHover] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  const left = useRef<number>(ms);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  const paused = hover || hidden;

  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (props.sticky || paused) return;
    const started = Date.now();
    const timer = setTimeout(() => close.current(), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(0, left.current - (Date.now() - started));
    };
  }, [paused, props.sticky]);

  return (
    <div
      className={`toast banner ${props.kind}`}
      role="status"
      aria-live={props.kind === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={e => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHover(false)}
    >
      <span className="toast-icon" aria-hidden="true">{props.kind === 'success' ? '✓' : props.kind === 'error' ? '!' : 'i'}</span>
      <div className="toast-body">
        <p className="banner-title">{props.title}</p>
        {props.children}
      </div>
      <button className="toast-close" onClick={props.onClose} aria-label="Dismiss">✕</button>
      {!props.sticky && (
        <span
          className={`toast-timer${paused ? ' paused' : ''}`}
          style={{ animationDuration: `${ms}ms` }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
