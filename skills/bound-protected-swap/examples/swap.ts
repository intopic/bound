/**
 * A protected swap through the Bound agent API, end to end: prepare → check → sign as the wallet →
 * finalize → confirm on your own RPC. Only @solana/kit is needed.
 *
 *   BOUND_API_URL=https://<bound host>  BOUND_API_KEY=bnd_...  SOLANA_RPC_URL=https://<your rpc>
 *   BOUND_WALLET_KEYPAIR=/path/to/keypair.json   (a solana-keygen file; never paste a key in a prompt)
 *
 *   node swap.ts --in <mint> --out <mint> --amount <base units> [--min-out <base units>] [--max-fee-bps 20]
 *   node swap.ts ... --owner <address> --dry-run      prepare and check only: nothing is signed
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKeyPairSignerFromBytes, createSolanaRpc, getCompiledTransactionMessageDecoder, getTransactionDecoder,
  getTransactionEncoder, partiallySignTransaction,
} from '@solana/kit';
import type { KeyPairSigner, Rpc, SolanaRpcApi } from '@solana/kit';

export type Intent = {
  owner: string;
  inputMint: string;
  outputMint: string;
  /** Base units, as a string. */
  amountIn: string;
  /** Your own floor for the output, base units; Bound never enforces less. */
  minOut?: string;
  /** The highest Bound fee you accept, in bps (Bound's is 20). */
  maxFeeBps?: number;
  /** The highest network fee you accept, in lamports. */
  maxNetworkFeeLamports?: number;
};

export type Prepared = {
  ticket: string;
  transaction: string;
  messageSha256: string;
  wallet: string;
  temporaryAuthority: string;
  lastValidBlockHeight: string;
  amounts: { amountIn: string; fee: string; feeBps: string; swapAmount: string; quotedOut: string; minOut: string };
  costs: { networkFeeLamports: string; outputAccountRentLamports: string; routeRentLamports: string };
  certificate: {
    messageSha256: string; wallet: string; temporaryAuthority: string;
    input: { mint: string; totalDebit: string; boundFee: string };
    output: { mint: string; minimumOutput: string };
  };
};

export type ApiError = { status: number; code: string; message: string; body: Record<string, unknown> };

export class BoundApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;
  constructor(e: ApiError) {
    super(`${e.status} ${e.code}: ${e.message}`);
    this.status = e.status;
    this.code = e.code;
    this.body = e.body;
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
  if (!res.ok) throw new BoundApiError({ status: res.status, code: json.error?.code ?? 'http', message: json.error?.message ?? res.statusText, body: json.error ?? {} });
  return json;
}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');

/**
 * What to check before signing: that the transaction is what you asked for and what Bound says it
 * is. Returns the problems found; sign only when there are none.
 */
export async function checkPrepared(p: Prepared, intent: Intent): Promise<string[]> {
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
  const maxFee = (BigInt(intent.amountIn) * BigInt(intent.maxFeeBps ?? 20)) / 10_000n;
  if (BigInt(p.amounts.fee) > maxFee || BigInt(p.certificate.input.boundFee) > maxFee) problems.push(`the Bound fee ${p.amounts.fee} is above ${maxFee}`);
  if (p.certificate.output.minimumOutput !== p.amounts.minOut) problems.push('the enforced minimum differs from the one stated');
  if (intent.minOut && BigInt(p.amounts.minOut) < BigInt(intent.minOut)) problems.push(`the minimum ${p.amounts.minOut} is below yours, ${intent.minOut}`);
  if (BigInt(p.costs.networkFeeLamports) > BigInt(intent.maxNetworkFeeLamports ?? 1_000_000)) problems.push(`the network fee ${p.costs.networkFeeLamports} is above your limit`);
  return problems;
}

export async function signAsWallet(wallet: KeyPairSigner, transaction: string): Promise<string> {
  const tx = getTransactionDecoder().decode(Buffer.from(transaction, 'base64'));
  const signed = await partiallySignTransaction([wallet.keyPair], tx);
  return Buffer.from(getTransactionEncoder().encode(signed)).toString('base64');
}

/** `unknown`: seen by the network but not confirmed when its lifetime ended; check the signature later. */
export type Outcome = 'confirmed' | 'failed' | 'expired' | 'unknown';

/**
 * Confirms on your own RPC, re-broadcasting every few seconds until the transaction lands or its
 * blockhash expires. The same signed bytes can land only once, so re-broadcasting is safe.
 */
export async function confirm(rpc: Rpc<SolanaRpcApi>, signedTransaction: string, signature: string, lastValidBlockHeight: bigint, pollMs = 1_000): Promise<Outcome> {
  const wire = signedTransaction as Parameters<Rpc<SolanaRpcApi>['sendTransaction']>[0];
  let lastSend = 0;
  for (;;) {
    const [status] = (await rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: false }).send()).value;
    if (status?.err) return 'failed';
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return 'confirmed';
    if ((await rpc.getBlockHeight({ commitment: 'confirmed' }).send()) > lastValidBlockHeight) {
      // It can no longer be included; read the full history a few times before calling it expired.
      let seen = false;
      for (let i = 0; i < 5; i++) {
        const [late] = (await rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: true }).send()).value;
        if (late?.err) return 'failed';
        if (late && (late.confirmationStatus === 'confirmed' || late.confirmationStatus === 'finalized')) return 'confirmed';
        seen ||= !!late;
        await new Promise(r => setTimeout(r, pollMs * 2));
      }
      return seen ? 'unknown' : 'expired';
    }
    if (Date.now() - lastSend > 3_000) {
      lastSend = Date.now();
      await rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send().catch(() => undefined);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

/** The whole flow. A price that moved or a costlier route is not accepted silently: it throws. */
export async function protectedSwap(args: {
  apiUrl: string; apiKey: string; rpc: Rpc<SolanaRpcApi>; wallet: KeyPairSigner; intent: Omit<Intent, 'owner'>;
  fetchImpl?: Fetch; pollMs?: number;
}): Promise<{ signature: string; outcome: Outcome | 'rejected' | 'unknown'; prepared: Prepared }> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const intent: Intent = { ...args.intent, owner: args.wallet.address };
  const prepared = await call<Prepared>(fetchImpl, `${args.apiUrl}/api/v1/prepare`, args.apiKey, {
    owner: intent.owner, inputMint: intent.inputMint, outputMint: intent.outputMint, amountIn: intent.amountIn,
    ...(intent.minOut ? { minOut: intent.minOut } : {}),
  });
  const problems = await checkPrepared(prepared, intent);
  if (problems.length) throw new Error(`Not signing: ${problems.join('; ')}`);
  const signedTransaction = await signAsWallet(args.wallet, prepared.transaction);
  const done = await call<{ signature: string; status: 'sent' | 'unknown' | 'rejected'; signedTransaction: string; lastValidBlockHeight: string }>(
    fetchImpl, `${args.apiUrl}/api/v1/finalize`, args.apiKey, { ticket: prepared.ticket, signedTransaction },
  );
  if (done.status === 'rejected') return { signature: done.signature, outcome: 'rejected', prepared };
  const outcome = await confirm(args.rpc, done.signedTransaction, done.signature, BigInt(done.lastValidBlockHeight), args.pollMs);
  return { signature: done.signature, outcome, prepared };
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
    console.error('usage: node swap.ts --in <mint> --out <mint> --amount <base units> [--min-out N] [--max-fee-bps N] [--owner <address> --dry-run]');
    process.exit(2);
  }
  const apiUrl = need('BOUND_API_URL').replace(/\/+$/, '');
  const apiKey = need('BOUND_API_KEY');
  const intent = { inputMint, outputMint, amountIn, minOut: flag('min-out'), maxFeeBps: flag('max-fee-bps') ? Number(flag('max-fee-bps')) : undefined };

  if (process.argv.includes('--dry-run')) {
    const owner = flag('owner') ?? (console.error('--dry-run needs --owner <address>.'), process.exit(2));
    const prepared = await call<Prepared>(fetch, `${apiUrl}/api/v1/prepare`, apiKey, { owner, inputMint, outputMint, amountIn, ...(intent.minOut ? { minOut: intent.minOut } : {}) });
    const problems = await checkPrepared(prepared, { ...intent, owner });
    console.log(JSON.stringify({ amounts: prepared.amounts, costs: prepared.costs, problems }, null, 2));
    process.exitCode = problems.length ? 1 : 0;
    return;
  }

  const wallet = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(need('BOUND_WALLET_KEYPAIR'), 'utf8'))));
  const result = await protectedSwap({ apiUrl, apiKey, rpc: createSolanaRpc(need('SOLANA_RPC_URL')), wallet, intent });
  console.log(JSON.stringify({ signature: result.signature, outcome: result.outcome, amounts: result.prepared.amounts }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(e => {
    console.error(e instanceof BoundApiError ? `${e.code}: ${e.message}` : e);
    process.exitCode = 1;
  });
}
