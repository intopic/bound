/**
 * A wallet that changes the message after Orientim verified it (AUDIT section 10, section 0h).
 * Phantom documents that it may add Lighthouse assertions; wallets may also raise the priority fee.
 * The real pipeline prepares a swap against the fakes, a simulated wallet alters and signs it, and
 * the page's own finalize step runs: it must stop before E signs, and send nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  address, generateKeyPairSigner, getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder,
  getTransactionDecoder, getTransactionEncoder, partiallySignTransaction,
} from '@solana/kit';
import type { Address, KeyPairSigner, Transaction } from '@solana/kit';
import { ataOf, JUPITER_PROGRAM, WSOL_MINT } from '@orientim/core';
import { DEFAULT_SETTINGS, finalizeProtectedSwap, OrientimError, prepareProtectedSwap } from '../src/swap.ts';
import { BONK, DECIMALS, DEX, fakeJupiter, fakeRpc, fundedAccounts, mint, POOL, USDC } from './fakes.ts';
import type { Account } from './fakes.ts';

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
// A stand-in for the Lighthouse program: what matters is that an instruction is appended.
const ASSERTION_PROGRAM = address('Sysvar1nstructions1111111111111111111111111');

async function prepared() {
  const owner = await generateKeyPairSigner();
  const E = await generateKeyPairSigner();
  const accounts = new Map<string, Account>([
    [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
    [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [POOL, { owner: DEX, data: new Uint8Array(300) }],
  ]);
  for (const [key, account] of await fundedAccounts(owner.address, USDC)) accounts.set(key, account);
  expect(accounts.has(await ataOf(owner.address, USDC))).toBe(true);
  const sent: string[] = [];
  // A sent transaction lands at once, so the happy path settles without waiting.
  const rpc = fakeRpc(accounts, { sent, landOnSend: true, statuses: new Map() });
  const swap = await prepareProtectedSwap(
    { rpc, jupiter: fakeJupiter(), settings: { ...DEFAULT_SETTINGS, treasury: null, jupiterProgram: JUPITER_PROGRAM } },
    {
      owner: owner.address, ephemeral: E, inputMint: USDC, outputMint: BONK, amountIn: 1_000_000n,
      inputDecimals: DECIMALS[USDC], outputDecimals: DECIMALS[BONK], version: 0,
    },
  );
  return { owner, E, rpc, sent, swap };
}

type Compiled = {
  header: { numReadonlyNonSignerAccounts: number };
  staticAccounts: Address[];
  instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
};

/** Re-encodes the message after `change` edits its compiled form, as a wallet would. */
function alter(tx: Transaction, change: (m: Compiled) => void): Transaction {
  const m = structuredClone(getCompiledTransactionMessageDecoder().decode(tx.messageBytes)) as unknown as Compiled;
  change(m);
  const messageBytes = getCompiledTransactionMessageEncoder().encode(m as never);
  return { ...tx, messageBytes } as Transaction;
}

/** Phantom's documented behaviour: an assertion appended after the swap (AssertSysvarClock: no accounts). */
const appendAssertion = (m: Compiled) => {
  const before = m.staticAccounts.length;
  m.staticAccounts.push(ASSERTION_PROGRAM);
  m.header.numReadonlyNonSignerAccounts++;
  // Accounts from lookup tables are numbered after the static ones, so they move up by one.
  for (const ix of m.instructions) {
    if (ix.programAddressIndex >= before) ix.programAddressIndex++;
    ix.accountIndices = ix.accountIndices?.map(i => (i >= before ? i + 1 : i));
  }
  m.instructions.push({ programAddressIndex: before, data: new Uint8Array([15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) });
};

/** A wallet raising the priority fee: SetComputeUnitPrice (3) with a higher price. */
const raisePriorityFee = (m: Compiled) => {
  const budget = m.staticAccounts.indexOf(address(COMPUTE_BUDGET));
  const ix = m.instructions.find(i => i.programAddressIndex === budget && i.data?.[0] === 3);
  expect(ix).toBeDefined();
  const data = Uint8Array.from(ix!.data!);
  new DataView(data.buffer).setBigUint64(1, new DataView(data.buffer).getBigUint64(1, true) * 10n + 1n, true);
  ix!.data = data;
};

const encode = (tx: Transaction) => new Uint8Array(getTransactionEncoder().encode(tx));

/** The wallet signs whatever message it chose to sign, leaving E's slot empty. */
async function walletSigns(owner: KeyPairSigner, tx: Transaction) {
  return encode(await partiallySignTransaction([owner.keyPair], tx));
}

async function finalize(p: Awaited<ReturnType<typeof prepared>>, walletSignedBytes: Uint8Array) {
  return finalizeProtectedSwap({ rpc: p.rpc, prepared: p.swap, walletSignedBytes, ephemeral: p.E });
}

async function refusal(p: Promise<unknown>) {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(OrientimError);
  return e as OrientimError;
}

describe('a wallet that alters the message after verification (AUDIT section 10)', () => {
  it('the unaltered message, signed by W with E left empty, is countersigned and sent once', async () => {
    const p = await prepared();
    const result = await finalize(p, await walletSigns(p.owner, p.swap.transaction));
    expect(result.status).toBe('confirmed');
    expect(p.sent).toHaveLength(1);
    const wire = getTransactionDecoder().decode(Buffer.from(p.sent[0], 'base64'));
    expect([...wire.messageBytes]).toEqual([...p.swap.transaction.messageBytes]);
    expect(wire.signatures[p.E.address]).toBeTruthy();
    expect(wire.signatures[p.owner.address]).toBeTruthy();
  });

  it('an appended Lighthouse-style assertion is refused before E signs, and nothing is sent', async () => {
    const p = await prepared();
    const altered = alter(p.swap.transaction, appendAssertion);
    // The alteration is well formed: it still decodes, with one more instruction.
    const count = (t: Transaction) => (getCompiledTransactionMessageDecoder().decode(t.messageBytes) as unknown as Compiled).instructions.length;
    expect(count(altered)).toBe(count(p.swap.transaction) + 1);

    const e = await refusal(finalize(p, await walletSigns(p.owner, altered)));
    expect(e.code).toBe('wallet-changed-transaction');
    expect(e.violations.map(v => v.detail)).toEqual([
      'the wallet changed the transaction message',
      "the wallet's signature does not match the verified message",
    ]);
    expect(p.sent).toEqual([]);
  });

  it('a raised priority fee is refused the same way', async () => {
    const p = await prepared();
    const e = await refusal(finalize(p, await walletSigns(p.owner, alter(p.swap.transaction, raisePriorityFee))));
    expect(e.code).toBe('wallet-changed-transaction');
    expect(e.violations.map(v => v.detail)).toContain('the wallet changed the transaction message');
    expect(p.sent).toEqual([]);
  });

  it('a wallet that signs its altered message but returns the original bytes is refused too', async () => {
    const p = await prepared();
    const signedAltered = await partiallySignTransaction([p.owner.keyPair], alter(p.swap.transaction, appendAssertion));
    const disguised = { ...p.swap.transaction, signatures: { ...p.swap.transaction.signatures, ...signedAltered.signatures } } as Transaction;
    const e = await refusal(finalize(p, encode(disguised)));
    expect(e.code).toBe('wallet-changed-transaction');
    expect(e.violations.map(v => v.detail)).toEqual(["the wallet's signature does not match the verified message"]);
    expect(p.sent).toEqual([]);
  });
});
