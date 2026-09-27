'use client';

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/**
 * A window over the page, the way swap sites open their token and wallet lists: centred on a
 * computer, a sheet from the bottom on a phone. Escape, the ✕ or a click outside closes it, and the
 * page behind does not scroll while it is open. Tab stays inside it, and on close the focus goes back
 * to what opened it.
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal(props: { title: string; onClose: () => void; children: ReactNode }) {
  const close = useRef(props.onClose);
  close.current = props.onClose;
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const box = dialog.current;
    // A field the content focuses itself (the token search) keeps the focus; otherwise the window takes it.
    if (box && !box.contains(document.activeElement)) box.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return close.current();
      if (e.key !== 'Tab' || !box) return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null);
      if (!items.length) return e.preventDefault();
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={props.title} ref={dialog} tabIndex={-1}>
        <div className="modal-head">
          <p className="modal-title">{props.title}</p>
          <button className="icon-button" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}
