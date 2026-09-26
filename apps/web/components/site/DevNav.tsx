'use client';

import { useEffect, useState } from 'react';

export type DevNavGroup = { title: string; items: [id: string, label: string][] };

/**
 * The developer docs' contents: beside the text on a wide screen, marking the section being read;
 * on a phone, a bar under the header that opens the same list.
 */
export function DevNav({ groups }: { groups: DevNavGroup[] }) {
  const items = groups.flatMap(g => g.items);
  const [active, setActive] = useState(items[0]?.[0] ?? '');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const ids = groups.flatMap(g => g.items.map(([id]) => id));
    let frame = 0;
    // The section being read is the last one whose top has passed under the header.
    const update = () => {
      frame = 0;
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 140) current = id;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = ids[ids.length - 1];
      setActive(current);
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', later, { passive: true });
    window.addEventListener('resize', later);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', later);
      window.removeEventListener('resize', later);
    };
  }, [groups]);

  const current = items.find(([id]) => id === active)?.[1];
  return (
    <nav className={`dev-nav${open ? ' open' : ''}`} aria-label="Developer docs">
      <button type="button" className="dev-nav-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span>Contents</span>
        <span className="dev-nav-current">{current}</span>
      </button>
      <div className="dev-nav-list">
        {groups.map(g => (
          <div key={g.title} className="dev-nav-group">
            <p className="dev-nav-title">{g.title}</p>
            <ul>
              {g.items.map(([id, label]) => (
                <li key={id}>
                  <a href={`#${id}`} aria-current={active === id ? 'location' : undefined} onClick={() => setOpen(false)}>{label}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
