'use client';

import { useState } from 'react';

/** What an agent or a developer copies to start: the skill, the API, or the command line. */
const TABS: { id: string; label: string; code: string; note: string }[] = [
  {
    id: 'skill',
    label: 'Agent skill',
    code: 'npx skills add intopic/bound --skill orientim-protected-swap',
    note: 'Adds the skill to your coding agent: instructions, a working example and the verifier it runs before every signature.',
  },
  {
    id: 'api',
    label: 'API',
    code: [
      'curl -X POST https://orientim.com/api/v1/prepare \\',
      '  -H "Authorization: Bearer $ORIENTIM_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      "  -d '{\"owner\":\"<wallet>\",\"inputMint\":\"<mint>\",\"outputMint\":\"<mint>\",\"amountIn\":\"5000000\"}'",
    ].join('\n'),
    note: 'Returns an unsigned transaction and a ticket. Your wallet signs it; /api/v1/finalize adds the last signature and sends it.',
  },
  {
    id: 'cli',
    label: 'CLI',
    code: [
      `echo '{"intent":{"owner":"<wallet>","inputMint":"<mint>",' \\`,
      `     '"outputMint":"<mint>","amountIn":"5000000"}}' \\`,
      '  | node bin/orientim-verify.mjs prepare',
    ].join('\n'),
    note: 'For bots in any language: prepares, verifies against your own RPC, finalizes and settles. Your bot only signs.',
  },
];

export function DevTabs() {
  const [active, setActive] = useState(TABS[0].id);
  const [copied, setCopied] = useState(false);
  const tab = TABS.find(t => t.id === active) ?? TABS[0];

  function copy() {
    navigator.clipboard.writeText(tab.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    }, () => setCopied(false));
  }

  return (
    <div className="dev-card">
      <div className="tabs" role="tablist" aria-label="Ways to integrate">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === active}
            className={`tab${t.id === active ? ' active' : ''}`}
            onClick={() => { setActive(t.id); setCopied(false); }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="codebox">
        <pre><code>{tab.code}</code></pre>
        <button className="copy-btn" onClick={copy} aria-label="Copy">{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p className="dev-note">{tab.note}</p>
      <a className="text-link" href="/docs">Read the docs →</a>
    </div>
  );
}
