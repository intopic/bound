/**
 * T11: what wallets actually append, read from the chain instead of from documentation.
 *
 * Bound refuses a transaction whose bytes changed after it verified them. Phantom documents that it
 * may append Lighthouse assertions, which would break that equality — but no rule about what to
 * accept should be written from a document. Every transaction Phantom ever guarded is public, so
 * this reads a sample of real mainnet transactions that invoked Lighthouse and reports:
 *
 *   - which instruction selectors are actually used, and how often;
 *   - how many accounts each one takes;
 *   - where they sit: appended at the end, or somewhere before the end;
 *   - whether the memory handlers (0 MemoryWrite, 1 MemoryClose) ever appear, which would mean a
 *     wallet writes something BEFORE the instructions it is guarding.
 *
 * It reads only. Nothing is built, signed or sent.
 *
 *   node tests/integration/lighthouse-usage.ts [--transactions 120]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { address } from '@solana/kit';
import { createRetryingRpc } from '@bound/solana';

/** The assertion program Phantom uses for its transaction guards. Immutable since slot 294179293. */
const LIGHTHOUSE_PROGRAM = address('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const WANTED = Number(arg('transactions', '120'));

const rpc = createRetryingRpc(process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com', 8);
const log = (...a: unknown[]) => console.log(...a);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Lighthouse's own names for the selectors, so the report reads as evidence, not as numbers. */
const HANDLER: Record<number, string> = {
  0: 'MemoryWrite', 1: 'MemoryClose', 2: 'AssertAccountData', 3: 'AssertAccountDataMulti',
  4: 'AssertAccountDelta', 5: 'AssertAccountInfo', 6: 'AssertAccountInfoMulti', 7: 'AssertMintAccount',
  8: 'AssertMintAccountMulti', 9: 'AssertTokenAccount', 10: 'AssertTokenAccountMulti',
  11: 'AssertStakeAccount', 12: 'AssertStakeAccountMulti', 13: 'AssertUpgradeableLoaderAccount',
  14: 'AssertUpgradeableLoaderAccountMulti', 15: 'AssertSysvarClock', 16: 'AssertMerkleTreeAccount',
  17: 'AssertBubblegumTreeConfigAccount',
};

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Decodes only the leading bytes, which is all a selector needs. */
function base58Head(s: string, bytes: number): number[] {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) return [];
    n = n * 58n + BigInt(v);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return out.slice(0, bytes);
}

type Row = {
  signature: string;
  total: number;
  /** Position of every Lighthouse instruction, and what it was. */
  hits: { at: number; handler: number; accounts: number; dataBytes: number }[];
  /** True when every Lighthouse instruction sits in one unbroken run at the very end. */
  suffixOnly: boolean;
  lastNonLighthouse: number;
  /** Which other programs the transaction called, so a bot's own use is not read as a wallet guard. */
  programs: string[];
};

/** The programs a swap goes through, used only to tell a guarded swap from a bot's own recipe. */
const LABEL: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter',
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB: 'Jupiter v4',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'Token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
  '11111111111111111111111111111111': 'System',
  ComputeBudget111111111111111111111111111111: 'ComputeBudget',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'ATA',
};

// ------------------------------------------------------------------ a sample of real transactions
log(`Reading up to ${WANTED} mainnet transactions that invoked Lighthouse…`);
const signatures: string[] = [];
let before: string | undefined;
while (signatures.length < WANTED) {
  const page = await rpc.getSignaturesForAddress(LIGHTHOUSE_PROGRAM, {
    limit: 100, ...(before ? { before: before as never } : {}), commitment: 'confirmed',
  }).send();
  if (page.length === 0) break;
  for (const row of page) if (!row.err) signatures.push(row.signature);
  before = page[page.length - 1].signature;
  await sleep(400);
}
log(`${signatures.length} successful signatures.`);

const rows: Row[] = [];
for (const signature of signatures.slice(0, WANTED)) {
  // The RPC's parsed shape is a wide union; this only reads the instruction list out of it.
  let tx: unknown = null;
  try {
    tx = await rpc.getTransaction(signature as never, {
      encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed',
    }).send();
  } catch {
    await sleep(800);
    continue;
  }
  await sleep(250);
  const instructions = (tx as {
    transaction?: { message?: { instructions?: { programId?: string; accounts?: unknown[]; data?: string }[] } };
  } | null)?.transaction?.message?.instructions;
  if (!instructions?.length) continue;

  const hits = instructions.flatMap((ix, at) => {
    if (ix.programId !== LIGHTHOUSE_PROGRAM) return [];
    const head = base58Head(ix.data ?? '', 2);
    return [{
      at,
      handler: head[0] ?? -1,
      accounts: ix.accounts?.length ?? 0,
      dataBytes: base58Head(ix.data ?? '', 4096).length,
    }];
  });
  if (!hits.length) continue;

  const lastNonLighthouse = instructions.reduce((last, ix, i) => (ix.programId === LIGHTHOUSE_PROGRAM ? last : i), -1);
  rows.push({
    signature,
    total: instructions.length,
    hits,
    suffixOnly: hits.every(h => h.at > lastNonLighthouse),
    lastNonLighthouse,
    programs: [...new Set(instructions.map(ix => ix.programId ?? '?'))]
      .filter(id => id !== LIGHTHOUSE_PROGRAM)
      .map(id => LABEL[id] ?? id.slice(0, 8)),
  });
  if (rows.length % 20 === 0) log(`  …${rows.length} transactions read`);
}

// ------------------------------------------------------------------ what the sample says
const handlers = new Map<number, { count: number; accounts: Set<number>; data: Set<number> }>();
for (const row of rows) {
  for (const hit of row.hits) {
    const seen = handlers.get(hit.handler) ?? { count: 0, accounts: new Set<number>(), data: new Set<number>() };
    seen.count++;
    seen.accounts.add(hit.accounts);
    seen.data.add(hit.dataBytes);
    handlers.set(hit.handler, seen);
  }
}
const suffixOnly = rows.filter(r => r.suffixOnly);
const notSuffix = rows.filter(r => !r.suffixOnly);
const counts = rows.map(r => r.hits.length).sort((a, b) => a - b);
const memory = rows.filter(r => r.hits.some(h => h.handler === 0 || h.handler === 1));

const table = [...handlers.entries()].sort((a, b) => b[1].count - a[1].count).map(([handler, seen]) =>
  `| ${handler} | ${HANDLER[handler] ?? 'i panjohur'} | ${seen.count} | ${[...seen.accounts].sort((a, b) => a - b).join(', ')} | `
  + `${Math.min(...seen.data)}–${Math.max(...seen.data)} |`);

const summary = [
  '',
  `Transaksione të lexuara: ${rows.length}.`,
  `Vendi: ${suffixOnly.length} i kanë të gjitha asertimet në fund (${((suffixOnly.length / (rows.length || 1)) * 100).toFixed(1)}%), `
  + `${notSuffix.length} jo.`,
  `Sa asertime për transaksion: minimumi ${counts[0] ?? 0}, mediana ${counts[Math.floor(counts.length / 2)] ?? 0}, maksimumi ${counts[counts.length - 1] ?? 0}.`,
  `Handler-at e kujtesës (0 MemoryWrite / 1 MemoryClose): ${memory.length} transaksione.`,
  '',
  '| Selektori | Emri | Sa herë | Numri i llogarive | Bajte të dhënash |',
  '| --- | --- | --- | --- | --- |',
  ...table,
].join('\n');

log(summary);

// Lighthouse is a public program: a bot can call it inside its own recipe, and that is not a
// wallet appending a guard. Grouping by the other programs involved separates the two.
const byShape = new Map<string, { count: number; suffix: number; example: string }>();
for (const row of rows) {
  const shape = row.programs.join(' + ') || '(vetem Lighthouse)';
  const seen = byShape.get(shape) ?? { count: 0, suffix: 0, example: row.signature };
  seen.count++;
  if (row.suffixOnly) seen.suffix++;
  byShape.set(shape, seen);
}
log('\nSi duken transaksionet, sipas programeve qe thërrasin:');
for (const [shape, seen] of [...byShape.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12)) {
  log(`  ${String(seen.count).padStart(3)}x  vetem ne fund: ${seen.suffix}/${seen.count}  ${shape}`);
  log(`        p.sh. ${seen.example}`);
}

if (notSuffix.length) {
  log('\nTransaksione ku asertimet NUK janë vetëm në fund (të parët 5):');
  for (const row of notSuffix.slice(0, 5)) {
    log(`  ${row.signature}`);
    log(`    ${row.total} instruksione [${row.programs.join(', ')}], i fundit jo-Lighthouse në ${row.lastNonLighthouse}, `
      + `Lighthouse në ${row.hits.map(h => `${h.at}:${HANDLER[h.handler] ?? h.handler}`).join(', ')}`);
  }
}
if (memory.length) {
  log('\nTransaksione që përdorin kujtesën (të parët 5):');
  for (const row of memory.slice(0, 5)) log(`  ${row.signature} → ${row.hits.map(h => `${h.at}:${HANDLER[h.handler] ?? h.handler}`).join(', ')}`);
}

mkdirSync('tests/integration/results', { recursive: true });
writeFileSync('tests/integration/results/lighthouse-usage.md', [
  '# T11 — çfarë shtojnë vërtet wallet-et, lexuar nga zinxhiri',
  '',
  `Një mostër transaksionesh reale në mainnet që thërrasin Lighthouse (${LIGHTHOUSE_PROGRAM}).`,
  'Kjo nuk tregon çfarë i bën Phantom-i një transaksioni të Bound-it — atë e tregon vetëm testi me',
  'wallet-in e vërtetë te /diagnostic. Lighthouse është program publik: bot-ët dhe protokollet e',
  'thërrasin brenda recetës së tyre, prandaj pozicioni në këtë mostër nuk i atribuohet dot një',
  'wallet-i. Ajo që vlen këtu është forma: cilët handler-a përdoren, me sa llogari, dhe sa prej tyre.',
  summary,
  '',
  '| Transaksioni | Instruksione | Programet e tjera | Lighthouse në pozicionet | Vetëm në fund |',
  '| --- | --- | --- | --- | --- |',
  ...rows.slice(0, 80).map(r =>
    `| ${r.signature.slice(0, 16)}… | ${r.total} | ${r.programs.join(', ')} | ${r.hits.map(h => `${h.at}:${HANDLER[h.handler] ?? h.handler}`).join(', ')} | ${r.suffixOnly ? 'po' : 'JO'} |`),
  '',
].join('\n'));
log('\nT11 → tests/integration/results/lighthouse-usage.md');
