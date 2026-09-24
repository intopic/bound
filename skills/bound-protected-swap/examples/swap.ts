/**
 * A protected swap through the Bound agent API, end to end: prepare → verify → sign as the wallet →
 * finalize → confirm, with every chain read on your own RPC. Needs @solana/kit 8 and nothing else:
 * the verifier ships with the skill (../lib/bound-verify.mjs).
 *
 * The check before signing is the point. Bound's server builds the transaction, so the agent runs
 * Bound's full verifier on the exact bytes, against chain state from its own RPC, with the policy
 * held to its own intent and limits. A compromised server, relay or impostor URL can then refuse or
 * delay a swap, never make the wallet sign one that moves more than the approved amount. The price
 * is held to a floor of the agent's own: `--min-out`, or one this script asks Jupiter for itself.
 *
 * After signing, the chain is the only witness. The transaction's id is the wallet's own signature,
 * known before finalize; the outcome is read for that id on your RPC, whatever finalize answers or
 * fails to answer, so a lost answer or a lying server can neither fake a success nor start a second
 * swap while the first one could still land (engineering review H-01, H-02).
 *
 *   BOUND_API_URL=https://<bound host>  BOUND_API_KEY=bnd_...  SOLANA_RPC_URL=https://<your rpc>
 *   BOUND_WALLET_KEYPAIR=/path/to/keypair.json   (a solana-keygen file; never paste a key in a prompt)
 *   BOUND_TREASURY=<address>                     (optional: the fee may go only there)
 *   JUPITER_API_KEY=...                          (optional: for your own price; keyless allows one call every 2 s)
 *
 *   node swap.ts --in <mint> --out <mint> --amount <base units> [--min-out <base units>] [--max-below-bps N] [--max-fee-bps 20]
 *                [--accept-cost-bps N] [--v1]
 *   node swap.ts ... --owner <address> --dry-run      prepare and verify only: nothing is signed
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKeyPairSignerFromBytes, createSolanaRpc, getCompiledTransactionMessageDecoder, getPublicKeyFromAddress,
  getSignatureFromTransaction, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction, verifySignature,
} from '@solana/kit';
import type { Address, KeyPairSigner, Rpc, SolanaRpcApi, Transaction } from '@solana/kit';
import { ownMinimum, verifyPrepared } from '../lib/bound-verify.mjs';

export type Intent = {
  owner: string;
  inputMint: string;
  outputMint: string;
  /** Base units, as a string. */
  amountIn: string;
  /**
   * Your own floor for the output, base units; Bound never enforces less. Required by the check;
   * `protectedSwap` asks Jupiter for one when it is missing (see `ownMinimum`).
   */
  minOut?: string;
  /** For the floor asked of Jupiter: how far below its price, in bps (default 2%, 5% on a Pump.fun curve). */
  maxBelowBps?: number;
  /** The highest Bound fee you accept, in bps (Bound's is 20). */
  maxFeeBps?: number;
  /** The highest network fee you accept, in lamports. */
  maxNetworkFeeLamports?: number;
  /** When set, the fee may go only to this treasury wallet (or nowhere). */
  treasury?: string;
  /** A gap to the open market the user already accepted, from a `costs-more` answer (bps, as a string). */
  acceptCostBps?: string;
  /** 1 for a v1 transaction, where the deployment offers it; 0 (the default) otherwise. */
  version?: 0 | 1;
};

export type Prepared = {
  ticket: string;
  transaction: string;
  messageSha256: string;
  wallet: string;
  temporaryAuthority: string;
  lastValidBlockHeight: string;
  /** Blocks left in the transaction's life when prepare answered (150 at most, about 40 s). */
  blocksLeft?: string;
  /**
   * `fee` is in `feeMint`: SOL first, then USDC or USDT, on whichever side; otherwise the input token.
   * `minOut` is what the wallet keeps at least, after a fee taken from the output.
   */
  amounts: { amountIn: string; fee: string; feeMint?: string; feeBps: string; swapAmount: string; quotedOut: string; minOut: string };
  costs: { networkFeeLamports: string; outputAccountRentLamports: string; routeRentLamports: string; routeRefundLamports: string };
  certificate: {
    messageSha256: string; wallet: string; temporaryAuthority: string;
    input: { mint: string; totalDebit: string; boundFee: string };
    output: { mint: string; minimumOutput: string; boundFee?: string };
  };
  /** What the transaction was built against; held to your intent by the check, never trusted. */
  policy: Record<string, unknown>;
};

/** What finalize answers. Its word is not evidence: the example reads the outcome from the chain. */
export type Finalized = {
  signature: string;
  status: 'sent' | 'unknown' | 'rejected';
  refusal?: string;
  signedTransaction?: string;
  lastValidBlockHeight: string;
};

export type ApiError = { status: number; code: string; message: string; body: Record<string, unknown>; retryAfter?: number | null };

export class BoundApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;
  /** Seconds to wait before asking again, from the answer's Retry-After header; null without one. */
  readonly retryAfter: number | null;
  constructor(e: ApiError) {
    super(`${e.status} ${e.code}: ${e.message}`);
    this.status = e.status;
    this.code = e.code;
    this.body = e.body;
    this.retryAfter = e.retryAfter ?? null;
  }
}

type Fetch = typeof fetch;

async function call<T>(fetchImpl: Fetch, url: string, key: string, body: unknown): Promise<T> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { error?: { code: string; message: string } } & T;
  if (!res.ok) {
    const after = Number(res.headers.get('retry-after'));
    throw new BoundApiError({
      status: res.status, code: json.error?.code ?? 'http', message: json.error?.message ?? res.statusText, body: json.error ?? {},
      retryAfter: Number.isFinite(after) && after > 0 ? after : null,
    });
  }
  return json;
}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * What to check before signing. First that Bound's answer agrees with itself and with what you
 * asked for; then the full verifier on the exact bytes, with chain state from `rpc`, which must be
 * your own RPC (review FA-01). Returns the problems found; sign only when there are none.
 */
export async function checkPrepared(p: Prepared, intent: Intent, rpc: Rpc<SolanaRpcApi>): Promise<string[]> {
  const problems: string[] = [];
  const tx = getTransactionDecoder().decode(Buffer.from(p.transaction, 'base64'));
  const digest = hex(await crypto.subtle.digest('SHA-256', new Uint8Array(tx.messageBytes)));
  if (digest !== p.messageSha256 || p.certificate.messageSha256 !== digest) problems.push('the message does not hash to messageSha256');
  const signers = Object.keys(tx.signatures).sort();
  if (signers.join() !== [intent.owner, p.temporaryAuthority].sort().join()) problems.push(`unexpected signers: ${signers.join(', ')}`);
  const feePayer = getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts[0];
  if (feePayer !== intent.owner) problems.push(`the fee payer is ${feePayer}, not your wallet`);
  if (p.wallet !== intent.owner || p.certificate.wallet !== intent.owner) problems.push('the transaction is for another wallet');
  if (p.certificate.input.mint !== intent.inputMint || p.certificate.output.mint !== intent.outputMint) problems.push('the tokens differ from the ones asked for');
  if (p.amounts.amountIn !== intent.amountIn || p.certificate.input.totalDebit !== intent.amountIn) {
    problems.push(`the wallet would pay ${p.certificate.input.totalDebit}, not ${intent.amountIn}`);
  }
  // The fee is in the input token, or taken from the output (SOL, USDC or USDT): a share of what is
  // paid in, or of the minimum that comes out, never more than your limit of either.
  const onOutput = p.amounts.feeMint !== undefined && p.amounts.feeMint === intent.outputMint && p.amounts.feeMint !== intent.inputMint;
  const base = onOutput ? BigInt(p.amounts.minOut) + BigInt(p.amounts.fee) : BigInt(intent.amountIn);
  const maxFee = (base * BigInt(intent.maxFeeBps ?? 20)) / 10_000n;
  const stated = BigInt(p.certificate.input.boundFee) + BigInt(p.certificate.output.boundFee ?? '0');
  if (BigInt(p.amounts.fee) > maxFee) problems.push(`the Bound fee ${p.amounts.fee} is above ${maxFee}`);
  if (stated !== BigInt(p.amounts.fee)) problems.push('the fee the certificate states differs from the one in amounts');
  if (p.certificate.output.minimumOutput !== p.amounts.minOut) problems.push('the enforced minimum differs from the one stated');
  // The amounts shown are the policy's own, the one the verifier holds the bytes to: the fee, what
  // is routed, and the minimum the wallet keeps (engineering review, section 5).
  const policy = p.policy as Record<string, unknown>;
  const whole = (v: unknown) => (typeof v === 'string' && /^\d{1,20}$/.test(v) ? BigInt(v) : null);
  const [enforced, policyFee, routed] = [whole(policy.minOut), whole(policy.fee), whole(policy.swapAmount)];
  if (enforced === null || policyFee === null || routed === null) problems.push('the policy is malformed');
  else if (
    BigInt(p.amounts.minOut) !== (policy.feeSide === 'output' ? enforced - policyFee : enforced)
    || BigInt(p.amounts.fee) !== policyFee || BigInt(p.amounts.swapAmount) !== routed
  ) {
    problems.push('the amounts stated differ from the policy the transaction is checked against');
  }
  if (intent.minOut && /^\d{1,20}$/.test(intent.minOut) && BigInt(p.amounts.minOut) < BigInt(intent.minOut)) {
    problems.push(`the minimum ${p.amounts.minOut} is below yours, ${intent.minOut}`);
  }
  if (BigInt(p.costs.networkFeeLamports) > BigInt(intent.maxNetworkFeeLamports ?? 1_000_000)) problems.push(`the network fee ${p.costs.networkFeeLamports} is above your limit`);
  // The answer's own claims are not evidence: what the bytes do is decided by the verifier.
  problems.push(...await verifyPrepared(p, { ...intent, minOut: intent.minOut ?? '' }, rpc));
  return problems;
}

/**
 * The transaction lives 150 blocks, about 40 s (research audit F-05). Finalize only with this many
 * left, so that it can still land; otherwise prepare again.
 */
export const MIN_BLOCKS_TO_FINALIZE = 30n;

/**
 * How far your RPC may trail the one Bound read the blockhash from, in blocks. The last block the
 * transaction can land in is taken on your own clock with this margin, never from the server alone.
 */
export const LAG_BLOCKS = 25n;

export async function signAsWallet(wallet: KeyPairSigner, transaction: string): Promise<string> {
  const tx = getTransactionDecoder().decode(Buffer.from(transaction, 'base64'));
  const signed = await partiallySignTransaction([wallet.keyPair], tx);
  return Buffer.from(getTransactionEncoder().encode(signed)).toString('base64');
}

/**
 * `expired`: it did not land and can no longer land. `unknown`: no outcome could be read in time;
 * it may still be on chain, so check its signature before any new swap.
 */
export type Outcome = 'confirmed' | 'failed' | 'expired' | 'unknown';

/**
 * Settles one transaction on your own RPC, by its signature, until it lands, can no longer land, or
 * `maxWaitMs` passes. With `signedTransaction` (the fully signed bytes, checked to be this very
 * transaction), it re-broadcasts every few seconds: the same bytes land at most once. Only a confirmed
 * status is an outcome, since an error seen at `processed` may be on a fork (FA-07); and `expired`
 * needs the finalized height past the lifetime and no record in the full history, so a lagging node
 * cannot make a landed swap look expired.
 */
export async function confirm(
  rpc: Rpc<SolanaRpcApi>,
  signature: string,
  lastValidBlockHeight: bigint,
  opts: { signedTransaction?: string; pollMs?: number; maxWaitMs?: number } = {},
): Promise<Outcome> {
  const pollMs = opts.pollMs ?? 1_000;
  const deadline = Date.now() + (opts.maxWaitMs ?? 180_000);
  const settled = (s: { confirmationStatus?: string | null } | null | undefined) =>
    !!s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized');
  let pastLifetime = false;
  let empty = 0;
  let lastSend = 0;
  while (Date.now() < deadline) {
    // A failed read says nothing about the transaction: keep reading until the deadline.
    try {
      const [status] = (await rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: pastLifetime }).send()).value;
      if (settled(status)) return status!.err ? 'failed' : 'confirmed';
      if (!pastLifetime) {
        if ((await rpc.getBlockHeight({ commitment: 'confirmed' }).send()) > lastValidBlockHeight) pastLifetime = true;
        else if (opts.signedTransaction && Date.now() - lastSend > 3_000) {
          lastSend = Date.now();
          await rpc.sendTransaction(opts.signedTransaction as never, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send().catch(() => undefined);
        }
      } else if (!status && (await rpc.getBlockHeight({ commitment: 'finalized' }).send()) > lastValidBlockHeight && ++empty >= 2) {
        return 'expired';
      }
    } catch {
      // keep reading
    }
    await wait(pastLifetime ? pollMs * 2 : pollMs);
  }
  return 'unknown';
}

/** Is `wire` the very transaction your wallet signed, now carrying a valid signature from E too? */
async function isThisTransaction(wire: string, mine: Transaction, temporaryAuthority: string): Promise<boolean> {
  try {
    const tx = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
    if (!sameBytes(tx.messageBytes, mine.messageBytes)) return false;
    if (getSignatureFromTransaction(tx) !== getSignatureFromTransaction(mine)) return false;
    const e = tx.signatures[temporaryAuthority as Address];
    return !!e && await verifySignature(await getPublicKeyFromAddress(temporaryAuthority as Address), e, tx.messageBytes);
  } catch {
    return false;
  }
}

/** What to keep before finalize: with it, a process that stops can still find out what happened. */
export type Signed = { signature: string; lastValidBlockHeight: bigint; ticket: string };

/**
 * The whole flow. A price that moved or a costlier route is not accepted silently: it throws.
 *
 * The outcome is read on your RPC for the signature your wallet made, never taken from finalize:
 * `rejected` means Bound refused to send it and the chain shows it can no longer land; `expired`,
 * that it did not land; `unknown`, that no outcome could be read in time. Only after `rejected` or
 * `expired` is a new swap for the same intent safe; after `unknown`, check `signature` first.
 */
export async function protectedSwap(args: {
  apiUrl: string; apiKey: string; rpc: Rpc<SolanaRpcApi>; wallet: KeyPairSigner; intent: Omit<Intent, 'owner'>;
  fetchImpl?: Fetch; pollMs?: number; jupiterApiKey?: string;
  /** Called with the transaction's signature before finalize, to persist: see `Signed`. */
  onSigned?: (signed: Signed) => void | Promise<void>;
  /** How long to wait for an outcome, in ms; `unknown` after that (default 3 minutes). */
  maxWaitMs?: number;
}): Promise<{ signature: string; outcome: Outcome | 'rejected'; prepared: Prepared; refusal?: string }> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const owner = args.wallet.address;
  // A floor of your own, from a price Bound did not give you (research audit F-02).
  const minOut = args.intent.minOut ?? await ownMinimum({
    inputMint: args.intent.inputMint, outputMint: args.intent.outputMint, amountIn: args.intent.amountIn, taker: owner,
    maxFeeBps: args.intent.maxFeeBps, maxBelowBps: args.intent.maxBelowBps, apiKey: args.jupiterApiKey, fetchImpl,
  });
  const intent: Intent = { ...args.intent, owner, minOut };
  const prepared = await call<Prepared>(fetchImpl, `${args.apiUrl}/api/v1/prepare`, args.apiKey, {
    owner: intent.owner, inputMint: intent.inputMint, outputMint: intent.outputMint, amountIn: intent.amountIn,
    ...(intent.minOut ? { minOut: intent.minOut } : {}),
    ...(intent.acceptCostBps ? { acceptCostBps: intent.acceptCostBps } : {}),
    ...(intent.version !== undefined ? { version: intent.version } : {}),
  });
  const problems = await checkPrepared(prepared, intent, args.rpc);
  if (problems.length) throw new Error(`Not signing: ${problems.join('; ')}`);
  const signedTransaction = await signAsWallet(args.wallet, prepared.transaction);
  const mine = getTransactionDecoder().decode(Buffer.from(signedTransaction, 'base64'));
  // The transaction's id is your wallet's signature, known from bytes you signed yourself.
  const signature = getSignatureFromTransaction(mine);
  const height = BigInt(await args.rpc.getBlockHeight({ commitment: 'confirmed' }).send());
  const stated = BigInt(prepared.lastValidBlockHeight);
  if (stated - height < MIN_BLOCKS_TO_FINALIZE) {
    throw new Error(`Not finalizing: only ${stated - height} blocks are left before this swap expires, too few to land. Nothing was sent; prepare it again.`);
  }
  // The last block it can land in, on your own clock: its blockhash is older than this height and
  // lives 150 blocks, so a server that states less cannot end the wait while it could still land.
  const ownLimit = height + 150n + LAG_BLOCKS;
  const lastValid = stated > ownLimit ? stated : ownLimit;
  await args.onSigned?.({ signature, lastValidBlockHeight: lastValid, ticket: prepared.ticket });

  // Asked once more when no answer came back, or none that reads (the same bytes can land only
  // once). A refusal (4xx) is not asked again: it says this request sent nothing, and the chain
  // says the rest.
  let done: Finalized | null = null;
  let refused: BoundApiError | null = null;
  for (let attempt = 0; attempt < 2 && !done && !refused; attempt++) {
    try {
      done = await call<Finalized>(fetchImpl, `${args.apiUrl}/api/v1/finalize`, args.apiKey, { ticket: prepared.ticket, signedTransaction });
    } catch (e) {
      if (e instanceof BoundApiError && e.status < 500) refused = e;
      else if (attempt === 0) await wait(args.pollMs ?? 1_000);
    }
  }
  // Bytes from the server are re-broadcast only when they are this very transaction, signed by E.
  const bytes = done?.signedTransaction && await isThisTransaction(done.signedTransaction, mine, prepared.temporaryAuthority)
    ? done.signedTransaction : undefined;
  const outcome = await confirm(args.rpc, signature, lastValid, { signedTransaction: bytes, pollMs: args.pollMs, maxWaitMs: args.maxWaitMs });
  const refusal = refused ? refused.code : done?.status === 'rejected' ? done.refusal ?? 'network' : undefined;
  // Refused by Bound, and the chain shows it can no longer land: that refusal is what happened.
  if (outcome === 'expired' && refusal) return { signature, outcome: 'rejected', prepared, refusal };
  return { signature, outcome, prepared, ...(refusal ? { refusal } : {}) };
}

// --- command line
const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const need = (name: string) => process.env[name] ?? (console.error(`Set ${name}.`), process.exit(2));
  const [inputMint, outputMint, amountIn] = [flag('in'), flag('out'), flag('amount')];
  if (!inputMint || !outputMint || !amountIn) {
    console.error('usage: node swap.ts --in <mint> --out <mint> --amount <base units> [--min-out N] [--max-below-bps N] [--max-fee-bps N] [--accept-cost-bps N] [--v1] [--owner <address> --dry-run]');
    process.exit(2);
  }
  const apiUrl = need('BOUND_API_URL').replace(/\/+$/, '');
  const apiKey = need('BOUND_API_KEY');
  const intent = {
    inputMint, outputMint, amountIn, minOut: flag('min-out'), treasury: process.env.BOUND_TREASURY || undefined,
    maxFeeBps: flag('max-fee-bps') ? Number(flag('max-fee-bps')) : undefined,
    maxBelowBps: flag('max-below-bps') ? Number(flag('max-below-bps')) : undefined,
    acceptCostBps: flag('accept-cost-bps'),
    version: process.argv.includes('--v1') ? 1 as const : undefined,
  };
  const jupiterApiKey = process.env.JUPITER_API_KEY || undefined;
  // Your own RPC: the verification is worth what the chain state it reads is worth.
  const rpc = createSolanaRpc(need('SOLANA_RPC_URL'));

  if (process.argv.includes('--dry-run')) {
    const owner = flag('owner') ?? (console.error('--dry-run needs --owner <address>.'), process.exit(2));
    const minOut = intent.minOut ?? await ownMinimum({ inputMint, outputMint, amountIn, taker: owner, maxFeeBps: intent.maxFeeBps, maxBelowBps: intent.maxBelowBps, apiKey: jupiterApiKey });
    const prepared = await call<Prepared>(fetch, `${apiUrl}/api/v1/prepare`, apiKey, {
      owner, inputMint, outputMint, amountIn, minOut,
      ...(intent.acceptCostBps ? { acceptCostBps: intent.acceptCostBps } : {}), ...(intent.version ? { version: 1 } : {}),
    });
    const problems = await checkPrepared(prepared, { ...intent, owner, minOut }, rpc);
    console.log(JSON.stringify({ yourFloor: minOut, amounts: prepared.amounts, costs: prepared.costs, blocksLeft: prepared.blocksLeft, problems }, null, 2));
    process.exitCode = problems.length ? 1 : 0;
    return;
  }

  const wallet = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(need('BOUND_WALLET_KEYPAIR'), 'utf8'))));
  const result = await protectedSwap({
    apiUrl, apiKey, rpc, wallet, intent, jupiterApiKey,
    // Written before finalize: if this process stops, this signature is how to find out what happened.
    onSigned: s => console.error(`Signed transaction ${s.signature}; it can land until block ${s.lastValidBlockHeight}. Check it before swapping again if this stops.`),
  });
  console.log(JSON.stringify({ signature: result.signature, outcome: result.outcome, refusal: result.refusal, amounts: result.prepared.amounts }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(e => {
    console.error(e instanceof BoundApiError ? `${e.code}: ${e.message}` : e);
    process.exitCode = 1;
  });
}
