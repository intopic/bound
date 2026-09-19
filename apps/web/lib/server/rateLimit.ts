/**
 * Fixed-window rate limit kept in memory, per instance. Nothing is persisted and nothing about the
 * request body is recorded (D8): only a counter per client key for the current window.
 *
 * This is a local layer only. A limit that holds across instances belongs to the hosting
 * platform's own rate-limit rules (e.g. the Vercel firewall), not to a database of ours.
 */
const windows = new Map<string, { count: number; resetAt: number }>();
const MAX_KEYS = 50_000;
let nextSweep = 0;

export function rateLimited(key: string, limit: number, windowMs = 60_000): boolean {
  const now = Date.now();
  // Sweep expired windows at most once a minute instead of scanning inside every request (B-06).
  if (now >= nextSweep) {
    for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
    nextSweep = now + 60_000;
  }
  // Under a flood of new keys, drop the oldest windows instead of resetting everyone (C-04).
  if (windows.size >= MAX_KEYS && !windows.has(key)) {
    let drop = Math.ceil(MAX_KEYS / 10);
    for (const k of windows.keys()) {
      windows.delete(k);
      if (--drop === 0) break;
    }
  }
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  w.count++;
  return w.count > limit;
}

/**
 * The client address, from the one header the deployment's ingress overwrites (audit B-06, C-04).
 * Which header that is depends on where Bound runs, so it is configuration, never a guess:
 * `BOUND_CLIENT_IP_HEADER` (default `x-vercel-forwarded-for`, which Vercel sets itself; behind
 * Cloudflare use `cf-connecting-ip`). Any other client-supplied header is ignored. Without the
 * configured header every request shares one bucket, which fails towards limiting, not bypass.
 */
export function clientKey(req: Request): string {
  const header = (process.env.BOUND_CLIENT_IP_HEADER || 'x-vercel-forwarded-for').toLowerCase();
  const value = req.headers.get(header)?.split(',')[0].trim();
  return value || 'unidentified';
}
