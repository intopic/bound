import type { ReactNode } from 'react';

/** Orientim's mark: a compass needle, the half that points the way in green. */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo-mark">
      <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--mark-bg)" stroke="var(--mark-line)" />
      <path d="M24 8 17.8 17.8 14.2 14.2Z" fill="var(--accent)" />
      <path d="M8 24 14.2 14.2 17.8 17.8Z" fill="var(--mark-dim)" />
      <circle cx="16" cy="16" r="1.4" fill="var(--bg)" />
    </svg>
  );
}

export function Logo() {
  return (
    <a className="logo" href="/" aria-label="Orientim, home">
      <LogoMark />
      <span>Orientim</span>
    </a>
  );
}

export function ShieldIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

/** The header of every page: the swap page puts the wallet on the right, the other pages a way back to it. */
export function SiteHeader({ right }: { right: ReactNode }) {
  return (
    <header className="site-header">
      <div className="container header-row">
        <Logo />
        <nav className="site-nav" aria-label="Main">
          <a href="/#swap">Swap</a>
          <a href="/#how">How it works</a>
          <a href="/#agents">Agents</a>
          <a href="/#security">Security</a>
          <a href="/docs">Docs</a>
        </nav>
        <div className="header-right">{right}</div>
      </div>
    </header>
  );
}

const FOOTER: [string, [string, string][]][] = [
  ['Product', [['Swap', '/#swap'], ['Supported tokens', '/security#supported'], ['Fees', '/security#fees'], ['Status', '/status']]],
  ['Developers', [['Docs', '/docs'], ['Agent skill', '/docs#skill'], ['API', '/docs#api'], ['API access', '/docs#access']]],
  ['Trust', [['Security', '/security'], ['Proof and reviews', '/proof'], ['Terms and risks', '/terms'], ['Privacy', '/privacy']]],
];

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div className="footer-brand">
          <Logo />
          <p>Protected swaps on Solana, for people and AI agents. Orientim never holds your funds and never asks for your seed phrase.</p>
        </div>
        {FOOTER.map(([title, links]) => (
          <div key={title} className="footer-col">
            <p className="footer-title">{title}</p>
            <ul>
              {links.map(([label, href]) => (
                <li key={href}><a href={href}>{label}</a></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="container footer-bottom">
        <span>© {new Date().getFullYear()} Orientim</span>
        <span className="footer-note"><span className="dot" aria-hidden="true" /> Open the app only at orientim.com</span>
      </div>
    </footer>
  );
}
