import { getBase64EncodedWireTransaction, getTransactionDecoder, isAddress } from '@solana/kit';
import type { Address, Transaction } from '@solana/kit';
import { JUPITER_PROGRAM } from '@bound/core';
import type { TxVersion } from '@bound/core';
import { BoundError, countersignProtectedSwap, DEFAULT_SETTINGS, prepareProtectedSwap } from '@bound/jupiter';
import type { JupiterClient } from '@bound/jupiter';
import { fetchMints, httpStatusOf, sendOnce } from '@bound/solana';
import type { SolanaRpc } from '@bound/solana';
import { readBodyLimited } from '../body';
import { rateLimited } from '../rateLimit';
import { ephemeralFor, kidOf, newNonce, openTicket, sealTicket } from './ticket';

/**
 * The agent API (API-AGJENTET.md): the same protected swap the page builds, with E held by the
 * server instead of the browser. Bound signs as E last, and only the exact message it built and
 * verified, which is what makes the fee hold for bots and agents without a program on chain.
 *
 *   POST /api/v1/prepare   build and verify → the unsigned transaction and a ticket
 *   POST /api/v1/finalize  the ticket and the transaction W signed → E signs, one send
 */
export type AgentDeps = {
  rpc: SolanaRpc;
  jupiter: JupiterClient;
  /** Server secrets, the current one first; older ones still open their tickets while they rotate out. */
  secrets: readonly Uint8Array[];
  /** SHA-256 of each API key (hex) → the key's id. The keys themselves are never stored. */
  keys: ReadonlyMap<string, string>;
  feeBps: bigint;
  treasury: Address | null;
  excludeDexes: readonly string[];
  maxNetworkFeeLamports: bigint;
  /** The kill switch, read on every request. */
  disabled: boolean;
  /** v1 transactions, only when the deployment enables them (review BR-12). */
  v1: boolean;
  /** Requests per minute per API key, for each endpoint. */
  perMinute: number;
};

const MAX_U64 = 2n ** 64n - 1n;
const MAX_BODY_BYTES = 16 * 1024;
const UINT = /^\d{1,20}$/;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json(status, { error: { code, message, ...extra } }, headers);

const sha256Hex = async (bytes: ArrayLike<number>) =>
  Buffer.from(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes))).toString('hex');

/** The key's id, or the response that refuses the request. */
async function authenticate(req: Request, deps: AgentDeps): Promise<string | Response> {
  const header = req.headers.get('authorization') ?? '';
  const key = /^Bearer\s+(\S{16,200})$/i.exec(header)?.[1];
  const id = key ? deps.keys.get(await sha256Hex(new TextEncoder().encode(key))) : undefined;
  if (!id) return fail(401, 'unauthorized', 'A valid API key is required: Authorization: Bearer <key>.');
  if (rateLimited(`agent:${new URL(req.url).pathname}:${id}`, deps.perMinute)) {
    return fail(429, 'rate-limited', 'Too many requests for this API key. Wait a few seconds and try again.', {}, { 'retry-after': '10' });
  }
  return id;
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const text = await readBodyLimited(req, MAX_BODY_BYTES);
  if (text === null) return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** An amount in base units, as a decimal string: the only form that survives JSON exactly. */
function amount(v: unknown): bigint | null {
  if (typeof v !== 'string' || !UINT.test(v)) return null;
  const n = BigInt(v);
  return n > 0n && n <= MAX_U64 ? n : null;
}

/** Every refusal in the words the page uses, with what an agent needs to act on it. */
function explain(e: unknown): Response {
  if (e instanceof BoundError) {
    const violations = e.violations.length ? { violations: e.violations } : {};
    switch (e.code) {
      case 'price-moved':
        return fail(409, e.code, e.message, {
          newMinOut: e.priceMoved?.newMinOut, newOutAmount: e.priceMoved?.newOutAmount,
          retry: 'Send prepare again with minOut set to newMinOut to accept it.',
        });
      case 'costs-more':
        return fail(409, e.code, e.message, {
          gapBps: e.costsMore?.gapBps, outAmount: e.costsMore?.outAmount, baselineOut: e.costsMore?.baselineOut,
          retry: 'Send prepare again with acceptCostBps set to gapBps to accept it.',
        });
      case 'busy':
      case 'unavailable':
        return fail(503, e.code, e.message, {}, { 'retry-after': '5' });
      case 'expired':
        return fail(410, e.code, e.message);
      case 'wallet-changed-transaction':
        return fail(400, e.code, e.message, violations);
      default:
        return fail(422, e.code, e.message, violations);
    }
  }
  const http = httpStatusOf(e);
  if (http === 429) return fail(503, 'busy', 'The network is busy. Wait a few seconds and try again. Nothing was sent.', {}, { 'retry-after': '5' });
  if (http !== null && http >= 500) return fail(503, 'unavailable', "The network didn't answer. Nothing was sent; try again in a moment.");
  console.error(e);
  return fail(500, 'internal', 'Something went wrong. Nothing was signed by Bound or sent.');
}

export async function agentPrepare(req: Request, deps: AgentDeps): Promise<Response> {
  if (deps.disabled) return fail(503, 'paused', 'Protected swaps are paused. Nothing was built.');
  const key = await authenticate(req, deps);
  if (key instanceof Response) return key;
  const body = await readJson(req);
  if (!body) return fail(400, 'bad-request', 'Send a JSON object of at most 16 KiB.');

  const { owner, inputMint, outputMint } = body;
  for (const [name, v] of [['owner', owner], ['inputMint', inputMint], ['outputMint', outputMint]] as const) {
    if (typeof v !== 'string' || !isAddress(v)) return fail(400, 'bad-request', `${name} must be a Solana address.`);
  }
  if (inputMint === outputMint) return fail(400, 'bad-request', 'inputMint and outputMint must differ.');
  const amountIn = amount(body.amountIn);
  if (amountIn === null) return fail(400, 'bad-request', 'amountIn must be a positive integer in base units, as a string.');
  const minOut = body.minOut === undefined ? undefined : amount(body.minOut);
  if (minOut === null) return fail(400, 'bad-request', 'minOut, when given, must be a positive integer in base units, as a string.');
  const acceptCostBps = body.acceptCostBps === undefined ? undefined
    : typeof body.acceptCostBps === 'string' && /^\d{1,5}$/.test(body.acceptCostBps) ? BigInt(body.acceptCostBps) : null;
  if (acceptCostBps === null) return fail(400, 'bad-request', 'acceptCostBps, when given, must be an integer string.');
  const version: TxVersion = body.version === 1 ? 1 : 0;
  if (body.version !== undefined && body.version !== 0 && body.version !== 1) return fail(400, 'bad-request', 'version must be 0 or 1.');
  if (version === 1 && !deps.v1) return fail(400, 'bad-request', 'v1 transactions are not enabled on this deployment; use version 0.');

  try {
    const [inMint, outMint] = [inputMint as Address, outputMint as Address];
    const mints = await fetchMints(deps.rpc, [inMint, outMint]);
    for (const m of [inMint, outMint]) {
      if (!mints.get(m)?.exists) return fail(422, 'unsupported-token', `${m} is not a token Bound can swap.`);
    }
    const nonce = newNonce();
    const [secret] = deps.secrets;
    const E = await ephemeralFor(secret, nonce);
    const prepared = await prepareProtectedSwap(
      {
        rpc: deps.rpc,
        jupiter: deps.jupiter,
        settings: {
          ...DEFAULT_SETTINGS,
          feeBps: deps.feeBps,
          treasury: deps.treasury,
          excludeDexes: deps.excludeDexes,
          maxNetworkFeeLamports: deps.maxNetworkFeeLamports,
          jupiterProgram: JUPITER_PROGRAM,
        },
      },
      {
        owner: owner as Address, ephemeral: E, inputMint: inMint, outputMint: outMint, amountIn,
        inputDecimals: mints.get(inMint)!.decimals, outputDecimals: mints.get(outMint)!.decimals,
        acceptedMinOut: minOut, acceptedCostBps: acceptCostBps, version,
      },
    );
    // The hash finalize will hold the agent to, computed here from the bytes rather than taken from
    // the certificate: it is the one value the fee depends on.
    const messageSha256 = await sha256Hex(prepared.transaction.messageBytes);
    const ticket = await sealTicket(secret, {
      v: 1, kid: await kidOf(secret), nonce, key, owner: owner as string, msg: messageSha256,
      lvbh: prepared.lifetime.lastValidBlockHeight.toString(),
    });
    const p = prepared.policy;
    return json(200, {
      ticket,
      transaction: getBase64EncodedWireTransaction(prepared.transaction),
      messageSha256,
      wallet: owner,
      temporaryAuthority: E.address,
      version,
      lastValidBlockHeight: prepared.lifetime.lastValidBlockHeight,
      amounts: {
        amountIn: p.amountIn, fee: p.fee, feeBps: p.feeBps, swapAmount: p.swapAmount,
        quotedOut: prepared.quote.outAmount, minOut: p.minOut, priceImpactPct: prepared.quote.priceImpactPct,
      },
      costs: {
        networkFeeLamports: prepared.networkFeeLamports,
        outputAccountRentLamports: prepared.oneTimeCosts.outputAccountRent,
        routeRentLamports: prepared.oneTimeCosts.routeRent,
        tokenTax: prepared.tokenTax,
      },
      notices: prepared.notices,
      route: prepared.quote.route,
      certificate: prepared.certificate,
      policy: p,
    });
  } catch (e) {
    return explain(e);
  }
}

export async function agentFinalize(req: Request, deps: AgentDeps): Promise<Response> {
  if (deps.disabled) return fail(503, 'paused', 'Protected swaps are paused. Nothing was signed by Bound or sent.');
  const key = await authenticate(req, deps);
  if (key instanceof Response) return key;
  const body = await readJson(req);
  if (!body || typeof body.ticket !== 'string' || typeof body.signedTransaction !== 'string') {
    return fail(400, 'bad-request', 'Send { "ticket": "...", "signedTransaction": "<base64>" }.');
  }
  const opened = await openTicket(deps.secrets, body.ticket);
  // A ticket issued to another key is refused in the same words as a forged one.
  if (!opened || opened.ticket.key !== key) return fail(400, 'invalid-ticket', 'This ticket was not issued by Bound to this API key. Nothing was signed or sent.');
  const { ticket, secret } = opened;

  let returned: Transaction;
  const bytes = Buffer.from(body.signedTransaction, 'base64');
  try {
    if (bytes.length === 0 || bytes.length > 4_096) throw new Error('size');
    returned = getTransactionDecoder().decode(bytes);
  } catch {
    return fail(400, 'bad-request', 'signedTransaction must be a base64 Solana transaction.');
  }
  // The fee holds here: Bound signs as E only the message whose hash it sealed into the ticket after
  // building and verifying it. A message with the fee removed, or any byte changed, is another hash.
  if ((await sha256Hex(returned.messageBytes)) !== ticket.msg) {
    return fail(400, 'transaction-changed', 'This is not the transaction Bound built. Bound signs only the exact message it built and verified; nothing was signed or sent.');
  }

  try {
    const E = await ephemeralFor(secret, ticket.nonce);
    const original: Transaction = { messageBytes: returned.messageBytes, signatures: {} } as Transaction;
    const signed = await countersignProtectedSwap({
      rpc: deps.rpc,
      prepared: { transaction: original, lifetime: { lastValidBlockHeight: BigInt(ticket.lvbh) }, policy: { owner: ticket.owner as Address } },
      walletSignedBytes: new Uint8Array(bytes),
      ephemeral: E,
    });
    const sent = await sendOnce(deps.rpc, signed);
    return json(200, {
      signature: sent.signature,
      status: sent.status,
      ...(sent.refusal ? { refusal: sent.refusal } : {}),
      // Fully signed: the agent can re-broadcast it and confirm it with its own RPC until it expires.
      signedTransaction: getBase64EncodedWireTransaction(signed),
      lastValidBlockHeight: ticket.lvbh,
    });
  } catch (e) {
    return explain(e);
  }
}
