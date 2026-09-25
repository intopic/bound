'use client';

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/**
 * A window over the page, the way swap sites open their token and wallet lists: centred on a
 * computer, a sheet from the bottom on a phone. Escape, the ✕ or a click outside closes it, and the
 * page behind does not scroll while it is open.
 */
export function Modal(props: { title: string; onClose: () => void; children: ReactNode }) {
  const close = useRef(props.onClose);
  close.current = props.onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={props.title}>
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
