'use client';

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

type Way = { id: string; label: string; content: ReactNode };

/**
 * The two ways to get an API key, side by side: the wallet the agent or bot runs with (a key file or a
 * signing service, which no browser can connect), and a wallet in the browser. The first is open by
 * default. Both panels stay in the page, so a reader of the HTML sees each way.
 */
export function KeyAccess({ ways }: { ways: Way[] }) {
  const [open, setOpen] = useState(ways[0]?.id);
  const base = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKey(e: KeyboardEvent, i: number) {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + ways.length) % ways.length;
    setOpen(ways[next].id);
    tabs.current[next]?.focus();
  }

  return (
    <div className="key-access">
      <div className="key-tabs" role="tablist" aria-label="How your wallet signs">
        {ways.map((w, i) => (
          <button
            key={w.id}
            ref={el => { tabs.current[i] = el; }}
            id={`${base}-tab-${w.id}`}
            role="tab"
            type="button"
            className="key-tab"
            aria-selected={open === w.id}
            aria-controls={`${base}-panel-${w.id}`}
            tabIndex={open === w.id ? 0 : -1}
            onClick={() => setOpen(w.id)}
            onKeyDown={e => onKey(e, i)}
          >
            {w.label}
          </button>
        ))}
      </div>
      {ways.map(w => (
        <div
          key={w.id}
          id={`${base}-panel-${w.id}`}
          role="tabpanel"
          aria-labelledby={`${base}-tab-${w.id}`}
          className="key-panel"
          hidden={open !== w.id}
        >
          {w.content}
        </div>
      ))}
    </div>
  );
}
