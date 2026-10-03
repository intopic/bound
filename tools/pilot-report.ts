/**
 * The pilot's report: what each swap of a small group of real bots did, read from the chain, against
 * what each bot was shown before it signed. Read-only: it asks the RPC for transactions, and never
 * signs or sends anything.
 *
 * Input: the bots' logs, one JSON object per line. Each is a swap's result as `protectedSwap`
 * returns it, with its order id (`{"id", "signature", "outcome", "prepared", "received"}`), or
 * orientim-verify's finalize answer with prepare's `checked` beside it (`{"checked", "signature",
 * "outcome", "received"}`). And the bots' state directories (ORIENTIM_STATE_DIR), for the swaps
 * still kept for recovery.
 *
 * It fails (exit 1) on:
 *   - a confirmed swap whose fee did not reach the treasury, in the mint and the amount shown;
 *   - a confirmed swap whose wallet received less than the minimum it was shown (`amounts.minOut`);
 *   - an order carried out by more than one confirmed transaction;
 *   - a wallet that spent more of a mint than the owner's policy allows, in one swap or in 24 hours;
 *   - an `unknown` outcome that no state directory keeps for recovery;
 * and on what it could not check (INCOMPLETE, never a pass): a confirmed swap the RPC has no record
 * of, a treasury receipt or a received amount it cannot read, and an outcome still unknown, kept for
 * recovery. Only a report with nothing failed and nothing incomplete passes.
 *
 *   node tools/pilot-report.ts --log bots.jsonl [--log more.jsonl] [--state <dir>]... [--policy policy.json]
 *     [--rpc <url> | SOLANA_RPC_URL] [--treasury <address>]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSolanaRpc } from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** What a bot was shown before it signed, as far as this report reads it. */
export type ShownSwap = {
  wallet: string;
  version?: number;
  amounts: { amountIn: string; fee: string; feeMint?: string; minOut: string };
  certificate: { input?: { mint: string }; output: { mint: string } };
  policy?: { inputMint?: string; takerRent?: string; routeRefund?: string };
};

export type PilotEntry = { id?: string; signature: string; outcome: string; received?: string; prepared: ShownSwap };

/** One transaction as the chain tells it, for this report. */
export type ChainSwap = {
  /** Executed without an error. */
  ok: boolean;
  /** Unix seconds; null when the RPC does not say. */
  blockTime: number | null;
  /** What the treasury's balance of the fee's mint gained (lamports for SOL); null when unreadable. */
  treasuryGained: bigint | null;
  /** What the wallet received of the output (see the skill's receivedFor); null when unreadable. */
  walletReceived: bigint | null;
};

export type Limits = { maxAmountIn?: Record<string, string>; maxAmountInPerDay?: Record<string, string> };

export type Report = { rows: string[][]; failures: string[]; incomplete: string[]; notices: string[] };

/** The entries a log line can be: a protectedSwap result with its id, or a finalize answer beside prepare's checked. */
export function entryOf(line: unknown): PilotEntry | null {
  const o = line as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.signature !== 'string' || typeof o.outcome !== 'string') return null;
  const checked = o.checked as { prepared?: ShownSwap; intent?: { id?: string } } | undefined;
  const prepared = (o.prepared as ShownSwap | undefined) ?? checked?.prepared;
  if (!prepared?.amounts || !prepared.certificate?.output?.mint || typeof prepared.wallet !== 'string') return null;
  const id = typeof o.id === 'string' ? o.id : typeof o.intentId === 'string' ? o.intentId : checked?.intent?.id;
  return { ...(id ? { id } : {}), signature: o.signature, outcome: o.outcome, ...(typeof o.received === 'string' ? { received: o.received } : {}), prepared };
}

const inputMintOf = (p: ShownSwap) => p.certificate.input?.mint ?? p.policy?.inputMint ?? null;

/**
 * The report itself, from the entries and what the chain says of each signature (`chain`); pure, so
 * that it can be tested without an RPC.
 */
export async function pilotReport(
  entries: readonly PilotEntry[],
  deps: { chain: (entry: PilotEntry) => Promise<ChainSwap | null>; kept: ReadonlySet<string>; treasury: string; limits?: Limits },
): Promise<Report> {
  const failures: string[] = [];
  /** What could not be checked: not a failure, and not a pass either. */
  const incomplete: string[] = [];
  const notices: string[] = [];
  const rows: string[][] = [];
  const confirmedByOrder = new Map<string, Set<string>>();
  const spends: { wallet: string; mint: string; amount: bigint; at: number }[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.signature)) continue;
    seen.add(e.signature);
    const label = `${e.id ?? '(no id)'} ${e.signature.slice(0, 8)}…`;
    const tx = await deps.chain(e);
    const shown = e.prepared.amounts;
    const fee = BigInt(shown.fee);
    const feeMint = shown.feeMint ?? null;
    let feeCheck = '-';
    let receivedCheck = '-';
    if (e.outcome === 'confirmed') {
      if (!tx) incomplete.push(`${label}: the RPC has no record of a swap the bot says confirmed (an RPC without the history?)`);
      else if (!tx.ok) failures.push(`${label}: the bot says confirmed, the chain says it failed`);
      else {
        // The fee, where the bot was shown it would go.
        if (fee > 0n) {
          if (tx.treasuryGained === null || feeMint === null) incomplete.push(`${label}: the treasury's receipt could not be read`);
          else if (tx.treasuryGained !== fee) failures.push(`${label}: the treasury gained ${tx.treasuryGained} of ${feeMint}, the bot was shown a fee of ${fee}`);
          else feeCheck = `${fee} ok`;
        } else feeCheck = 'no fee';
        // What the wallet received, against the least it was shown.
        const least = BigInt(shown.minOut);
        if (tx.walletReceived === null) incomplete.push(`${label}: what the wallet received could not be read`);
        else if (tx.walletReceived < least) failures.push(`${label}: the wallet received ${tx.walletReceived}, below the minimum it was shown, ${least}`);
        else receivedCheck = `${tx.walletReceived} ≥ ${least}`;
        if (e.id) confirmedByOrder.set(e.id, new Set([...(confirmedByOrder.get(e.id) ?? []), e.signature]));
        const mint = inputMintOf(e.prepared);
        if (mint) spends.push({ wallet: e.prepared.wallet, mint, amount: BigInt(shown.amountIn), at: tx.blockTime ?? 0 });
      }
    } else if (e.outcome === 'unknown') {
      const now = !tx ? 'no record on the RPC yet' : tx.ok ? 'confirmed on chain' : 'failed on chain';
      if (!deps.kept.has(e.signature)) failures.push(`${label}: outcome unknown, and no state directory keeps it for recovery (${now})`);
      else incomplete.push(`${label}: outcome unknown, kept for recovery (${now}): run recover`);
    } else if (tx?.ok && e.outcome !== 'confirmed') {
      failures.push(`${label}: the bot says ${e.outcome}, the chain says it confirmed`);
    }
    rows.push([e.id ?? '-', e.signature.slice(0, 12), e.outcome, feeCheck, receivedCheck]);
  }
  for (const [id, signatures] of confirmedByOrder) {
    if (signatures.size > 1) failures.push(`order ${id} was carried out ${signatures.size} times: ${[...signatures].join(', ')}`);
  }
  // The owner's limits: each swap, and every 24 hours of confirmed swaps, by wallet and input mint.
  const one = deps.limits?.maxAmountIn ?? {};
  const daily = deps.limits?.maxAmountInPerDay ?? {};
  for (const s of spends) {
    if (one[s.mint] !== undefined && s.amount > BigInt(one[s.mint])) failures.push(`${s.wallet} spent ${s.amount} of ${s.mint} in one swap, above the owner's ${one[s.mint]}`);
  }
  for (const [mint, limit] of Object.entries(daily)) {
    const byWallet = new Map<string, typeof spends>();
    for (const s of spends.filter(x => x.mint === mint)) byWallet.set(s.wallet, [...(byWallet.get(s.wallet) ?? []), s]);
    for (const [wallet, list] of byWallet) {
      const sorted = [...list].sort((a, b) => a.at - b.at);
      for (let i = 0; i < sorted.length; i++) {
        const within = sorted.filter(x => x.at >= sorted[i].at && x.at < sorted[i].at + 86_400).reduce((t, x) => t + x.amount, 0n);
        if (within > BigInt(limit)) {
          failures.push(`${wallet} spent ${within} of ${mint} within 24 hours, above the owner's ${limit}`);
          break;
        }
      }
    }
  }
  return { rows, failures, incomplete, notices };
}

/** What the chain says of one signature: executed, when, the treasury's gain in the fee's mint, the wallet's receipt. */
export async function chainSwapOf(rpc: Rpc<SolanaRpcApi>, entry: PilotEntry, treasury: string): Promise<ChainSwap | null> {
  type Balance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
  const tx = (await rpc
    .getTransaction(entry.signature as never, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: entry.prepared.version ?? 0 } as never)
    .send()) as unknown as {
    blockTime?: number | bigint | null;
    transaction: { message: { accountKeys: string[] } };
    meta: {
      err: unknown; fee: number | bigint; preBalances: (number | bigint)[]; postBalances: (number | bigint)[];
      preTokenBalances?: Balance[] | null; postTokenBalances?: Balance[] | null;
      loadedAddresses?: { writable: string[]; readonly: string[] } | null;
    } | null;
  } | null;
  if (!tx?.meta) return null;
  const meta = tx.meta;
  const keys = [...tx.transaction.message.accountKeys, ...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? [])];
  const feeMint = entry.prepared.amounts.feeMint ?? null;
  let treasuryGained: bigint | null = null;
  if (feeMint === SOL_MINT) {
    const i = keys.indexOf(treasury);
    treasuryGained = i >= 0 ? BigInt(meta.postBalances[i]) - BigInt(meta.preBalances[i]) : 0n;
  } else if (feeMint) {
    const sum = (list: Balance[] | null | undefined) => (list ?? [])
      .filter(b => b.owner === treasury && b.mint === feeMint).reduce((t, b) => t + BigInt(b.uiTokenAmount.amount), 0n);
    treasuryGained = sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
  }
  // What the wallet received of the output: its token balance's gain, or for SOL its lamports' gain
  // with the network fee and the market's account rent (less its refund) added back, as the skill reads it.
  const out = entry.prepared.certificate.output.mint;
  let walletReceived: bigint | null = null;
  if (out === SOL_MINT) {
    const i = keys.indexOf(entry.prepared.wallet);
    const rent = BigInt(entry.prepared.policy?.takerRent ?? '0');
    const refund = BigInt(entry.prepared.policy?.routeRefund ?? '0');
    if (i >= 0) walletReceived = BigInt(meta.postBalances[i]) - BigInt(meta.preBalances[i]) + BigInt(meta.fee) + rent - refund;
  } else {
    const mine = (list: Balance[] | null | undefined) => (list ?? []).filter(b => b.owner === entry.prepared.wallet && b.mint === out);
    const before = new Map(mine(meta.preTokenBalances).map(b => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]));
    const after = mine(meta.postTokenBalances);
    if (after.length) walletReceived = after.reduce((t, b) => t + BigInt(b.uiTokenAmount.amount) - (before.get(b.accountIndex) ?? 0n), 0n);
  }
  const blockTime = tx.blockTime === undefined || tx.blockTime === null ? null : Number(tx.blockTime);
  return { ok: meta.err === null, blockTime, treasuryGained, walletReceived };
}

/** The signatures the state directories still keep for recovery (pending-<signature>.json). */
export function keptIn(dirs: readonly string[]): Set<string> {
  const kept = new Set<string>();
  for (const dir of dirs) {
    for (const f of readdirSync(dir)) {
      const m = /^pending-([1-9A-HJ-NP-Za-km-z]{64,88})\.json$/.exec(f);
      if (m) kept.add(m[1]);
    }
  }
  return kept;
}

// Run as a command (not imported by a test): the same URL on Windows, Linux and paths with spaces.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const all = (name: string) => process.argv.flatMap((a, i) => (a === name && process.argv[i + 1] ? [process.argv[i + 1]] : []));
  const one = (name: string) => all(name)[0];
  const logs = all('--log');
  const rpcUrl = one('--rpc') ?? process.env.SOLANA_RPC_URL;
  if (!logs.length || !rpcUrl) {
    console.error('usage: node tools/pilot-report.ts --log bots.jsonl [--state <dir>]... [--policy policy.json] [--rpc <url>] [--treasury <address>]');
    process.exit(2);
  }
  const treasury = one('--treasury') ?? 'ARzSA3sZGhf5t4UnYrmB3TWyZ5m3Wo1nA9zWBcoiTqLE';
  const entries: PilotEntry[] = [];
  let unreadable = 0;
  for (const path of logs) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        unreadable++;
        continue;
      }
      const e = entryOf(parsed);
      if (e) entries.push(e);
    }
  }
  const policyPath = one('--policy');
  const limits = policyPath ? (JSON.parse(readFileSync(policyPath, 'utf8')) as Limits) : undefined;
  const rpc = createSolanaRpc(rpcUrl);
  const report = await pilotReport(entries, {
    chain: e => chainSwapOf(rpc, e, treasury).catch(() => null), kept: keptIn(all('--state')), treasury, ...(limits ? { limits } : {}),
  });
  console.log('| order | signature | outcome | fee to the treasury | received ≥ minimum |');
  console.log('|---|---|---|---|---|');
  for (const r of report.rows) console.log(`| ${r.join(' | ')} |`);
  if (unreadable) report.notices.push(`${unreadable} log line(s) were not JSON`);
  for (const n of report.notices) console.log(`- note: ${n}`);
  for (const f of report.failures) console.log(`- **FAILED**: ${f}`);
  for (const i of report.incomplete) console.log(`- **INCOMPLETE**: ${i}`);
  const verdict = report.failures.length ? 'FAILED' : report.incomplete.length ? 'INCOMPLETE' : 'PASSED';
  console.log(`\n${verdict}: ${entries.length} swap(s), ${report.failures.length} failure(s), ${report.incomplete.length} not checked.`);
  if (report.failures.length || report.incomplete.length) process.exitCode = 1;
}
