import { readBodyLimited } from './body';
import { clientKey, fromAnotherSite, rateLimited } from './rateLimit';

const MAX_BODY_BYTES = 4 * 1024;
const PER_MINUTE = 20;
const FIELDS = { title: 200, body: 400, detail: 600, pair: 60, wallet: 60, kind: 10 } as const;

/**
 * Anything that looks like a Solana address or signature (base58, 32 characters or more) is taken
 * out, so a report cannot name a wallet or a transaction, whatever the browser sends.
 */
export const redact = (s: string) => s.replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, '…').replace(/[\u0000-\u001f\u007f]+/g, ' ');

export type Report = { -readonly [K in keyof typeof FIELDS]?: string };

/** The report as it is logged: known fields only, each a redacted string within its length. */
export function cleanReport(raw: unknown): Report | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Report = {};
  for (const [field, max] of Object.entries(FIELDS) as [keyof Report, number][]) {
    const v = (raw as Record<string, unknown>)[field];
    if (typeof v === 'string' && v) out[field] = redact(v).slice(0, max);
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
