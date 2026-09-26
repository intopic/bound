'use client';

import { useState } from 'react';
import { Modal } from './Modal';
import {
  isChoice, MAX_CHOSEN_BPS, MIN_CHOSEN_BPS, parsePercent, percentText, SLIPPAGE_PRESETS, WARN_ABOVE_BPS,
} from '@/lib/client/slippage';
import type { SlippageChoice } from '@/lib/client/slippage';

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/**
 * The slippage setting, as swap sites have it: Auto by default, a few presets, or a value of one's
 * own from 0.1% to 15%. The card shows the current one beside the gear.
 */
export function SlippageSettings(props: { choice: SlippageChoice; onChange: (choice: SlippageChoice) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const { choice } = props;
  const custom = choice !== 'auto' && !(SLIPPAGE_PRESETS as readonly number[]).includes(choice);
  const high = choice !== 'auto' && choice > WARN_ABOVE_BPS;
  const typedBps = typed ? parsePercent(typed) : null;
  const label = choice === 'auto' ? 'Auto' : percentText(choice);

  const pick = (c: SlippageChoice) => {
    if (!isChoice(c)) return;
    setTyped('');
    props.onChange(c);
  };

  return (
    <>
      <button
        type="button"
        className={`slippage-button${high ? ' high' : ''}${choice === 'auto' ? ' auto' : ''}`}
        onClick={() => setOpen(true)}
        disabled={props.disabled}
        title="Slippage tolerance"
        aria-label={`Slippage tolerance: ${label}. Change it`}
      >
        <GearIcon />
        <span>{label}</span>
      </button>
      {open && (
        <Modal title="Slippage tolerance" onClose={() => setOpen(false)}>
          <p className="hint slippage-intro">
            How far below the quote your swap may fill. If less than your minimum would arrive, the whole swap cancels itself.
          </p>
          <div className="slippage-options" role="radiogroup" aria-label="Slippage tolerance">
            <button type="button" role="radio" aria-checked={choice === 'auto'} className={`slippage-option${choice === 'auto' ? ' on' : ''}`} onClick={() => pick('auto')}>
              Auto
            </button>
            {SLIPPAGE_PRESETS.map(bps => (
              <button key={bps} type="button" role="radio" aria-checked={choice === bps} className={`slippage-option${choice === bps ? ' on' : ''}`} onClick={() => pick(bps)}>
                {percentText(bps)}
              </button>
            ))}
            <label className={`slippage-custom${custom ? ' on' : ''}`}>
              <input
                inputMode="decimal"
                placeholder={custom ? percentText(choice as number).slice(0, -1) : 'Custom'}
                value={typed}
                aria-label="Custom slippage, in percent"
                onChange={e => {
                  setTyped(e.target.value);
                  const bps = parsePercent(e.target.value);
                  if (bps !== null) props.onChange(bps);
                }}
              />
              <span aria-hidden="true">%</span>
            </label>
          </div>
          {choice === 'auto' && <p className="hint">Auto is 0.5%, or 3% for a token still on its Pump.fun launch curve.</p>}
          {typed && typedBps === null && (
            <p className="key-error">Enter {percentText(MIN_CHOSEN_BPS)} to {percentText(MAX_CHOSEN_BPS)}.</p>
          )}
          {high && (
            <p className="warnings slippage-warning">
              High tolerance: you may receive much less than the quote, and trading bots can take the difference. It is kept for this visit only.
            </p>
          )}
          <button type="button" className="primary slippage-done" onClick={() => setOpen(false)}>Done</button>
        </Modal>
      )}
    </>
  );
}
