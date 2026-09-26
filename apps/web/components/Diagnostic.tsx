'use client';

import { useEffect, useState } from 'react';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { address, getTransactionEncoder } from '@solana/kit';
import { JUPITER_PROGRAM } from '@orientim/core';
import type { TxVersion } from '@orientim/core';
import { DEFAULT_SETTINGS, prepareProtectedSwap } from '@orientim/jupiter';
import { createEphemeral } from '@orientim/solana';
import type { PublicStatus } from '@/lib/server/config';
import { getJupiter, getRpc } from '@/lib/client/chain';
import { FEE_BPS, TREASURY } from '@/lib/client/config';
import { connectWallet, supportedVersions, useWallets, walletSign } from '@/lib/client/wallets';
import { readMint, SOL_MINT, USDC_MINT } from '@/lib/client/tokens';
import { parseUnits, shortAddress } from '@/lib/client/format';
import { diagnoseWalletReturn, reportText } from '@/lib/client/diagnose';
import type { WalletDiagnosis } from '@/lib/client/diagnose';
import { clearProblems, problemsReport, readProblems } from '@/lib/client/problems';
import type { Problem } from '@/lib/client/problems';

/**
 * What does a wallet do to a transaction it signs?
 *
 * Orientim's whole guarantee is that the bytes it verified are the bytes that execute, and it refuses
 * anything else. Phantom documents that it may append its own assertions. Until a real wallet has
 * been watched doing it, any rule about what to accept is a guess. This page builds a real
 * protected swap, asks the wallet to sign it, and reports exactly what came back.
 *
 * Nothing is ever sent. The signed transaction is read and thrown away.
 */
export function Diagnostic() {
  const wallets = useWallets();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [status, setStatus] = useState<PublicStatus | null>(null);

  const [inputMint, setInputMint] = useState(SOL_MINT);
  const [outputMint, setOutputMint] = useState(USDC_MINT);
  const [amount, setAmount] = useState('0.01');
  const [version, setVersion] = useState<TxVersion>(0);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ diagnosis: WalletDiagnosis; report: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // The messages the swap page showed in this browser (lib/client/problems), read once it has loaded.
  const [problems, setProblems] = useState<Problem[]>([]);
  const [problemsCopied, setProblemsCopied] = useState(false);
  useEffect(() => setProblems(readProblems()), []);

  useEffect(() => {
    fetch('/api/status').then(r => r.json()).then(setStatus).catch(() => setError('Could not reach Orientim.'));
  }, []);

  async function connect(w: Wallet) {
    setError(null);
    try {
      const acc = await connectWallet(w);
      if (!acc) throw new Error('The wallet returned no account.');
      setWallet(w);
      setAccount(acc);
      if (!supportedVersions(w).includes(version)) setVersion(version === 0 ? 1 : 0);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function run() {
    if (!wallet || !account || !status) return;
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      setBusy('Reading both mints from the chain…');
      const [inFacts, outFacts] = await Promise.all([readMint(inputMint), readMint(outputMint)]);
      if (!inFacts || !outFacts) throw new Error('One of those addresses is not a token mint.');
      const amountIn = parseUnits(amount, inFacts.decimals);
      if (amountIn === null || amountIn <= 0n) throw new Error('That amount is not a number.');

      setBusy('Building and verifying the protected swap…');
      const E = await createEphemeral();
      const owner = address(account.address);
      const prepared = await prepareProtectedSwap(
        {
          rpc: getRpc(),
          jupiter: getJupiter(),
          settings: {
            ...DEFAULT_SETTINGS,
            feeBps: FEE_BPS,
            treasury: TREASURY,
            excludeDexes: status.excludeDexes,
            maxNetworkFeeLamports: BigInt(status.maxNetworkFeeLamports),
            jupiterProgram: JUPITER_PROGRAM,
          },
        },
        {
          owner, ephemeral: E, inputMint: address(inputMint), outputMint: address(outputMint),
          amountIn, inputDecimals: inFacts.decimals, outputDecimals: outFacts.decimals,
          // A diagnostic must reach the wallet, so it accepts any price the pipeline would
          // otherwise stop to ask about. It never sends, so the price is irrelevant.
          acceptedMinOut: 0n, acceptedCostBps: 5_000n, version,
        },
      );

      const sent = new Uint8Array(getTransactionEncoder().encode(prepared.transaction));
      setBusy('Waiting for the wallet. Approve it — nothing will be sent.');
      const returned = await walletSign(wallet, account, sent);

      const diagnosis = diagnoseWalletReturn(sent, returned);
      setResult({ diagnosis, report: reportText(`${wallet.name} ${wallet.version}`, diagnosis) });
    } catch (e) {
      setError((e as Error).message || String(e));
    } finally {
      setBusy(null);
    }
  }

  const d = result?.diagnosis;

  return (
    <main className="page diag">
      <div className="card">
        <h1>Wallet signing diagnostic</h1>
        <p className="hint">
          Builds a real protected swap, asks your wallet to sign it, and reports what came back.
          <strong> Nothing is broadcast.</strong> The signed transaction is read and discarded, so no
          funds move — but the wallet must hold the input token for the route to build.
        </p>

      {!account ? (
        <div>
          {wallets.length === 0 && <p className="hint">No Solana wallet found in this browser.</p>}
          {wallets.map(w => (
            <button key={w.name} className="wallet-option" onClick={() => connect(w)}>
              {w.name}
            </button>
          ))}
        </div>
      ) : (
        <p className="hint">
          Connected: {wallet?.name} {wallet?.version} · {shortAddress(account.address)} · supports{' '}
          {supportedVersions(wallet!).join(', ')}
        </p>
      )}

      <div className="field">
        <label htmlFor="in">Input mint</label>
        <input id="in" value={inputMint} onChange={e => setInputMint(e.target.value.trim())} spellCheck={false} />
      </div>
      <div className="field">
        <label htmlFor="out">Output mint</label>
        <input id="out" value={outputMint} onChange={e => setOutputMint(e.target.value.trim())} spellCheck={false} />
      </div>
      <div className="field">
        <label htmlFor="amt">Amount</label>
        <input id="amt" value={amount} onChange={e => setAmount(e.target.value.trim())} inputMode="decimal" />
      </div>
      <div className="field">
        <label htmlFor="ver">Transaction version</label>
        <select id="ver" value={version} onChange={e => setVersion(Number(e.target.value) as TxVersion)}>
          <option value={0}>v0 (with lookup tables)</option>
          <option value={1}>v1</option>
        </select>
      </div>

      <button className="primary" disabled={!account || !status || busy !== null} onClick={run}>
        {busy ?? 'Build and ask the wallet to sign'}
      </button>

      {error && <div className="banner error"><p>{error}</p></div>}

      {d && (
        <section>
          <h2>{d.identical ? 'The wallet changed nothing' : 'The wallet changed the transaction'}</h2>
          <p className="hint">
            {d.identical
              ? 'The message it signed is byte-identical to the one Orientim verified. The existing rule holds.'
              : `Its own instructions sit as a ${d.placement}. Every line below is what the acceptance rule must be written against.`}
          </p>

          {d.findings.length > 0 && (
            <ul className="findings">
              {d.findings.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          )}

          <div className="detail-row"><span>Instructions</span><span>{d.original.instructions.length} → {d.returned.instructions.length}</span></div>
          <div className="detail-row"><span>Message bytes</span><span>{d.original.messageBytes} → {d.returned.messageBytes}</span></div>
          <div className="detail-row"><span>Static accounts</span><span>{d.original.staticAccounts.length} → {d.returned.staticAccounts.length}</span></div>
          <div className="detail-row"><span>Signers</span><span>{d.original.signerCount} → {d.returned.signerCount}</span></div>
          <div className="detail-row"><span>Signed by the wallet</span><span>{d.returned.signedBy.length ? d.returned.signedBy.map(shortAddress).join(', ') : 'nobody'}</span></div>

          <button
            className="ghost"
            onClick={() => {
              navigator.clipboard.writeText(result.report).then(() => setCopied(true), () => setCopied(false));
            }}
          >
            {copied ? 'Copied' : 'Copy the full report'}
          </button>
          <pre className="raw">{result.report}</pre>
        </section>
      )}

      <section>
        <h2>Messages the swap page showed in this browser</h2>
        <p className="hint">
          Every message other than a success, with the error behind it: the last 20, kept only in this
          browser and never sent anywhere. Copy them when you ask for help.
        </p>
        {problems.length === 0 ? (
          <p className="hint">None.</p>
        ) : (
          <>
            <ul className="findings">
              {problems.map(p => <li key={`${p.at}-${p.title}`}>{new Date(p.at).toLocaleString()} · {p.title}</li>)}
            </ul>
            <div className="banner-actions">
              <button
                className="ghost"
                onClick={() => {
                  navigator.clipboard.writeText(problemsReport(problems, navigator.userAgent))
                    .then(() => setProblemsCopied(true), () => setProblemsCopied(false));
                }}
              >
                {problemsCopied ? 'Copied' : 'Copy them all'}
              </button>
              <button className="ghost" onClick={() => { clearProblems(); setProblems([]); }}>Clear</button>
            </div>
          </>
        )}
      </section>
      </div>
    </main>
  );
}
