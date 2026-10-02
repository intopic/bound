/**
 * What the operator counts: one line of JSON per event in the deployment's logs, under a name that
 * starts with `orientim.` (on Vercel: Logs, search `orientim.prepare`, say). It says what happened
 * and how long it took; never an API key, a secret, a signature's bytes or a transaction. An agent is
 * named by its key's id (`w:<wallet>` for a self-serve key), as the other log lines name it.
 */
export type EventFields = Record<string, string | number | boolean | null>;

export function logEvent(name: string, fields: EventFields): void {
  try {
    console.info(JSON.stringify({ event: `orientim.${name}`, ...fields }));
  } catch {
    // A log line never fails a request.
  }
}

/**
 * An endpoint's answer, observed: its HTTP status, its error code when it is an error, finalize's
 * `status` (sent, unknown or rejected) when it answered, and the time it took. The answer itself is
 * returned unchanged.
 */
export async function observed(name: 'prepare' | 'finalize', run: () => Promise<Response>): Promise<Response> {
  const started = performance.now();
  const res = await run();
  const fields: EventFields = { http: res.status, ms: Math.round(performance.now() - started) };
  if (res.status >= 400 || name === 'finalize') {
    try {
      const body = (await res.clone().json()) as { error?: { code?: unknown }; status?: unknown };
      if (typeof body?.error?.code === 'string') fields.code = body.error.code;
      if (name === 'finalize' && typeof body?.status === 'string') fields.status = body.status;
    } catch {
      // An answer that is not JSON is counted by its status alone.
    }
  }
  logEvent(name, fields);
  return res;
}
