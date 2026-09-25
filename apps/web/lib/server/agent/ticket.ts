import { timingSafeEqual } from 'node:crypto';
import { createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import type { KeyPairSigner } from '@solana/kit';

/**
 * The agent API is stateless (no database, and prepare and finalize may run on different
 * instances), so what finalize needs from prepare travels with the agent as a ticket, sealed with
 * a MAC only the server can make: the server keeps no state (AGENT-API.md).
 *
 * The one-time key E is not stored anywhere: it is derived from the server secret and the ticket's
 * nonce, so any instance holding the secret derives the same E. A leaked secret lets its holder
 * sign as E for Bound's own messages, which could drop the fee from them, and collect whatever is
 * left under an E it derives. The skill's check refuses to sign a swap that would leave anything
 * there: every lamport W sends E must be spent by the route or returned in the same transaction, and
 * the account a Pump.fun market opens in E's name must end closed (research audit F-06, engineering
 * review M-05). Removing an old secret stops its tickets; it cannot unlearn an E already derived.
 */
export type Ticket = {
  v: 1;
  /** Which server secret sealed it, so the secret can be rotated. */
  kid: string;
  /** Random, 16 bytes, base64url: the only input besides the secret that E is derived from. */
  nonce: string;
  /** The API key the ticket was issued to; another key cannot finalize it. */
  key: string;
  /** W, the wallet that must sign first. */
  owner: string;
  /** SHA-256 of the exact message Bound built and verified, hex. Finalize signs nothing else. */
  msg: string;
  /** After this block height the message can no longer land. */
  lvbh: string;
  /**
   * The output account and the balance its minimum-output check was built on (B and C): finalize
   * reads it again and signs nothing if it moved (review FA-04). Absent for SOL output.
   */
  wOut?: string;
  b0?: string;
};

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, enc.encode(data)));
}

const toB64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Identifies a secret without revealing it (a MAC of a fixed label, not a hash of the secret). */
export const kidOf = async (secret: Uint8Array) => hex(await hmac(secret, 'bound/agent/kid')).slice(0, 16);

/** A fresh nonce for a new ticket. */
export const newNonce = () => toB64url(globalThis.crypto.getRandomValues(new Uint8Array(16)));

/**
 * E for a ticket: an Ed25519 key whose 32-byte seed is HMAC-SHA256(secret, label + nonce). The same
 * secret and nonce give the same E on every instance; any other nonce gives an unrelated one.
 */
export async function ephemeralFor(secret: Uint8Array, nonce: string): Promise<KeyPairSigner> {
  return createKeyPairSignerFromPrivateKeyBytes(await hmac(secret, `bound/agent/ephemeral/${nonce}`));
}

/** `<payload>.<mac>`, both base64url. The payload is readable JSON; only the MAC is secret-bound. */
export async function sealTicket(secret: Uint8Array, t: Ticket): Promise<string> {
  const payload = toB64url(enc.encode(JSON.stringify(t)));
  return `${payload}.${toB64url(await hmac(secret, `bound/agent/ticket/${payload}`))}`;
}

/** Constant time, so a MAC cannot be guessed byte by byte from response times (Node's own primitive). */
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);

/**
 * The ticket, if one of `secrets` sealed it and it is well formed; otherwise null. Returns the
 * secret that sealed it too, since E is derived from that one.
 */
export async function openTicket(secrets: readonly Uint8Array[], token: string): Promise<{ ticket: Ticket; secret: Uint8Array } | null> {
  if (typeof token !== 'string' || token.length > 2_000) return null;
  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  let t: Ticket;
  try {
    t = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Ticket;
  } catch {
    return null;
  }
  if (t?.v !== 1 || typeof t.kid !== 'string') return null;
  for (const secret of secrets) {
    if ((await kidOf(secret)) !== t.kid) continue;
    const expected = await hmac(secret, `bound/agent/ticket/${payload}`);
    if (!sameBytes(expected, Buffer.from(mac, 'base64url'))) return null;
    const fields = [t.nonce, t.key, t.owner, t.msg, t.lvbh];
    if (fields.some(f => typeof f !== 'string') || !/^[0-9a-f]{64}$/.test(t.msg) || !/^\d{1,20}$/.test(t.lvbh)) return null;
    if ((t.wOut === undefined) !== (t.b0 === undefined)) return null;
    if (t.wOut !== undefined && (typeof t.wOut !== 'string' || typeof t.b0 !== 'string' || !/^\d{1,20}$/.test(t.b0))) return null;
    return { ticket: t, secret };
  }
  return null;
}
