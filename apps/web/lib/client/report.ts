'use client';

/**
 * A failure the page showed, sent to Orientim's own server (/api/report) so the operator learns of
 * failures from the logs and not only when someone writes in. What is sent: the message as shown,
 * the error's kind and first words, the token symbols and the wallet's name. The server takes out
 * anything that looks like an address or a signature before it logs, and the page sends no amount.
 */
export type ProblemReport = { kind: string; title: string; body?: string; detail?: string; pair?: string; wallet?: string };

const SAME_MS = 60_000;
const MAX_PER_PAGE = 10;
let sent = 0;
const last = new Map<string, number>();

/** Never throws, never waits: a report that cannot be sent is simply not sent. */
export function reportProblem(r: ProblemReport): void {
  try {
    const now = Date.now();
    if (sent >= MAX_PER_PAGE || now - (last.get(r.title) ?? -Infinity) < SAME_MS) return;
    last.set(r.title, now);
    sent++;
    void fetch('/api/report', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r), keepalive: true,
    }).catch(() => {});
  } catch {
    // No fetch, or JSON that cannot be written: nothing is lost but the report.
  }
}
