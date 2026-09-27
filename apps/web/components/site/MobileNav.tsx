'use client';

import { useEffect, useRef, useState } from 'react';
import { MAIN_NAV } from './nav';

/** On a phone the header has no room for the links: one button opens them as a panel under it. */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    // Grown past the phone width, the header shows the links again and the panel must go.
    const wide = window.matchMedia('(min-width: 641px)');
    const onWide = () => wide.matches && setOpen(false);
    window.addEventListener('keydown', onKey);
    wide.addEventListener('change', onWide);
    return () => {
      window.removeEventListener('keydown', onKey);
      wide.removeEventListener('change', onWide);
    };
  }, [open]);

  return (
    <div className="mobile-nav">
      <button
        ref={button}
        type="button"
        className="mobile-nav-toggle"
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        aria-label={open ? 'Close menu' : 'Open menu'}
        onClick={() => setOpen(o => !o)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
      </button>
      {open && (
        <>
          <div className="mobile-nav-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
          <nav id="mobile-nav-panel" className="mobile-nav-panel" aria-label="Main">
            {MAIN_NAV.map(([label, href]) => (
              <a key={href} href={href} onClick={() => setOpen(false)}>{label}</a>
            ))}
          </nav>
        </>
      )}
    </div>
  );
}
