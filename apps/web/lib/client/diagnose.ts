'use client';

import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';

/**
 * What a wallet did to a transaction it was asked to sign.
 *
 * Bound's rule is that the bytes it verified are the bytes that execute. A wallet that appends its
 * own guard breaks that equality, and Bound cannot decide what to allow until it has seen what a
 * real wallet actually sends back. Nothing here judges or accepts anything: it decodes both
 * messages and states the difference, so the acceptance rule can be written from evidence.
 *
 * It reads the compiled message directly rather than decompiling it, so it needs no lookup-table
 * contents and cannot fail on an account it has never heard of.
 */

const hex = (bytes: Uint8Array | undefined) =>
  bytes ? [...bytes].map(b => b.toString(16).padStart(2, '0')).join('') : '';

export type AccountRef = {
  index: number;
  /** Null when the account comes from a lookup table, whose contents are not needed here. */
  address: string | null;
  source: 'static' | 'lookup';
  signer: boolean;
  writable: boolean;
};

export type SeenInstruction = {
  position: number;
  program: string | null;
  programIndex: number;
  /** The first data byte, which is the instruction selector for every program Bound touches. */
  discriminator: number | null;
  dataLength: number;
  data: string;
  accounts: AccountRef[];
};

export type MessageFacts = {
  version: number | 'legacy';
  wireBytes: number;
  messageBytes: number;
  feePayer: string | null;
  blockhash: string | null;
  signerCount: number;
  staticAccounts: string[];
  lookupTables: { table: string; writable: number[]; readOnly: number[] }[];
  instructions: SeenInstruction[];
  signedBy: string[];
  expectedSigners: string[];
};

export type WalletDiagnosis = {
  identical: boolean;
  original: MessageFacts;
  returned: MessageFacts;
  /** Where the wallet's own instructions sit relative to Bound's, once they are aligned. */
  placement: 'none' | 'suffix' | 'prefix' | 'both' | 'not-aligned';
  addedBefore: SeenInstruction[];
  addedAfter: SeenInstruction[];
  /** Positions of Bound's own instructions that came back different, when alignment failed. */
  changedPositions: number[];
  newAccounts: string[];
  newSigners: string[];
  changedFeePayer: boolean;
  changedBlockhash: boolean;
  changedVersion: boolean;
  changedLookupTables: boolean;
  /** Plain sentences, in the order they matter. Empty when the wallet changed nothing. */
  findings: string[];
};

type Compiled = ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']>;
type RawInstruction = { programAddressIndex: number; accountIndices: number[]; data: Uint8Array };

/** v0 and legacy keep one list of instructions; v1 splits each into a header and a payload. */
function instructionsOf(compiled: Compiled): RawInstruction[] {
  if ('instructions' in compiled) {
    return compiled.instructions.map(ix => ({
      programAddressIndex: ix.programAddressIndex,
      accountIndices: [...(ix.accountIndices ?? [])],
      data: (ix.data ?? new Uint8Array()) as Uint8Array,
    }));
  }
  return compiled.instructionHeaders.map((header, i) => ({
    programAddressIndex: header.programAccountIndex,
    accountIndices: [...(compiled.instructionPayloads[i]?.instructionAccountIndices ?? [])],
    data: (compiled.instructionPayloads[i]?.instructionData ?? new Uint8Array()) as Uint8Array,
  }));
}

/** Static accounts carry their privileges in the header; lookup-table accounts are never signers. */
function accountRef(compiled: Compiled, index: number): AccountRef {
  const statics = compiled.staticAccounts;
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } = compiled.header;
  if (index < statics.length) {
    const writableSigners = numSignerAccounts - numReadonlySignerAccounts;
    const signer = index < numSignerAccounts;
    const writable = signer ? index < writableSigners : index < statics.length - numReadonlyNonSignerAccounts;
    return { index, address: statics[index], source: 'static', signer, writable };
  }
  // After the static list come every table's writable entries, then every table's read-only ones.
  const lookups = ('addressTableLookups' in compiled ? compiled.addressTableLookups : undefined) ?? [];
  const writableCount = lookups.reduce((n, t) => n + t.writableIndexes.length, 0);
  return { index, address: null, source: 'lookup', signer: false, writable: index - statics.length < writableCount };
}

function factsOf(wire: Uint8Array): MessageFacts {
  const transaction = getTransactionDecoder().decode(wire);
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const lifetime = 'lifetimeToken' in compiled ? compiled.lifetimeToken : null;
  const lookups = ('addressTableLookups' in compiled ? compiled.addressTableLookups : undefined) ?? [];
  return {
    version: compiled.version,
    wireBytes: wire.length,
    messageBytes: transaction.messageBytes.length,
    feePayer: compiled.staticAccounts[0] ?? null,
    blockhash: typeof lifetime === 'string' ? lifetime : null,
    signerCount: compiled.header.numSignerAccounts,
    staticAccounts: [...compiled.staticAccounts],
    lookupTables: lookups.map(t => ({
      table: t.lookupTableAddress, writable: [...t.writableIndexes], readOnly: [...t.readonlyIndexes],
    })),
    instructions: instructionsOf(compiled).map((ix, position) => ({
      position,
      program: compiled.staticAccounts[ix.programAddressIndex] ?? null,
      programIndex: ix.programAddressIndex,
      discriminator: ix.data.length ? ix.data[0] : null,
      dataLength: ix.data.length,
      data: hex(ix.data),
      accounts: ix.accountIndices.map(i => accountRef(compiled, i)),
    })),
    signedBy: Object.entries(transaction.signatures).filter(([, s]) => s).map(([a]) => a),
    expectedSigners: Object.keys(transaction.signatures),
  };
}

/** Two instructions are the same when the program, the data and the account list all match. */
const key = (ix: SeenInstruction) =>
  `${ix.program ?? ix.programIndex}|${ix.data}|${ix.accounts.map(a => `${a.address ?? a.index}:${a.signer ? 's' : ''}${a.writable ? 'w' : ''}`).join(',')}`;

/** The offset at which Bound's instruction list appears intact inside the returned one, or -1. */
function alignment(before: SeenInstruction[], after: SeenInstruction[]): number {
  const want = before.map(key);
  const have = after.map(key);
  for (let offset = 0; offset + want.length <= have.length; offset++) {
    if (want.every((k, i) => k === have[offset + i])) return offset;
  }
  return -1;
}

export function diagnoseWalletReturn(originalWire: Uint8Array, returnedWire: Uint8Array): WalletDiagnosis {
  const original = factsOf(originalWire);
  const returned = factsOf(returnedWire);

  const identical = sameMessage(originalWire, returnedWire);

  const offset = alignment(original.instructions, returned.instructions);
  const addedBefore = offset > 0 ? returned.instructions.slice(0, offset) : [];
  const addedAfter = offset >= 0 ? returned.instructions.slice(offset + original.instructions.length) : [];
  const changedPositions = offset >= 0
    ? []
    : original.instructions
      .map((ix, i) => (returned.instructions[i] && key(returned.instructions[i]) === key(ix) ? -1 : i))
      .filter(i => i >= 0);

  const known = new Set(original.staticAccounts);
  const newAccounts = returned.staticAccounts.filter(a => !known.has(a));
  const originalSigners = new Set(original.staticAccounts.slice(0, original.signerCount));
  const newSigners = returned.staticAccounts.slice(0, returned.signerCount).filter(a => !originalSigners.has(a));

  const changedLookupTables = JSON.stringify(original.lookupTables) !== JSON.stringify(returned.lookupTables);
  const changedFeePayer = original.feePayer !== returned.feePayer;
  const changedBlockhash = original.blockhash !== returned.blockhash;
  const changedVersion = original.version !== returned.version;

  const placement: WalletDiagnosis['placement'] = offset < 0
    ? 'not-aligned'
    : addedBefore.length && addedAfter.length ? 'both'
      : addedBefore.length ? 'prefix'
        : addedAfter.length ? 'suffix' : 'none';

  const findings: string[] = [];
  if (!identical) {
    findings.push(`The wallet returned a different message: ${original.messageBytes} bytes in, ${returned.messageBytes} out.`);
    if (changedVersion) findings.push(`It changed the transaction version from ${original.version} to ${returned.version}.`);
    if (changedFeePayer) findings.push(`It changed the fee payer from ${original.feePayer} to ${returned.feePayer}.`);
    if (changedBlockhash) findings.push('It changed the blockhash, so the lifetime is not the one Bound verified.');
    if (offset < 0) {
      findings.push(changedPositions.length
        ? `Bound's own instructions did not come back intact: positions ${changedPositions.join(', ')} differ.`
        : "Bound's own instructions could not be found intact in the returned message.");
    }
    if (addedBefore.length) findings.push(`It added ${addedBefore.length} instruction(s) BEFORE Bound's, which a suffix-only rule would reject.`);
    if (addedAfter.length) findings.push(`It appended ${addedAfter.length} instruction(s) after Bound's.`);
    for (const ix of [...addedBefore, ...addedAfter]) {
      findings.push(`Added: program ${ix.program ?? `#${ix.programIndex}`}, selector ${ix.discriminator ?? '—'}, ${ix.dataLength} data bytes, ${ix.accounts.length} account(s).`);
    }
    if (newSigners.length) findings.push(`It added a new signer: ${newSigners.join(', ')}.`);
    else if (newAccounts.length) findings.push(`It added ${newAccounts.length} new account(s), none of them signers: ${newAccounts.join(', ')}.`);
    if (changedLookupTables) findings.push('It changed the address lookup tables, so accounts resolve differently.');
  }

  return {
    identical, original, returned, placement, addedBefore, addedAfter, changedPositions,
    newAccounts, newSigners, changedFeePayer, changedBlockhash, changedVersion, changedLookupTables, findings,
  };
}

function sameMessage(a: Uint8Array, b: Uint8Array): boolean {
  const left = getTransactionDecoder().decode(a).messageBytes;
  const right = getTransactionDecoder().decode(b).messageBytes;
  return left.length === right.length && left.every((x, i) => x === right[i]);
}

/** The report as text, to send back with the manual wallet test (docs/TESTIMI.md, test 0): the evidence behind the rule. */
export function reportText(wallet: string, d: WalletDiagnosis): string {
  const ixLine = (ix: SeenInstruction) => [
    `  [${ix.position}] program ${ix.program ?? `lookup#${ix.programIndex}`}`,
    `      selector ${ix.discriminator ?? '—'}, data ${ix.dataLength} bytes: ${ix.data.slice(0, 160)}${ix.data.length > 160 ? '…' : ''}`,
    ...ix.accounts.map(a =>
      `      account ${a.index} ${a.address ?? '(from a lookup table)'} ${a.signer ? 'signer ' : ''}${a.writable ? 'writable' : 'read-only'}`),
  ].join('\n');

  const side = (title: string, m: MessageFacts) => [
    `${title}`,
    `  version ${m.version}, message ${m.messageBytes} bytes, wire ${m.wireBytes} bytes`,
    `  fee payer ${m.feePayer}, blockhash ${m.blockhash}`,
    `  ${m.staticAccounts.length} static accounts, ${m.signerCount} signer(s), ${m.lookupTables.length} lookup table(s)`,
    `  signed by: ${m.signedBy.join(', ') || 'nobody'}`,
    ...m.instructions.map(ixLine),
  ].join('\n');

  return [
    `Wallet: ${wallet}`,
    `Observed: ${new Date().toISOString()}`,
    `Result: ${d.identical ? 'byte-identical, the wallet changed nothing' : `changed, additions sit as a ${d.placement}`}`,
    '',
    ...(d.findings.length ? ['Findings:', ...d.findings.map(f => `  - ${f}`), ''] : []),
    side('Sent to the wallet:', d.original),
    '',
    side('Returned by the wallet:', d.returned),
    '',
  ].join('\n');
}
