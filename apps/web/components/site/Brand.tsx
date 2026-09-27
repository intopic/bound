import type { ReactNode } from 'react';

/** Orientim's mark: the wallet as four blocks; the green one, the amount, has stepped out of it. */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo-mark">
      <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--mark-bg)" stroke="var(--mark-line)" />
      <g fill="var(--mark-dim)" fillOpacity=".5">
        <rect x="7" y="9.5" width="8" height="8" rx="2.2" />
        <rect x="7" y="19.5" width="8" height="8" rx="2.2" />
        <rect x="17" y="19.5" width="8" height="8" rx="2.2" />
      </g>
      <rect x="19.2" y="5.3" width="8" height="8" rx="2.2" fill="var(--accent)" />
    </svg>
  );
}

/** The name, with the last i's dot drawn as the same green block. */
export function Logo() {
  return (
    <a className="logo" href="/" aria-label="Orientim, home">
      <LogoMark />
      <span className="logo-name">Orient<span className="logo-i">ı</span>m</span>
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
          <a href="/security">Security</a>
          <a href="/developers">Developers</a>
        </nav>
        <div className="header-right">{right}</div>
      </div>
    </header>
  );
}

const FOOTER: [string, [string, string][]][] = [
  ['Product', [['Swap', '/#swap'], ['Supported tokens', '/security#supported'], ['Fees', '/security#fees'], ['Security', '/security'], ['Status', '/status']]],
  ['Developers', [['Overview', '/developers'], ['Quickstart', '/developers#start'], ['API reference', '/developers#api'], ['API keys', '/developers#access']]],
  ['Legal', [['Terms and risks', '/terms'], ['Privacy', '/privacy']]],
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
