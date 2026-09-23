import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM, JUPITER_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '@bound/core';
import { jupiterRouteArgs } from '@bound/verifier';

type Ix = { program: string | undefined; accounts: number; data: Uint8Array };

/** Each instruction's program, account count and data, from a compiled v0 or v1 message. */
function instructionsOf(messageBytes: Uint8Array): { version: unknown; signers: number; ixs: Ix[] } {
  const m = getCompiledTransactionMessageDecoder().decode(messageBytes) as unknown as {
    version: unknown;
    header: { numSignerAccounts: number };
    staticAccounts: string[];
    instructions?: { programAddressIndex: number; accountIndices?: number[]; data?: ArrayLike<number> }[];
    instructionHeaders?: { programAccountIndex: number; numInstructionAccounts: number }[];
    instructionPayloads?: { instructionData: ArrayLike<number> }[];
  };
  const ixs = m.instructions
    ? m.instructions.map(ix => ({
      program: m.staticAccounts[ix.programAddressIndex], accounts: ix.accountIndices?.length ?? 0, data: Uint8Array.from(ix.data ?? []),
    }))
    : (m.instructionHeaders ?? []).map((h, i) => ({
      program: m.staticAccounts[h.programAccountIndex], accounts: h.numInstructionAccounts,
      data: Uint8Array.from(m.instructionPayloads?.[i]?.instructionData ?? []),
    }));
  return { version: m.version, signers: m.header.numSignerAccounts, ixs };
}

/** The shapes a Bound transaction is made of, the same the verifier's parser accepts (parse.ts). */
function trusted(ix: Ix): boolean {
  const d = ix.data;
  switch (ix.program) {
    case COMPUTE_BUDGET_PROGRAM:
      return ix.accounts === 0 && ((d[0] === 2 && d.length === 5) || (d[0] === 3 && d.length === 9));
    case ATA_PROGRAM:
      return d.length === 1 && d[0] === 1 && ix.accounts === 6;
    case SYSTEM_PROGRAM:
      return d.length === 12 && d[0] === 2 && d[1] === 0 && d[2] === 0 && d[3] === 0 && ix.accounts === 2;
    case TOKEN_PROGRAM:
    case TOKEN_2022_PROGRAM:
      return (d[0] === 12 && d.length === 10 && ix.accounts === 4)
        || (d[0] === 9 && d.length === 1 && ix.accounts === 3)
        || (d[0] === 5 && d.length === 1 && ix.accounts === 2)
        || (d[0] === 17 && d.length === 1 && ix.accounts === 1 && ix.program === TOKEN_PROGRAM)
        || (d[0] === 26 && d[1] === 4 && d.length === 2 && ix.accounts >= 2 && ix.program === TOKEN_2022_PROGRAM);
    default:
      return false;
  }
}

/**
 * Why a transaction is not one Bound builds, or null when it has the shape of one (review FA-06):
 * two signers, one Jupiter route Bound can read, and otherwise only the trusted instructions a Bound
 * swap is made of. The relay sends and simulates nothing else, so it cannot be used as a free Solana
 * broadcaster or simulator on Bound's RPC account. This is a filter for cost, not a security check:
 * the verifier, with the chain state, is what decides whether a transaction is safe.
 */
export function notBoundShaped(wireBase64: unknown): string | null {
  if (typeof wireBase64 !== 'string' || wireBase64.length > 8_000) return 'not a base64 transaction';
  let message: Uint8Array;
  try {
    message = new Uint8Array(getTransactionDecoder().decode(Buffer.from(wireBase64, 'base64')).messageBytes);
  } catch {
    return 'not a transaction';
  }
  let shape: ReturnType<typeof instructionsOf>;
  try {
    shape = instructionsOf(message);
  } catch {
    return 'not a transaction message';
  }
  if (shape.version !== 0 && shape.version !== 1) return 'not a v0 or v1 transaction';
  if (shape.signers !== 2) return 'not signed by a wallet and a one-time key';
  let routes = 0;
  for (const ix of shape.ixs) {
    if (ix.program === JUPITER_PROGRAM && jupiterRouteArgs(ix.data)) routes++;
    else if (!trusted(ix)) return `an instruction of ${ix.program ?? 'an unknown program'} that no Bound swap contains`;
  }
  return routes === 1 ? null : `${routes} Jupiter routes, not one`;
}
