import { readBodyLimited } from './body';
import { clientKey, fromAnotherSite, rateLimited } from './rateLimit';

const MAX_BODY_BYTES = 4 * 1024;
const PER_MINUTE = 20;
const FIELDS = { title: 200, body: 400, detail: 600, pair: 60, wallet: 60, kind: 10 } as const;

/**
 * Anything that looks like a Solana address or signature (base58, 32 characters or more) is taken
 * out, so a report cannot name a wallet or a transaction, whatever the browser sends.
 */
const withoutAddresses = (s: string) => s.replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, '…').replace(/[\u0000-\u001f\u007f]+/g, ' ');

/**
 * A number in any form (12, 0.5, 1,000, 1 000, 1e9) or a hex literal (0x1771). Messages carry
 * amounts ("Your wallet has 0.5 SOL") and program logs carry lamports, so every decimal number
 * becomes "#". A hex literal is a program's error code, never an amount, and is kept.
 */
const NUMBER = /0x[0-9a-f]+\b|\d+(?:[.,_'\u00a0\u202f ]\d+)*(?:e[+-]?\d+)?/gi;

/** Addresses, signatures and numbers are taken out: a report names no wallet, transaction or amount. */
export const redact = (s: string) => withoutAddresses(s).replace(NUMBER, n => (/^0x/i.test(n) ? n : '#'));

export type Report = { -readonly [K in keyof typeof FIELDS]?: string };

/** The report as it is logged: known fields only, each a redacted string within its length. */
export function cleanReport(raw: unknown): Report | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Report = {};
  for (const [field, max] of Object.entries(FIELDS) as [keyof Report, number][]) {
    const v = (raw as Record<string, unknown>)[field];
    // The wallet field is the wallet app's name and version ("Phantom 25.1"): its numbers are kept.
    if (typeof v === 'string' && v) out[field] = (field === 'wallet' ? withoutAddresses : redact)(v).slice(0, max);
  }
  return out.title ? out : null;
}

/**
 * A failure the page showed, sent by the page so the operator sees failures in the host's logs
 * (Vercel → Logs, search "orientim-problem") and not only when someone writes in. Nothing is
 * stored: one log line, with no wallet address, signature or amount.
 */
export async function receiveReport(req: Request, log: (line: string) => void = l => console.warn(l)): Promise<Response> {
  if (fromAnotherSite(req)) return new Response(null, { status: 403 });
  if (rateLimited(`report:${clientKey(req)}`, PER_MINUTE)) return new Response(null, { status: 429 });
  const text = await readBodyLimited(req, MAX_BODY_BYTES);
  if (text === null) return new Response(null, { status: 413 });
  let report: Report | null = null;
  try {
    report = cleanReport(JSON.parse(text));
  } catch {
    // Not JSON: nothing to log.
  }
  if (!report) return new Response(null, { status: 400 });
  log(JSON.stringify({ type: 'orientim-problem', ...report }));
  return new Response(null, { status: 204 });
}
