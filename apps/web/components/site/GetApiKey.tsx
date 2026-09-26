'use client';

import { useState } from 'react';
import type { Wallet } from '@wallet-standard/base';
import { connectWallet, signsMessages, useWallets, walletSignMessage } from '@/lib/client/wallets';

/** Orientim's key message for this wallet on this site, and nothing else (the skill checks the same). */
function isKeyMessage(message: unknown, wallet: string): message is string {
  if (typeof message !== 'string' || message.length > 1_000 || !/^[\x20-\x7e\n]+$/.test(message)) return false;
  const lines = message.split('\n');
  return lines[0] === `${window.location.host} wants you to sign in with your Solana account:` && lines[1] === wallet
    && lines[3] === 'Get an Orientim API key for this wallet. Signing costs nothing and gives no access to your funds.';
}

type Issued = { key: string; wallet: string; expiresAt: string };

/**
 * An API key at once: connect the wallet the agent swaps from, sign Orientim's message, and the key
 * appears, bound to that wallet (AGENT-API.md, "API access"). Signing moves nothing.
 */
export function GetApiKey() {
  const wallets = useWallets().filter(signsMessages);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [copied, setCopied] = useState(false);

  async function get(wallet: Wallet) {
    setChoosing(false);
    setError(null);
    try {
      setBusy('Connecting…');
      const account = await connectWallet(wallet);
      if (!account) throw new Error('The wallet returned no account.');
      setBusy('Preparing the message…');
      const c = await fetch(`/api/v1/keys/challenge?wallet=${encodeURIComponent(account.address)}`);
      if (c.status === 404) throw new Error('API access opens with the public launch.');
      const challenge = await c.json() as { message?: unknown; challenge?: string; error?: { message: string } };
      if (!c.ok) throw new Error(challenge.error?.message ?? 'Orientim could not prepare the message. Try again.');
      if (!isKeyMessage(challenge.message, account.address)) throw new Error('The message was not the expected one, so nothing was signed.');
      setBusy('Sign the message in your wallet…');
      const signature = await walletSignMessage(wallet, account, new TextEncoder().encode(challenge.message));
      setBusy('Getting your key…');
      const res = await fetch('/api/v1/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: challenge.message, challenge: challenge.challenge, signature: btoa(String.fromCharCode(...signature)) }),
      });
      const body = await res.json() as Issued & { error?: { message: string } };
      if (!res.ok) throw new Error(body.error?.message ?? 'Orientim could not issue a key. Try again.');
      setIssued(body);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(/reject|denied|cancel|4001/i.test(message) ? 'Cancelled in your wallet. Nothing was signed.' : message);
    } finally {
      setBusy(null);
    }
  }

  function copy() {
    if (!issued) return;
    navigator.clipboard.writeText(issued.key).then(() => setCopied(true), () => setCopied(false));
  }

  if (issued) {
    return (
      <div className="key-box">
        <p><strong>Your API key.</strong> It is shown once: store it where your agent reads its settings, as <code>ORIENTIM_API_KEY</code>.</p>
        <div className="codebox">
          <pre><code>{issued.key}</code></pre>
          <button className="copy-btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <p className="hint">
          It works for {issued.wallet.slice(0, 4)}…{issued.wallet.slice(-4)} only, until {new Date(issued.expiresAt).toLocaleDateString()}.
          Sign again for a new one at any time.
        </p>
      </div>
    );
  }

  return (
    <div className="key-box">
      {choosing ? (
        wallets.length ? (
          <div className="key-wallets">
            {wallets.map(w => (
              <button key={w.name} className="wallet-option" onClick={() => get(w)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={w.icon} alt="" width={24} height={24} />
                {w.name}
              </button>
            ))}
          </div>
        ) : (
          <p className="hint">No wallet here can sign a message. Use the command line below instead.</p>
        )
      ) : (
        <button className="button primary-link key-button" onClick={() => setChoosing(true)} disabled={busy !== null}>
          {busy ?? 'Get an API key'}
        </button>
      )}
      {error && <p className="key-error">{error}</p>}
    </div>
  );
}
