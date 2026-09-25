'use client';

/**
 * What went wrong, kept in this browser so it can be read after the moment has passed.
 *
 * The page words every failure plainly and leaves the raw error to the console, where nobody who
 * is not a developer looks. A message can also be replaced by the next click before anyone reads
 * it. So every message the page shows, other than a success, is kept here with the raw error behind
 * it: the last 20, in this browser only. Nothing is ever sent anywhere. The person copies them
 * (the red message's "Copy details", or the list on /diagnostic) when they want help.
 */
export type Problem = {
  at: number;
  kind: 'error' | 'info' | 'uncaught';
  title: string;
  body?: string;
  /** The raw error behind the message: its kind, code, words and first stack lines. */
  detail?: string;
  /** What the page was doing: the pair, the amount, the wallet. */
  context?: string;
};

const KEY = 'orientim.problems.v1';
const KEEP = 20;
const MAX_FIELD = 2_000;
/** The same message again within this time (a retry loop, a double click) is kept once. */
const REPEAT_MS = 5_000;

const cut = (s: string | undefined) => (s === undefined || s.length <= MAX_FIELD ? s : `${s.slice(0, MAX_FIELD)}…`);

export function readProblems(): Problem[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((p): p is Problem => typeof p?.title === 'string' && typeof p?.at === 'number') : [];
  } catch {
    return [];
  }
}

/** Never throws: a browser that keeps nothing only loses this record, never the swap. */
export function recordProblem(p: Problem): void {
  try {
    const list = readProblems();
    const last = list[0];
    if (last && last.title === p.title && last.body === p.body && p.at - last.at < REPEAT_MS) return;
    const kept: Problem = { ...p, title: cut(p.title)!, body: cut(p.body), detail: cut(p.detail), context: cut(p.context) };
    window.localStorage.setItem(KEY, JSON.stringify([kept, ...list].slice(0, KEEP)));
  } catch {
    // Storage blocked or full: nothing to keep it in.
  }
}

export function clearProblems(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing kept, nothing to clear.
  }
}

const plain = (v: unknown) => {
  try {
    return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
  } catch {
    return String(v);
  }
};

/**
 * The raw error, as a developer would want it: its class, the codes it carries (Orientim's, an HTTP
 * status, a Solana error's context, the verifier's violations), its words, what caused it, and the
 * first lines of its stack.
 */
export function errorDetail(e: unknown): string {
  if (!(e instanceof Error)) return `thrown: ${typeof e === 'string' ? e : plain(e)}`;
  const x = e as Error & { code?: unknown; status?: unknown; context?: unknown; violations?: unknown; cause?: unknown };
  const lines = [`${x.name}: ${x.message}`];
  if (x.code !== undefined) lines.push(`code: ${String(x.code)}`);
  if (x.status !== undefined) lines.push(`status: ${String(x.status)}`);
  if (Array.isArray(x.violations) && x.violations.length) lines.push(`violations: ${plain(x.violations)}`);
  if (x.context !== undefined) lines.push(`context: ${plain(x.context)}`);
  if (x.cause !== undefined) lines.push(`cause: ${x.cause instanceof Error ? `${x.cause.name}: ${x.cause.message}` : plain(x.cause)}`);
  const stack = x.stack?.split('\n').slice(1, 5).map(l => l.trim()).filter(Boolean);
  if (stack?.length) lines.push(...stack.map(l => `  ${l}`));
  return lines.join('\n');
}

/** The text a person pastes when they ask for help. */
export function problemsReport(list: Problem[], browser: string): string {
  const out = [`Orientim messages from this browser (${list.length})`, `Browser: ${browser}`];
  for (const p of list) {
    out.push('', `${new Date(p.at).toISOString()} [${p.kind}] ${p.title}`);
    if (p.body) out.push(p.body);
    if (p.context) out.push(`while: ${p.context}`);
    if (p.detail) out.push(p.detail);
  }
  return out.join('\n');
}

/** An error thrown by a wallet extension's own script is the wallet's, not the page's. */
const fromExtension = (where: string | undefined) => !!where && /(chrome|moz|safari-web)-extension:\/\//.test(where);

/** Errors nothing caught are kept too: they are the ones the page could not word. */
export function watchUncaught(): () => void {
  const onError = (ev: ErrorEvent) => {
    if (fromExtension(ev.filename) || fromExtension((ev.error as Error | undefined)?.stack)) return;
    recordProblem({ at: Date.now(), kind: 'uncaught', title: ev.message || 'Uncaught error', detail: ev.error ? errorDetail(ev.error) : `${ev.filename}:${ev.lineno}` });
  };
  const onRejection = (ev: PromiseRejectionEvent) => {
    if (fromExtension((ev.reason as Error | undefined)?.stack)) return;
    recordProblem({ at: Date.now(), kind: 'uncaught', title: 'Unhandled rejection', detail: errorDetail(ev.reason) });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
