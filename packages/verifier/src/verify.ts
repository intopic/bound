import {
  decompileTransactionMessage,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getTransactionMessageComputeUnitLimit,
  getTransactionMessageLoadedAccountsDataSizeLimit,
  getTransactionMessagePriorityFeeLamports,
  getTransactionSize,
  TRANSACTION_CONFIG_COMPUTE_UNIT_LIMIT_BIT_MASK,
  TRANSACTION_CONFIG_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_BIT_MASK,
  TRANSACTION_CONFIG_PRIORITY_FEE_LAMPORTS_BIT_MASK,
} from '@solana/kit';
import type { Address, Transaction } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import {
  ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS, BPS_DENOMINATOR, LAMPORTS_PER_SIGNATURE, LEGACY_SIZE_LIMIT, MAX_COMPUTE_UNITS,
  MAX_FEE_BPS, MAX_INTERMEDIATE_ACCOUNTS, MAX_LOADED_ACCOUNTS_DATA_SIZE, MINT_SIZE, TOKEN_2022_PROGRAM, TOKEN_ACCOUNT_SIZE, TOKEN_PROGRAM, V1_MAX_ACCOUNTS,
  V1_SIZE_LIMIT, WSOL_MINT,
} from '@bound/core/constants';
import type { AccountState, ChainSnapshot, Policy, RuleId, Verdict, Violation } from '@bound/core/types';
import { parseInstruction } from './parse.ts';
import type { Account, Parsed, RawInstruction } from './parse.ts';

// NOTE: this module must not import the compiler or the policy builder (plan, section 10):
// it re-derives every expectation itself so that a compiler bug cannot hide from it. Economic
// limits (fee, F_max) are checked against constants.ts, never only against the policy (audit B-01/B-02).
//
// WHY THE GUARANTEE HOLDS (audit, answer to 9.1): the load-bearing rule is R6, not R1. R6 pins the
// signer set to exactly {W, E}, and R1 keeps W out of the external instruction, so W never signs
// there: every asset whose movement needs W's signature (SPL transfers, SOL, stake, closes,
// authorities) is out of reach even if its account were passed. R1's address filter only has to
// cover what moves WITHOUT W's signature: token accounts with a pre-existing delegate, and W_out,
// which is made safe by a trusted Revoke (B-03). Relaxing R1 or R6 requires re-reading this note.

const ata = async (owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram }))[0];

const addressBytes = (a: Address) => getAddressEncoder().encode(a);

function isTokenAccountOwnedBy(state: AccountState, owner: Address): boolean {
  if (state.owner !== TOKEN_PROGRAM && state.owner !== TOKEN_2022_PROGRAM) return false;
  if (state.data.length < TOKEN_ACCOUNT_SIZE) return false;
  const want = addressBytes(owner);
  for (let i = 0; i < 32; i++) if (state.data[32 + i] !== want[i]) return false;
  return true;
}

const exists = (s: AccountState | null | undefined) => !!s && (s.lamports > 0n || s.data.length > 0);

const u32At = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);
const u64At = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
/** Token balance of a token account in the snapshot; 0 when it does not exist yet. */
const tokenBalance = (s: AccountState | null | undefined) => (s && s.data.length >= 72 ? u64At(s.data, 64) : 0n);
/** COption<close_authority> tag at offset 129 of an SPL token account. */
const hasCloseAuthority = (s: AccountState | null | undefined) =>
  !!s && s.data.length >= TOKEN_ACCOUNT_SIZE && u32At(s.data, 129) === 1;

/**
 * Token-2022 mint extensions a protected swap can live with. Everything else is refused, including
 * any extension this list does not know: an extension changes what a transfer does, and what we
 * have not read, we do not allow.
 *
 * Left out on purpose: transfer fee (an account holding withheld fees cannot be closed, and Bound's
 * extra hop would pay the fee twice), permanent delegate and default-frozen accounts (someone else
 * could move or freeze the temporary account), pausable and non-transferable (a third party can
 * stop the swap), interest-bearing and scaled UI amount (we would show a different number than the
 * wallet), memo-required (every incoming transfer would need one more instruction).
 */
const ALLOWED_MINT_EXTENSIONS = new Set([
  3, // MintCloseAuthority: usable only at zero supply
  4, // ConfidentialTransferMint: ordinary public transfers still work
  14, // TransferHook, but only with no program set - see below
  18, 19, // MetadataPointer, TokenMetadata
  20, 21, 22, 23, // Group and member pointers
]);

const EXTENSION_NAMES: Record<number, string> = {
  1: 'transfer fee', 6: 'accounts frozen by default', 8: 'memo required on transfer',
  9: 'non-transferable', 10: 'interest-bearing', 12: 'permanent delegate', 25: 'scaled UI amount',
  26: 'pausable',
};

/**
 * The first extension that makes a Token-2022 mint unusable for a protected swap, or null. The
 * extension area starts after the account-type byte at offset 165 (a mint is padded to the size of
 * a token account first).
 */
export function unsupportedExtension(data: Uint8Array): string | null {
  if (data.length === MINT_SIZE) return null;
  if (data.length <= TOKEN_ACCOUNT_SIZE || data[TOKEN_ACCOUNT_SIZE] !== 1) return 'malformed extension area';
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nonZero = (from: number, to: number) => data.subarray(from, to).some(b => b !== 0);
  for (let at = TOKEN_ACCOUNT_SIZE + 1; at + 4 <= data.length; ) {
    const type = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    const value = at + 4;
    if (type === 0) break; // Uninitialized: the rest is padding
    if (value + length > data.length) return 'malformed extension';
    // A declared hook with no program set runs no code at all, which is what the largest
    // Token-2022 tokens do; a real program is refused.
    if (type === 14) {
      if (length < 64 || nonZero(value + 32, value + 64)) return 'transfer hook';
    } else if (!ALLOWED_MINT_EXTENSIONS.has(type)) {
      return EXTENSION_NAMES[type] ?? `unknown extension ${type}`;
    }
    at = value + length;
  }
  return null;
}

/**
 * Does this token account require a memo before every incoming transfer (extension 8)? Such an
 * account would make the swap's own transfer fail, so the pipeline refuses it up front rather than
 * letting four route repairs discover it. Account extensions sit after the account-type byte, as
 * on a mint, but with AccountType::Account.
 */
export function memoRequired(data: Uint8Array): boolean {
  if (data.length <= TOKEN_ACCOUNT_SIZE || data[TOKEN_ACCOUNT_SIZE] !== 2) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = TOKEN_ACCOUNT_SIZE + 1; at + 4 <= data.length; ) {
    const type = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    if (type === 0) break;
    if (type === 8) return true;
    at = at + 4 + length;
  }
  return false;
}

const V1_ALLOWED_CONFIG =
  TRANSACTION_CONFIG_PRIORITY_FEE_LAMPORTS_BIT_MASK |
  TRANSACTION_CONFIG_COMPUTE_UNIT_LIMIT_BIT_MASK |
  TRANSACTION_CONFIG_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_BIT_MASK;

type Slot =
  | 'cuLimit' | 'cuPrice' | 'createEIn' | 'createEOut' | 'createWOut' | 'revokeWOut'
  | 'createIntermediate' | 'transferIn' | 'feeTransfer' | 'sync' | 'minOutCheck' | 'closeEIn' | 'closeEOut'
  | 'closeIntermediate';

const BEFORE_SWAP: Slot[] = [
  'createEIn', 'createEOut', 'createWOut', 'revokeWOut', 'createIntermediate', 'transferIn', 'feeTransfer', 'sync',
];
const AFTER_SWAP: Slot[] = ['minOutCheck', 'closeEIn', 'closeEOut', 'closeIntermediate'];

/**
 * The 7 rules of the plan (section 6), checked on the exact bytes the wallet will sign.
 * Pure: every chain fact comes from `snapshot`, fetched beforehand.
 */
export async function verify(transaction: Transaction, policy: Policy, snapshot: ChainSnapshot): Promise<Verdict> {
  const violations: Violation[] = [];
  const fail = (rule: RuleId, detail: string) => void violations.push({ rule, detail });
  const p = policy;
  const W = p.owner;
  const E = p.ephemeral;
  // The variant follows from the mints; the policy's label is checked, never trusted (audit C-05).
  const variant = p.outputMint === WSOL_MINT ? 'A' : p.inputMint === WSOL_MINT ? 'B' : 'C';
  if (p.variant !== variant) fail('R2', `policy variant ${p.variant} does not match the mints (${variant})`);
  const A = variant === 'A';
  const B = variant === 'B';

  // Which token program owns each mint is a fact of the chain, so it is read from the snapshot and
  // the policy is only checked against it. Wrapped SOL is always classic.
  const programOf = (mint: Address): Address | null => {
    const state = snapshot.accounts.get(mint);
    if (!state) return null;
    return state.owner === TOKEN_PROGRAM || state.owner === TOKEN_2022_PROGRAM ? state.owner : null;
  };
  const chainInput = programOf(p.inputMint);
  const chainOutput = programOf(p.outputMint);
  if (chainInput && chainInput !== p.inputTokenProgram) fail('R2', 'the input token program does not match the mint');
  if (chainOutput && chainOutput !== p.outputTokenProgram) fail('R2', 'the output token program does not match the mint');
  const inputProgram = chainInput ?? p.inputTokenProgram;
  const outputProgram = chainOutput ?? p.outputTokenProgram;

  // Re-derive the policy's numbers and accounts instead of trusting them.
  const expectedFee = p.treasury ? (p.amountIn * p.feeBps) / BPS_DENOMINATOR : 0n;
  if (p.fee !== expectedFee || p.swapAmount + p.fee !== p.amountIn || p.swapAmount <= 0n) {
    fail('R2', 'policy amounts are inconsistent');
  }
  if (p.inputMint === p.outputMint) fail('R2', 'input and output token are the same');
  if (p.feeBps < 0n || p.feeBps > MAX_FEE_BPS) fail('R2', `fee of ${p.feeBps} bps is above the maximum of ${MAX_FEE_BPS}`);
  if (p.maxNetworkFeeLamports > ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS) {
    fail('R4', `configured network fee limit ${p.maxNetworkFeeLamports} is above the absolute maximum`);
  }
  if (p.minOut <= 0n) fail('R2', 'the policy has no minimum output');
  // Decimals come from the mints in the snapshot, not from token metadata (audit C-01).
  for (const [mint, decimals, side] of [[p.inputMint, p.inputDecimals, 'input'], [p.outputMint, p.outputDecimals, 'output']] as const) {
    const state = snapshot.accounts.get(mint);
    if (state && state.data.length >= MINT_SIZE && state.data[44] !== decimals) {
      fail('R2', `${side} decimals ${decimals} do not match the mint (${state.data[44]})`);
    }
  }
  const expected = {
    eIn: await ata(E, p.inputMint, inputProgram),
    eOut: A ? await ata(E, WSOL_MINT) : null,
    wIn: B ? null : await ata(W, p.inputMint, inputProgram),
    wOut: A ? null : await ata(W, p.outputMint, outputProgram),
    feeDestination: p.fee === 0n ? null : B ? p.treasury : await ata(p.treasury!, p.inputMint, inputProgram),
  };
  const acc = p.accounts;
  if (
    acc.eIn !== expected.eIn || acc.eOut !== expected.eOut || acc.wIn !== expected.wIn ||
    acc.wOut !== expected.wOut || acc.feeDestination !== expected.feeDestination
  ) {
    fail('R2', 'policy accounts do not match their derivation');
  }
  const { eIn, eOut, wIn, wOut, feeDestination } = expected;
  // Minimum-output check (B-04): a self-transfer on the account that receives the output.
  const minOut = A
    ? { account: eOut, authority: E, mint: WSOL_MINT, decimals: 9, amount: p.minOut, program: TOKEN_PROGRAM } // E_out is fresh (R3)
    : {
        account: wOut, authority: W, mint: p.outputMint, decimals: p.outputDecimals, program: outputProgram,
        amount: tokenBalance(snapshot.accounts.get(wOut!)) + p.minOut,
      };

  // Decode the exact message bytes. v0 lookups resolve only from the snapshot (read from the RPC).
  let compiled: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']>;
  let msg: ReturnType<typeof decompileTransactionMessage>;
  try {
    compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    msg = decompileTransactionMessage(compiled as never, { addressesByLookupTableAddress: snapshot.lookupTables as never });
  } catch (e) {
    fail('R1', `message accounts cannot be resolved: ${(e as Error).message}`);
    return { ok: false, violations };
  }
  const version = compiled.version;
  if (version !== 0 && version !== 1) fail('R5', `unsupported transaction version ${String(version)}`);

  // R6: W pays, and the only signers are W and E.
  const numSigners = compiled.header.numSignerAccounts;
  const signers = compiled.staticAccounts.slice(0, numSigners);
  if (compiled.staticAccounts[0] !== W) fail('R6', 'the fee payer is not the wallet');
  if (!(signers.length === 2 && signers.includes(W) && signers.includes(E))) {
    fail('R6', `unexpected signers: ${signers.join(', ')}`);
  }

  const instructions = msg.instructions as readonly RawInstruction[];
  const parsed: Parsed[] = instructions.map(ix => parseInstruction(ix));
  parsed.forEach((x, i) => {
    if (x.kind === 'invalid') fail('R2', `instruction ${i}: ${x.reason}`);
  });

  // Exactly one untrusted instruction, and it is Jupiter.
  const externals = parsed.flatMap((x, i) => (x.kind === 'external' ? [{ x, i }] : []));
  if (externals.length !== 1) fail('R2', `expected 1 external instruction, found ${externals.length}`);
  for (const { x } of externals) {
    if (x.program !== p.jupiterProgram) fail('R2', `external program ${x.program} is not Jupiter`);
  }
  const swapIndex = externals.length ? externals[0].i : -1;

  // Intermediate ATA(E, m) accounts: allowed only as matched create + close pairs (D14).
  const intermediates = new Map<string, { tokenProgram: Address; mint: Address; created: number; closed: number }>();
  for (const x of parsed) {
    if (x.kind !== 'createAta' || x.owner !== E || x.ata === eIn || x.ata === eOut) continue;
    if (x.mint === p.inputMint || (A && x.mint === WSOL_MINT)) continue;
    if (x.ata === (await ata(E, x.mint, x.tokenProgram))) {
      intermediates.set(x.ata, { tokenProgram: x.tokenProgram, mint: x.mint, created: 0, closed: 0 });
    }
  }

  // R2: every trusted instruction must fill one expected slot, with the exact accounts and amounts.
  const slots = new Map<Slot, number[]>();
  const put = (s: Slot, i: number) => slots.set(s, [...(slots.get(s) ?? []), i]);
  for (const [i, x] of parsed.entries()) {
    switch (x.kind) {
      case 'cuLimit':
        if (version === 1) fail('R4', 'ComputeBudget instruction in a v1 transaction');
        else if (x.units > MAX_COMPUTE_UNITS) fail('R4', `compute unit limit ${x.units} above maximum`);
        else put('cuLimit', i);
        break;
      case 'cuPrice':
        if (version === 1) fail('R4', 'ComputeBudget instruction in a v1 transaction');
        else put('cuPrice', i);
        break;
      case 'createAta': {
        if (x.payer !== W) { fail('R2', `instruction ${i}: account creation not paid by the wallet`); break; }
        if (x.tokenProgram === inputProgram && x.owner === E && x.mint === p.inputMint && x.ata === eIn) put('createEIn', i);
        else if (A && x.tokenProgram === TOKEN_PROGRAM && x.owner === E && x.mint === WSOL_MINT && x.ata === eOut) put('createEOut', i);
        else if (!A && x.tokenProgram === outputProgram && x.owner === W && x.mint === p.outputMint && x.ata === wOut) put('createWOut', i);
        else if (intermediates.has(x.ata)) { intermediates.get(x.ata)!.created++; put('createIntermediate', i); }
        else fail('R2', `instruction ${i}: unexpected account creation for ${x.owner}`);
        break;
      }
      case 'transferChecked': {
        const ours = x.program === inputProgram && x.source === wIn && x.mint === p.inputMint &&
          x.authority === W && x.decimals === p.inputDecimals;
        const floor = x.program === minOut.program && x.source === minOut.account && x.destination === minOut.account &&
          x.mint === minOut.mint && x.authority === minOut.authority && x.decimals === minOut.decimals;
        if (ours && x.destination === eIn && x.amount === p.swapAmount) put('transferIn', i);
        else if (ours && p.fee > 0n && x.destination === feeDestination && x.amount === p.fee) put('feeTransfer', i);
        else if (floor && x.amount === minOut.amount) put('minOutCheck', i);
        else if (floor) fail('R2', `instruction ${i}: minimum-output check for ${x.amount}, expected ${minOut.amount}`);
        else fail('R2', `instruction ${i}: unexpected token transfer of ${x.amount}`);
        break;
      }
      case 'systemTransfer':
        if (B && x.from === W && x.to === eIn && x.lamports === p.swapAmount) put('transferIn', i);
        else if (B && p.fee > 0n && x.from === W && x.to === feeDestination && x.lamports === p.fee) put('feeTransfer', i);
        else fail('R2', `instruction ${i}: unexpected SOL transfer of ${x.lamports} lamports`);
        break;
      case 'syncNative':
        if (B && x.account === eIn) put('sync', i);
        else fail('R2', `instruction ${i}: unexpected SyncNative`);
        break;
      case 'revoke':
        if (!A && x.program === outputProgram && x.source === wOut && x.owner === W) put('revokeWOut', i);
        else fail('R2', `instruction ${i}: unexpected Revoke`);
        break;
      case 'close': {
        if (x.destination !== W || x.owner !== E) { fail('R2', `instruction ${i}: account closed to someone other than the wallet`); break; }
        const mid = intermediates.get(x.account);
        if (x.program === inputProgram && x.account === eIn) put('closeEIn', i);
        else if (A && x.program === TOKEN_PROGRAM && x.account === eOut) put('closeEOut', i);
        else if (mid && mid.tokenProgram === x.program) { mid.closed++; put('closeIntermediate', i); }
        else fail('R2', `instruction ${i}: unexpected CloseAccount`);
        break;
      }
      default:
        break;
    }
  }

  const count = (s: Slot) => slots.get(s)?.length ?? 0;
  const need = (s: Slot, n: number, rule: RuleId = 'R2') => {
    if (count(s) !== n) fail(rule, `expected ${n} × ${s}, found ${count(s)}`);
  };
  need('createEIn', 1);
  need('transferIn', 1);
  need('closeEIn', 1, 'R5');
  if (A) {
    need('createEOut', 1);
    need('closeEOut', 1, 'R5');
  } else {
    need('createWOut', 1);
    need('revokeWOut', 1);
  }
  need('minOutCheck', 1);
  if (B) need('sync', 1);
  need('feeTransfer', p.fee > 0n ? 1 : 0);
  if (version === 0) { need('cuLimit', 1, 'R4'); need('cuPrice', 1, 'R4'); }
  for (const [address, m] of intermediates) {
    if (m.created !== 1 || m.closed !== 1) fail('R5', `intermediate account ${address} is not created and closed exactly once`);
  }
  if (intermediates.size > MAX_INTERMEDIATE_ACCOUNTS) {
    fail('R5', `${intermediates.size} intermediate accounts, above the maximum of ${MAX_INTERMEDIATE_ACCOUNTS}`);
  }

  // Order: setup before the swap, cleanup after it.
  if (swapIndex >= 0) {
    for (const s of BEFORE_SWAP) for (const i of slots.get(s) ?? []) if (i > swapIndex) fail('R2', `${s} must run before the swap`);
    for (const s of AFTER_SWAP) for (const i of slots.get(s) ?? []) if (i < swapIndex) fail('R5', `${s} must run after the swap`);
  }
  const first = (s: Slot) => slots.get(s)?.[0] ?? -1;
  if (first('createEIn') > first('transferIn')) fail('R2', 'the input account is funded before it is created');
  if (B && first('transferIn') > first('sync')) fail('R2', 'SyncNative runs before the SOL transfer');
  if (!A && first('createWOut') > first('revokeWOut')) fail('R2', 'W_out is revoked before it is created');
  if (A && first('minOutCheck') > first('closeEOut')) fail('R5', 'the minimum-output check runs after E_out is closed');

  // R1: the external program never receives W or any of W's token accounts except W_out.
  // (Sufficient only together with R6: see the note at the top of this file.)
  for (const { x } of externals) {
    if (x.kind !== 'external') continue;
    for (const a of x.accounts as readonly Account[]) {
      if (a.address === W) { fail('R1', 'the wallet is passed to the external program'); continue; }
      if (a.address === wIn) { fail('R1', "the wallet's input token account is passed to the external program"); continue; }
      if (a.address === feeDestination || a.address === p.treasury) {
        fail('R1', "Bound's fee account is passed to the external program"); // B-11
        continue;
      }
      if (a.address === wOut) continue;
      if (!snapshot.accounts.has(a.address)) { fail('R1', `external account ${a.address} missing from the snapshot`); continue; }
      const state = snapshot.accounts.get(a.address);
      if (state && isTokenAccountOwnedBy(state, W)) fail('R1', `the wallet's token account ${a.address} is passed to the external program`);
    }
  }

  // W_out is handed to the external program. A delegate is removed by the trusted Revoke; a close
  // authority cannot be, so such an account is refused (B-03).
  if (wOut) {
    if (!snapshot.accounts.has(wOut)) fail('R1', 'W_out missing from the snapshot');
    else if (hasCloseAuthority(snapshot.accounts.get(wOut))) fail('R1', 'W_out has a close authority set');
  }

  // R3: E and its accounts are fresh.
  const fresh: [string, Address | null][] = [['E', E], ['E_in', eIn], ['E_out', eOut], ...[...intermediates.keys()].map(k => ['intermediate', k as Address] as [string, Address])];
  for (const [label, address] of fresh) {
    if (!address) continue;
    if (!snapshot.accounts.has(address)) fail('R3', `${label} missing from the snapshot`);
    else if (exists(snapshot.accounts.get(address))) fail('R3', `${label} already exists on chain`);
  }

  // R4: maximum network fee paid by W.
  const signatureFee = LAMPORTS_PER_SIGNATURE * BigInt(numSigners);
  let priorityFee = 0n;
  if (version === 0) {
    const limit = parsed[first('cuLimit')];
    const price = parsed[first('cuPrice')];
    if (limit?.kind === 'cuLimit' && price?.kind === 'cuPrice') {
      priorityFee = (BigInt(limit.units) * price.microLamports + 999_999n) / 1_000_000n;
    }
  } else if (version === 1) {
    // The v1 config is an allowlist, like v0's instructions (B-07).
    const mask = (compiled as unknown as { configMask?: number }).configMask ?? 0;
    if (mask & ~V1_ALLOWED_CONFIG) fail('R4', `unexpected fields in the v1 message config (mask ${mask})`);
    const units = getTransactionMessageComputeUnitLimit(msg as never) ?? 0;
    if (units > MAX_COMPUTE_UNITS) fail('R4', `compute unit limit ${units} above maximum`);
    const loaded = getTransactionMessageLoadedAccountsDataSizeLimit(msg as never) ?? 0;
    if (loaded > MAX_LOADED_ACCOUNTS_DATA_SIZE) fail('R4', `loaded accounts data size limit ${loaded} above maximum`);
    priorityFee = getTransactionMessagePriorityFeeLamports(msg as never) ?? 0n;
  }
  const feeLimit = p.maxNetworkFeeLamports < ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS
    ? p.maxNetworkFeeLamports
    : ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS;
  if (signatureFee + priorityFee > feeLimit) {
    fail('R4', `network fee up to ${signatureFee + priorityFee} lamports, above ${feeLimit}`);
  }

  // R5: one transaction within the size limits.
  const size = getTransactionSize(transaction);
  const limit = version === 1 ? V1_SIZE_LIMIT : LEGACY_SIZE_LIMIT;
  if (size > limit) fail('R5', `transaction is ${size} bytes, limit ${limit}`);
  if (version === 1 && compiled.staticAccounts.length > V1_MAX_ACCOUNTS) fail('R5', `${compiled.staticAccounts.length} accounts, limit ${V1_MAX_ACCOUNTS}`);

  // R7 for hops (audit B-10): a Token-2022 intermediate mint must be in the snapshot and carry
  // only extensions a protected swap can live with. Classic SPL hops need no check.
  for (const m of intermediates.values()) {
    if (m.tokenProgram !== TOKEN_2022_PROGRAM) continue;
    const state = snapshot.accounts.get(m.mint);
    const risky = state && state.owner === TOKEN_2022_PROGRAM ? unsupportedExtension(state.data) : 'missing mint';
    if (risky) fail('R7', `intermediate mint ${m.mint}: ${risky}`);
  }

  // R7: both mints are token mints Bound can isolate - classic SPL (WSOL included), or Token-2022
  // with none of the extensions that would break the guarantee.
  for (const mint of [p.inputMint, p.outputMint]) {
    const state = snapshot.accounts.get(mint);
    if (!state) { fail('R7', `mint ${mint} not found`); continue; }
    if (state.owner === TOKEN_PROGRAM) continue;
    if (state.owner !== TOKEN_2022_PROGRAM) { fail('R7', `mint ${mint} is not a token mint`); continue; }
    const bad = unsupportedExtension(state.data);
    if (bad) fail('R7', `mint ${mint}: ${bad}`);
  }

  return { ok: violations.length === 0, violations };
}
