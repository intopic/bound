'use client';

import { useEffect, useRef, useState } from 'react';

/** Motion that explains the product; it stops for people who ask their system for less motion. */
function useReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const q = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduce(q.matches);
    const on = () => setReduce(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return reduce;
}

/**
 * The glass both diagrams are drawn in, under one prefix per drawing so their ids never meet:
 * frosted glass for the wallet and the route, green glass for what protects (the one-time key,
 * the minimum, the lock).
 */
function GlassDefs({ p }: { p: string }) {
  return (
    <defs>
      <linearGradient id={`${p}-glass`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".09" /><stop offset="1" stopColor="#fff" stopOpacity=".025" /></linearGradient>
      <linearGradient id={`${p}-edge`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".28" /><stop offset=".5" stopColor="#fff" stopOpacity=".08" /><stop offset="1" stopColor="#fff" stopOpacity=".05" /></linearGradient>
      <linearGradient id={`${p}-sheen`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".13" /><stop offset=".45" stopColor="#fff" stopOpacity=".015" /><stop offset=".46" stopColor="#fff" stopOpacity="0" /></linearGradient>
      <linearGradient id={`${p}-green`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#7ce3b0" stopOpacity=".30" /><stop offset=".55" stopColor="#4cbd85" stopOpacity=".14" /><stop offset="1" stopColor="#4cbd85" stopOpacity=".10" /></linearGradient>
      <linearGradient id={`${p}-green-strong`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#7ce3b0" stopOpacity=".62" /><stop offset="1" stopColor="#2f8f5f" stopOpacity=".45" /></linearGradient>
      <linearGradient id={`${p}-green-edge`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#c2ffe2" stopOpacity=".9" /><stop offset=".5" stopColor="#7ce3b0" stopOpacity=".38" /><stop offset="1" stopColor="#4cbd85" stopOpacity=".25" /></linearGradient>
      <radialGradient id={`${p}-bubble`} cx=".35" cy=".3" r=".85"><stop offset="0" stopColor="#fff" stopOpacity=".16" /><stop offset=".6" stopColor="#fff" stopOpacity=".04" /><stop offset="1" stopColor="#fff" stopOpacity=".02" /></radialGradient>
      <radialGradient id={`${p}-cyan`} cx=".35" cy=".3" r=".85"><stop offset="0" stopColor="#c8eeff" stopOpacity=".8" /><stop offset="1" stopColor="#5cc8ff" stopOpacity=".5" /></radialGradient>
      <filter id={`${p}-glow`} x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="0" stdDeviation="7" floodColor="#4cbd85" floodOpacity=".45" /></filter>
      <filter id={`${p}-glow-cyan`} x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#5cc8ff" floodOpacity=".45" /></filter>
      <filter id={`${p}-line-glow`} x="-30%" y="-60%" width="160%" height="220%"><feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#7ce3b0" floodOpacity=".6" /></filter>
    </defs>
  );
}
const url = (p: string, name: string) => `url(#${p}-${name})`;

/**
 * The capsule: the approved amount leaves the wallet under a one-time key, crosses the route, meets
 * the minimum on chain and comes back as the other token. The wallet's other assets never move.
 */
export function CapsuleFlow() {
  const svg = useRef<SVGSVGElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    if (reduce) el.pauseAnimations();
    else el.unpauseAnimations();
  }, [reduce]);

  return (
    <svg ref={svg} className="capsule" viewBox="0 0 960 300" role="img" aria-labelledby="capsule-title">
      <title id="capsule-title">
        The approved amount leaves your wallet under a one-time key, crosses the swap route, meets the minimum on chain and
        comes back as the token you bought. The rest of your wallet never moves.
      </title>
      <GlassDefs p="cf" />
      <rect x="20" y="40" width="210" height="220" rx="20" fill={url('cf', 'glass')} stroke={url('cf', 'edge')} />
      <rect x="20" y="40" width="210" height="220" rx="20" fill={url('cf', 'sheen')} />
      <text x="40" y="70" className="svg-label">Your wallet</text>
      <g className="svg-chip">
        <rect x="40" y="88" width="80" height="30" rx="15" /><text x="80" y="108">SOL</text>
        <rect x="130" y="88" width="80" height="30" rx="15" /><text x="170" y="108">USDC</text>
        <rect x="40" y="128" width="80" height="30" rx="15" /><text x="80" y="148">BONK</text>
        <rect x="130" y="128" width="80" height="30" rx="15" /><text x="170" y="148">NFTs</text>
      </g>
      <g transform="translate(112 180)">
        <path d="M5 12 v-5 a8 8 0 0 1 16 0 v5" fill="none" stroke="#7ce3b0" strokeWidth="3" />
        <rect x="0" y="12" width="26" height="20" rx="4" fill={url('cf', 'green-strong')} stroke={url('cf', 'green-edge')} filter={url('cf', 'glow')} />
        <rect x="0" y="12" width="26" height="20" rx="4" fill={url('cf', 'sheen')} />
      </g>
      <text x="125" y="238" textAnchor="middle" className="svg-text">never handed to the route</text>

      <path id="capsule-out" d="M230 150 C 300 150, 320 110, 390 110 L 560 110 C 620 110, 640 150, 690 150" fill="none" stroke="rgba(220,236,230,.16)" strokeWidth="2" strokeDasharray="4 6" />
      <path id="capsule-back" d="M790 200 C 780 250, 600 272, 420 272 C 300 272, 250 250, 232 212" fill="none" stroke="rgba(220,236,230,.16)" strokeWidth="2" strokeDasharray="4 6" />
      {[440, 520].map(cx => (
        <g key={cx}>
          <circle cx={cx} cy="110" r="22" fill={url('cf', 'bubble')} stroke={url('cf', 'edge')} />
          <ellipse cx={cx - 8} cy="99" rx="8" ry="3.5" fill="rgba(255,255,255,.22)" />
          <text x={cx} y="114" textAnchor="middle" className="svg-text">pool</text>
        </g>
      ))}
      <text x="480" y="66" textAnchor="middle" className="svg-label">The swap route</text>
      <text x="480" y="84" textAnchor="middle" className="svg-text">Jupiter and its markets</text>
      <text x="244" y="190" className="svg-text">only the approved amount</text>

      <g transform="translate(710 100)">
        <rect x="0" y="0" width="160" height="100" rx="16" fill={url('cf', 'green')} stroke={url('cf', 'green-edge')} filter={url('cf', 'glow')} />
        <rect x="0" y="0" width="160" height="100" rx="16" fill={url('cf', 'sheen')} />
        <text x="80" y="36" textAnchor="middle" className="svg-label">Minimum</text>
        <text x="80" y="56" textAnchor="middle" className="svg-text">enforced on chain</text>
        <path d="M64 74 l10 10 l22 -22" fill="none" stroke="#7ce3b0" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;.55;.62;.9;1" dur="7s" repeatCount="indefinite" />
        </path>
      </g>

      <g>
        <rect x="-38" y="-14" width="76" height="28" rx="14" fill={url('cf', 'green-strong')} stroke={url('cf', 'green-edge')} filter={url('cf', 'glow')} />
        <rect x="-38" y="-14" width="76" height="28" rx="14" fill={url('cf', 'sheen')} />
        <text x="0" y="4" textAnchor="middle" className="svg-capsule">1.5 SOL</text>
        <animateMotion dur="7s" repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;.5;1" calcMode="linear"><mpath href="#capsule-out" /></animateMotion>
        <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;.5;.56;1" dur="7s" repeatCount="indefinite" />
      </g>
      <g>
        <circle r="15" fill={url('cf', 'cyan')} stroke="rgba(200,238,255,.6)" filter={url('cf', 'glow-cyan')} />
        <ellipse cx="-4" cy="-8" rx="6" ry="2.5" fill="rgba(255,255,255,.22)" />
        <text y="4" textAnchor="middle" className="svg-token">USDC</text>
        <animateMotion dur="7s" repeatCount="indefinite" keyPoints="0;0;1;1" keyTimes="0;.62;.95;1" calcMode="linear"><mpath href="#capsule-back" /></animateMotion>
        <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;.6;.63;.95;1" dur="7s" repeatCount="indefinite" />
      </g>
      <text x="600" y="294" textAnchor="middle" className="svg-text">then the one-time key is gone</text>
    </svg>
  );
}

/** Whose signature the route acts with: in a typical swap the wallet's, in Orientim a one-time key's. */
export function AuthorityMap() {
  const [ours, setOurs] = useState(true);
  return (
    <div className="glass-stage">
      <div className="ambient" aria-hidden="true" />
      <div className="map">
        <div className="toggle" role="group" aria-label="Compare">
          <button type="button" aria-pressed={!ours} onClick={() => setOurs(false)}>Typical swap</button>
          <button type="button" aria-pressed={ours} onClick={() => setOurs(true)}>Orientim</button>
        </div>
        <svg viewBox="0 0 440 240" role="img" aria-label={ours ? 'In Orientim, the route acts only with a one-time key.' : 'In a typical swap, the route acts with your wallet’s signature.'}>
          <GlassDefs p="am" />
          <rect x="16" y="70" width="130" height="100" rx="16" fill={url('am', 'glass')} stroke={url('am', 'edge')} />
          <rect x="16" y="70" width="130" height="100" rx="16" fill={url('am', 'sheen')} />
          <text x="81" y="112" textAnchor="middle" className="svg-label">Your wallet</text>
          <text x="81" y="132" textAnchor="middle" className="svg-text">its signature</text>
          <rect x="294" y="70" width="130" height="100" rx="16" fill={url('am', 'glass')} stroke={url('am', 'edge')} />
          <rect x="294" y="70" width="130" height="100" rx="16" fill={url('am', 'sheen')} />
          <text x="359" y="112" textAnchor="middle" className="svg-label">The route</text>
          <text x="359" y="132" textAnchor="middle" className="svg-text">the swap programs</text>
          {ours ? (
            <g>
              <path d="M146 150 C 170 200, 176 201, 182 201" stroke="#7ce3b0" strokeWidth="2" fill="none" filter={url('am', 'line-glow')} />
              <path className="flow" d="M258 201 C 264 201, 272 200, 294 150" stroke="#7ce3b0" strokeWidth="2.5" fill="none" strokeDasharray="6 6" filter={url('am', 'line-glow')} />
              <rect x="182" y="186" width="76" height="30" rx="15" fill={url('am', 'green-strong')} stroke={url('am', 'green-edge')} filter={url('am', 'glow')} />
              <rect x="182" y="186" width="76" height="30" rx="15" fill={url('am', 'sheen')} />
              <text x="220" y="205" textAnchor="middle" className="svg-capsule">one-time key</text>
              <path d="M146 120 L294 120" stroke="#23323a" strokeWidth="2" />
              <g transform="translate(206 104)">
                <circle cx="14" cy="16" r="13" fill="#0f161d" stroke="#f28b82" />
                <path d="M8 10 l12 12 M20 10 l-12 12" stroke="#f28b82" strokeWidth="2.5" strokeLinecap="round" />
              </g>
              <text x="220" y="56" textAnchor="middle" className="svg-text svg-good">the route never acts with your wallet’s signature</text>
            </g>
          ) : (
            <g>
              <path className="flow" d="M146 120 L294 120" stroke="#f2c46b" strokeWidth="2.5" strokeDasharray="6 6" />
              <text x="220" y="104" textAnchor="middle" className="svg-text svg-warn">acts with your wallet’s signature</text>
            </g>
          )}
        </svg>
        <p className="map-caption">
          {ours
            ? 'Orientim: the route only ever holds a one-time key with the amount of this swap.'
            : 'A typical swap: your wallet signs as the authority of the swap’s instructions, and the route acts with that signature.'}
        </p>
      </div>
    </div>
  );
}

const TERMINAL: [string, string][] = [
  ['dim', '$ orientim-verify prepare   # 0.01 SOL → USDC'],
  ['ok', '✓ prepared by Orientim · ticket received'],
  ['ok', '✓ verified on the agent’s own RPC · fee 0.3% · minimum above its floor'],
  ['ok', '✓ signed by the agent · finalized with the one-time key'],
  ['cy', '✓ confirmed on mainnet · 1.222039 USDC · 4iTJ…YoTM'],
  ['', ''],
  ['dim', '# the same agent, behind a compromised server'],
  ['dim', '$ orientim-verify prepare   # the fee is sent to another wallet'],
  ['bad', '✗ refused · unexpected SOL transfer of 30000 lamports'],
  ['bad', '✗ refused · the fee goes to AQ49…, not Orientim’s treasury'],
  ['ok', '  nothing was signed'],
];

/** An agent's real run on mainnet, then the same agent refusing a tampered swap (docs/AUDIT.md 0zk). */
export function AgentTerminal() {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(TERMINAL.length);
  useEffect(() => {
    if (reduce) {
      setShown(TERMINAL.length);
      return;
    }
    let n = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setShown(n);
      n = n >= TERMINAL.length ? 0 : n + 1;
      timer = setTimeout(tick, n === 0 ? 4200 : 650);
    };
    tick();
    return () => clearTimeout(timer);
  }, [reduce]);

  return (
    <div className="terminal" aria-label="An agent's protected swap, and a refused attack">
      <div className="terminal-bar"><span /><span /><span /><em>agent · mainnet</em></div>
      <pre aria-hidden={!reduce}>
        {TERMINAL.slice(0, shown).map(([kind, line], i) => <span key={i} className={kind}>{line}{'\n'}</span>)}
        {shown < TERMINAL.length && <span className="caret" />}
      </pre>
    </div>
  );
}
