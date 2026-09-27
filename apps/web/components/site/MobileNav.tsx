'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { MAIN_NAV } from './nav';

/** On a phone the header has no room for the links: one button opens them as a panel under it. */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  // A new page, by a link or by Back, closes the menu.
  useEffect(() => setOpen(false), [pathname]);

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
    // Back, Forward or a jump to another part of the page: the menu has done its job.
    const onMove = () => setOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('popstate', onMove);
    window.addEventListener('hashchange', onMove);
    wide.addEventListener('change', onWide);
    // The page behind does not scroll while the menu is open, as with a window (Modal.tsx).
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onMove);
      window.removeEventListener('hashchange', onMove);
      wide.removeEventListener('change', onWide);
      document.body.style.overflow = overflow;
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
      {open && <div className="mobile-nav-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
      {/* Always in the page, hidden while closed, so the button's aria-controls names an element. */}
      <nav id="mobile-nav-panel" className="mobile-nav-panel" aria-label="Main" hidden={!open}>
        {MAIN_NAV.map(([label, href]) => (
          <a key={href} href={href} onClick={() => setOpen(false)}>{label}</a>
        ))}
      </nav>
    </div>
  );
}
