'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The wallet as a group of blocks beside the headline, on the grid behind the home page. Once, when
 * the page opens, one block (the amount) lights, leaves the group and steps along the grid into the
 * swap card; the rest of the wallet stays where it is. After that, one block of the grid lights
 * softly every 10 to 15 seconds, only in the hero's empty space and only while the hero is on
 * screen. Nothing moves for people who ask their system for less motion; phones get the grid alone.
 */

/** One cell of the grid, in CSS pixels: the same as `.page-grid`'s background-size. */
const CELL = 56;
const OPEN_DELAY_MS = 1000;
const LIGHT_MS = 500;
const STEP_MS = 450;
const RETURN_AFTER_MS = 1500;

type Wallet = { col0: number; row0: number; cols: number; rows: number; steps: number; moveCol: number; moveRow: number };

type Box = { left: number; top: number; right: number; bottom: number };

const relative = (r: DOMRect, to: DOMRect): Box => ({ left: r.left - to.left, top: r.top - to.top, right: r.right - to.left, bottom: r.bottom - to.top });

function lineBoxes(el: Element): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(el);
  return [...range.getClientRects()];
}

/**
 * Where the wallet fits: beside the paragraph (and, on a wide screen, beside the title's last line),
 * between the text and the swap card, above the points. Null when it does not fit, or on a phone.
 */
function placeWallet(root: HTMLElement): Wallet | null {
  const box = root.getBoundingClientRect();
  const scope = root.parentElement;
  const title = scope?.querySelector('.hero-title');
  const sub = scope?.querySelector('.hero-sub');
  const app = scope?.querySelector('.hero-app');
  if (!title || !sub || !app || box.width <= 640) return null;
  const wide = box.width > 980;
  const subLines = lineBoxes(sub).map(r => relative(r, box));
  const titleLines = lineBoxes(title).map(r => relative(r, box));
  if (!subLines.length || !titleLines.length) return null;
  const lastTitle = titleLines[titleLines.length - 1];
  const textRight = Math.max(...subLines.map(r => r.right), wide ? lastTitle.right : 0);
  const endX = wide ? relative(app.getBoundingClientRect(), box).left : box.width;
  const col0 = Math.ceil((textRight + 18) / CELL);
  // Up to three columns, clear of the card by a few pixels: the block's path may be short.
  const cols = Math.min(3, Math.floor((endX - 8 - col0 * CELL) / CELL));
  const points = scope?.querySelector('.hero-points')?.getBoundingClientRect();
  const bandTop = wide ? lastTitle.top : lastTitle.bottom + 4;
  const bandBottom = (points && points.height ? relative(points, box).top : subLines[subLines.length - 1].bottom) - 6;
  const row0 = (wide ? Math.ceil : Math.floor)(bandTop / CELL);
  const rows = Math.min(3, Math.floor(bandBottom / CELL) - row0);
  if (cols < 2 || rows < 2) return null;
  const moveCol = col0 + cols - 1;
  const steps = Math.max(2, Math.ceil((endX - (moveCol + 1) * CELL) / CELL) + 1);
  return { col0, row0, cols, rows, steps, moveCol, moveRow: row0 + Math.floor(rows / 2) };
}

export function HeroBlocks() {
  const root = useRef<HTMLDivElement>(null);
  const runner = useRef<HTMLDivElement>(null);
  const trail = useRef<HTMLDivElement>(null);
  const lights = useRef<HTMLDivElement>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [away, setAway] = useState(false);

  // Where the wallet sits, again on every resize.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWallet(placeWallet(el)));
    };
    void document.fonts?.ready.then(place);
    place();
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', place);
    };
  }, []);

  const placed = wallet !== null;
  // The amount leaves the wallet once, when the page opens.
  useEffect(() => {
    const el = root.current;
    if (!placed || !el || !wallet) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const running: Animation[] = [];
    timers.push(setTimeout(() => {
      const hero = el.parentElement?.querySelector('.hero')?.getBoundingClientRect();
      if (!hero || hero.bottom <= 0 || hero.top >= innerHeight) return;
      const moveMs = wallet.steps * STEP_MS;
      const total = LIGHT_MS + moveMs + 300;
      const frames = (peak: number, light: boolean): Keyframe[] => {
        const f: Keyframe[] = [{ offset: 0, opacity: 0, transform: 'translateX(0)' }];
        f.push({ offset: LIGHT_MS / total, opacity: light ? peak : 0, transform: 'translateX(0)', easing: 'ease-in-out' });
        for (let i = 1; i <= wallet.steps; i++) {
          f.push({ offset: (LIGHT_MS + i * STEP_MS) / total, opacity: peak, transform: `translateX(${i * CELL}px)`, easing: 'ease-in-out' });
        }
        f.push({ offset: 1, opacity: 0, transform: `translateX(${wallet.steps * CELL}px)` });
        return f;
      };
      if (runner.current) running.push(runner.current.animate(frames(1, true), { duration: total, fill: 'forwards' }));
      if (trail.current) running.push(trail.current.animate(frames(0.28, false), { duration: total, delay: 110, fill: 'forwards' }));
      timers.push(setTimeout(() => setAway(true), LIGHT_MS));
      timers.push(setTimeout(() => setAway(false), total + RETURN_AFTER_MS));
    }, OPEN_DELAY_MS));
    return () => {
      timers.forEach(clearTimeout);
      running.forEach(a => a.cancel());
      setAway(false);
    };
    // Once per page: a resize moves the wallet, it does not replay the swap.
  }, [placed]);

  // Then, now and then, one block of the hero's empty space lights softly.
  useEffect(() => {
    const el = root.current;
    const layer = lights.current;
    const hero = el?.parentElement?.querySelector('.hero');
    if (!el || !layer || !hero) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let visible = true;
    const seen = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    seen.observe(hero);
    let timer: ReturnType<typeof setTimeout>;
    const light = () => {
      const box = el.getBoundingClientRect();
      if (visible && document.visibilityState === 'visible' && box.width > 640) {
        const h = relative(hero.getBoundingClientRect(), box);
        const busy = [...(el.parentElement?.querySelectorAll('.hero-copy > *, .hero-app, .hb-wallet') ?? [])]
          .map(n => relative(n.getBoundingClientRect(), box));
        for (let tries = 0; tries < 24; tries++) {
          const col = Math.floor(Math.random() * Math.floor(box.width / CELL));
          const row = Math.ceil(h.top / CELL) + Math.floor(Math.random() * Math.max(1, Math.floor((h.bottom - h.top) / CELL) - 1));
          const x = col * CELL, y = row * CELL;
          if (y + CELL > h.bottom) continue;
          if (busy.some(b => x + CELL > b.left - 8 && x < b.right + 8 && y + CELL > b.top - 8 && y < b.bottom + 8)) continue;
          const lit = document.createElement('div');
          lit.className = 'hb-lit';
          lit.style.transform = `translate(${x}px, ${y}px)`;
          lit.addEventListener('animationend', () => lit.remove());
          layer.appendChild(lit);
          break;
        }
      }
      timer = setTimeout(light, 10_000 + Math.random() * 5_000);
    };
    timer = setTimeout(light, 10_000 + Math.random() * 5_000);
    return () => {
      clearTimeout(timer);
      seen.disconnect();
    };
  }, []);

  const at = (col: number, row: number) => ({ transform: `translate(${col * CELL}px, ${row * CELL}px)` });
  return (
    <div ref={root} className="hero-blocks" aria-hidden="true">
      {wallet && (
        <>
          <div
            className="hb-light"
            style={{ transform: `translate(${(wallet.col0 + wallet.cols / 2) * CELL - 320}px, ${(wallet.row0 + wallet.rows / 2) * CELL - 320}px)` }}
          />
          <div
            className="hb-wallet"
            style={{ ...at(wallet.col0, wallet.row0), width: wallet.cols * CELL, height: wallet.rows * CELL }}
          />
          {Array.from({ length: wallet.cols * wallet.rows }, (_, i) => {
            const col = wallet.col0 + (i % wallet.cols), row = wallet.row0 + Math.floor(i / wallet.cols);
            const moving = col === wallet.moveCol && row === wallet.moveRow;
            return <div key={`${col}:${row}`} className={`hb-tile${moving && away ? ' away' : ''}`} style={at(col, row)} />;
          })}
          <div className={`hb-slot${away ? ' on' : ''}`} style={at(wallet.moveCol, wallet.moveRow)} />
          <div className="hb-move" style={at(wallet.moveCol, wallet.moveRow)}>
            <div ref={trail} className="hb-runner" />
            <div ref={runner} className="hb-runner" />
          </div>
        </>
      )}
      <div ref={lights} />
    </div>
  );
}
