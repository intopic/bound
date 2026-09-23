import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  fetchAddressesForLookupTables,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from '@solana/kit';
import type { Address, KeyPairSigner, Rpc, SolanaRpcApi, Transaction } from '@solana/kit';
import type { AccountState, ChainSnapshot } from '@bound/core';

export type SolanaRpc = Rpc<SolanaRpcApi>;

/**
 * The HTTP status of a failed RPC call. Read from the error's context, never its text: a
 * production build of kit replaces every message with "Solana error #<code>", so a test on the
 * words "429" or "Too Many Requests" never matches in the page users actually load.
 */
export function httpStatusOf(e: unknown): number | null {
  if (!isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return null;
  return (e.context as { statusCode?: number }).statusCode ?? null;
}

type Transport = ReturnType<typeof createDefaultRpcTransport>;

/**
 * Retries rate-limited requests (HTTP 429) with exponential backoff. The wait is jittered, so the
 * pages that were refused together do not all come back at the same moment and be refused again.
 */
export function retryingTransport(transport: Transport, maxRetries = 5, baseMs = 500): Transport {
  return (async (config: Parameters<Transport>[0]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await transport(config);
      } catch (e) {
        if (attempt >= maxRetries || httpStatusOf(e) !== 429) throw e;
        await new Promise(r => setTimeout(r, baseMs * 2 ** attempt * (0.5 + Math.random())));
      }
    }
  }) as Transport;
}

/**
 * An RPC client that retries rate-limited requests. Every method the pipeline uses is safe to
 * repeat: reads, simulations, and re-sends of an already signed transaction (the same signature
 * can only land once).
 */
export function createRetryingRpc(url: string, maxRetries = 5): SolanaRpc {
  const transport = createDefaultRpcTransport({ url: url as `https://${string}` });
  return createSolanaRpcFromTransport(retryingTransport(transport, maxRetries)) as unknown as SolanaRpc;
}

const MAX_ACCOUNTS_PER_CALL = 100;

const decodeBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** Reads accounts in batches; a missing account maps to null. */
export async function fetchAccounts(rpc: SolanaRpc, addresses: readonly Address[]): Promise<Map<string, AccountState | null>> {
  return (await readAccounts(rpc, addresses)).accounts;
}

/** The same read, keeping the slot the chain answered at. */
export async function readAccounts(
  rpc: SolanaRpc,
  addresses: readonly Address[],
): Promise<{ accounts: Map<string, AccountState | null>; slot: bigint }> {
  const unique = [...new Set(addresses)];
  const out = new Map<string, AccountState | null>();
  let slot = 0n;
  for (let i = 0; i < unique.length; i += MAX_ACCOUNTS_PER_CALL) {
    const batch = unique.slice(i, i + MAX_ACCOUNTS_PER_CALL);
    const { context, value } = await rpc.getMultipleAccounts(batch, { encoding: 'base64', commitment: 'confirmed' }).send();
    // The oldest slot of the batches: the state is at least that recent. An RPC that omits the
    // context leaves the slot at zero, and a certificate then simply names no slot.
    const at = BigInt(context?.slot ?? 0);
    slot = slot === 0n || (at !== 0n && at < slot) ? at : slot;
    value.forEach((acc, j) => {
      out.set(batch[j], acc ? { owner: acc.owner, lamports: acc.lamports, data: decodeBase64(acc.data[0]) } : null);
    });
  }
  return { accounts: out, slot };
}

/**
 * Everything the verifier needs, read from the chain. Lookup tables come from the RPC, never from
 * Jupiter.
 */
export async function fetchSnapshot(args: {
  rpc: SolanaRpc;
  addresses: readonly Address[];
  lookupTableAddresses: readonly Address[];
}): Promise<ChainSnapshot> {
  const { accounts, slot } = await readAccounts(args.rpc, args.addresses);
  const lookupTables: Record<string, readonly Address[]> = args.lookupTableAddresses.length
    ? await fetchAddressesForLookupTables([...args.lookupTableAddresses], args.rpc)
    : {};
  return { accounts, lookupTables, slot };
}

export type MintInfo = { exists: boolean; program: Address | null; decimals: number; freezeAuthority: boolean; mintAuthority: boolean };

/** What a mint account says; `exists: false` for a missing account or one too short to be a mint. */
export function mintInfoOf(s: AccountState | null | undefined): MintInfo {
  if (!s || s.data.length < 82) return { exists: false, program: null, decimals: 0, freezeAuthority: false, mintAuthority: false };
  const view = new DataView(s.data.buffer, s.data.byteOffset, s.data.byteLength);
  return {
    exists: true,
    program: s.owner,
    decimals: s.data[44],
    mintAuthority: view.getUint32(0, true) === 1,
    freezeAuthority: view.getUint32(46, true) === 1,
  };
}

export async function fetchMints(rpc: SolanaRpc, mints: readonly Address[]): Promise<Map<string, MintInfo>> {
  const states = await fetchAccounts(rpc, mints);
  return new Map(mints.map(m => [m, mintInfoOf(states.get(m))]));
}

const INFRA = new Set([
  '11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'ComputeBudget111111111111111111111111111111',
]);

/**
 * The innermost non-infrastructure program on the call stack when a simulation failed: the DEX to
 * blame. Returns the failing infrastructure program when none (one of our own instructions failed).
 */
export function blameProgram(logs: readonly string[]): string | null {
  const stack: string[] = [];
  for (const line of logs) {
    let m = line.match(/^Program (\w+) invoke \[(\d+)\]/);
    if (m) { stack.length = Number(m[2]) - 1; stack.push(m[1]); continue; }
    m = line.match(/^Program (\w+) failed/);
    if (m) return [...stack].reverse().find(p => !INFRA.has(p)) ?? m[1];
    if (/^Program \w+ success/.test(line)) stack.pop();
  }
  return null;
}

export const isInfrastructureProgram = (programId: string) => INFRA.has(programId);

function failedInstructionOf(err: unknown): number | null {
  const ie = (err as { InstructionError?: [number | bigint, unknown] } | null)?.InstructionError;
  return ie ? Number(ie[0]) : null;
}

export type Simulation = {
  ok: boolean;
  error: string | null;
  units: number;
  logs: string[];
  blame: string | null;
  /** Index of the instruction that failed, when the error names one. */
  failedInstruction: number | null;
  /** Lamports each requested account holds after the transaction (0 when it no longer exists). */
  lamportsAfter: bigint[];
};

/** Simulation answers "will it execute?" — never "is it safe?" (plan, section 15). */
export async function simulate(rpc: SolanaRpc, transaction: Transaction, watch: readonly Address[] = []): Promise<Simulation> {
  const { value } = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(transaction), {
      encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
      ...(watch.length ? { accounts: { addresses: [...watch], encoding: 'base64' as const } } : {}),
    })
    .send();
  const logs = [...(value.logs ?? [])];
  return {
    ok: value.err === null,
    error: value.err === null ? null : JSON.stringify(value.err, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    units: Number(value.unitsConsumed ?? 0n),
    logs,
    blame: value.err === null ? null : blameProgram(logs),
    failedInstruction: failedInstructionOf(value.err),
    lamportsAfter: watch.map((_, i) => BigInt(
      (value as { accounts?: readonly ({ lamports: bigint | number } | null)[] | null }).accounts?.[i]?.lamports ?? 0,
    )),
  };
}

/**
 * What happened to a sent transaction (audit C-03). Only three outcomes allow saying that no funds
 * moved: `rejected` (refused before it was broadcast), `expired` (its blockhash expired and the
 * cluster has no record of it, so it can never execute) and `failed` (it executed and reverted;
 * only the network fee was paid). `unknown` means exactly that: look it up before trying again.
 */
export type SendOutcome = 'confirmed' | 'failed' | 'expired' | 'rejected' | 'unknown';
export type SendStatus = 'sending' | 'sent' | SendOutcome;
/**
 * `refusal`, for `rejected` only: who refused. `paused` and `busy` are Bound's own relay (the kill
 * switch, the send limit); `network` is the RPC's preflight, which usually means the price moved.
 */
export type SendRefusal = 'paused' | 'busy' | 'network';
export type SendResult = { signature: string; status: SendOutcome; error: string | null; refusal?: SendRefusal };

export type SendTiming = { pollMs: number; rebroadcastMs: number; giveUpMs: number; settleTries: number; settleMs: number };
const TIMING: SendTiming = { pollMs: 1_000, rebroadcastMs: 3_000, giveUpMs: 150_000, settleTries: 5, settleMs: 2_000 };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const stringify = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

/**
 * Only two responses prove that the first send never left a node: Solana's structured preflight
 * failure, and a 4xx that Bound's proxy explicitly marks as rejected before forwarding. Every
 * upstream HTTP/JSON-RPC error is ambiguous, because a node may have accepted the transaction
 * before its response failed.
 */
export function refusedBeforeBroadcast(e: unknown): boolean {
  if (isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) return true;
  if (isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    const status = (e.context as { statusCode?: number }).statusCode ?? 0;
    const headers = (e.context as { headers?: Headers }).headers;
    return status >= 400 && status < 500 && headers?.get('x-bound-not-forwarded') === '1';
  }
  return false;
}

/**
 * Sends, re-broadcasts every few seconds, and settles the outcome. The signature is reported
 * before the first request, so a caller never loses track of a transaction that may have landed.
 */
export async function sendAndConfirm(args: {
  rpc: SolanaRpc;
  transaction: Transaction;
  lastValidBlockHeight: bigint;
  onStatus?: (status: SendStatus, signature: string) => void;
  timing?: Partial<SendTiming>;
}): Promise<SendResult> {
  const { rpc, transaction, lastValidBlockHeight } = args;
  const t = { ...TIMING, ...args.timing };
  const signature = getSignatureFromTransaction(transaction);
  const wire = getBase64EncodedWireTransaction(transaction);
  const done = (status: SendOutcome, error: string | null = null, refusal?: SendRefusal): SendResult => {
    args.onStatus?.(status, signature);
    return { signature, status, error, ...(refusal ? { refusal } : {}) };
  };
  const rebroadcast = () =>
    void rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send().catch(() => undefined);
  const lookup = async (searchTransactionHistory: boolean) =>
    (await rpc.getSignatureStatuses([signature as never], { searchTransactionHistory }).send()).value[0];

  args.onStatus?.('sending', signature);
  try {
    await rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0n }).send();
    args.onStatus?.('sent', signature);
  } catch (e) {
    if (refusedBeforeBroadcast(e)) {
      const http = httpStatusOf(e);
      return done('rejected', String((e as Error)?.message ?? e), http === 403 ? 'paused' : http === 429 ? 'busy' : 'network');
    }
    // It may have been forwarded before the connection failed: keep watching. The re-broadcasts
    // send the same bytes, which can land at most once.
  }

  const started = Date.now();
  let lastBroadcast = Date.now();
  while (Date.now() - started < t.giveUpMs) {
    await sleep(t.pollMs);
    try {
      const s = await lookup(false);
      if (s?.err) return done('failed', stringify(s.err));
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return done('confirmed');
      const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
      if (height > lastValidBlockHeight) return settleAfterExpiry();
    } catch {
      // A failed read says nothing about the transaction; keep trying until giving up.
    }
    if (Date.now() - lastBroadcast >= t.rebroadcastMs) {
      rebroadcast();
      lastBroadcast = Date.now();
    }
  }
  return done('unknown', 'the outcome could not be read from the network');

  // The blockhash has expired, so the transaction can no longer be included. Stop re-broadcasting
  // and read the full status history: seen but only `processed` is not an outcome yet.
  async function settleAfterExpiry(): Promise<SendResult> {
    let notFound = 0;
    for (let i = 0; i < t.settleTries; i++) {
      try {
        const s = await lookup(true);
        if (s?.err) return done('failed', stringify(s.err));
        if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return done('confirmed');
        if (!s && ++notFound >= 2) return done('expired');
      } catch {
        // keep settling
      }
      await sleep(t.settleMs);
    }
    return done('unknown', 'seen by the network but not confirmed');
  }
}

/**
 * The temporary authority E: an Ed25519 key generated with WebCrypto as non-extractable, so not
 * even a bug can export it (D7). One per transaction; the caller drops it after signing.
 */
export async function createEphemeral(): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  if (signer.keyPair.privateKey.extractable) throw new Error('The temporary key must be non-extractable');
  return signer;
}
