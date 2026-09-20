import { decompileTransactionMessage, getCompiledTransactionMessageDecoder } from '@solana/kit';
import type { Address, Transaction } from '@solana/kit';
import { ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS } from '@bound/core/constants';
import type { ChainSnapshot, Policy, Violation } from '@bound/core/types';
import { verify } from './verify.ts';

/** Changes whenever a rule changes; every certificate names the verifier that issued it. */
export const VERIFIER_VERSION = '0.3.0';

/**
 * What a verified transaction does, in terms a person or a wallet can check. It is issued only after
 * every rule passed on these exact bytes, and it is bound to them by the SHA-256 of the message: it
 * says nothing about any other message.
 *
 * A certificate is as trustworthy as the verifier that issued it. Whoever does not trust the page
 * that produced it (a wallet, an auditor) should run the verifier on the same bytes, policy and
 * chain state and compare.
 */
export type Certificate = {
  verifierVersion: string;
  messageSha256: string;
  transactionVersion: 0 | 1;
  wallet: Address;
  /** The one-time key E: the only authority the external program receives. */
  temporaryAuthority: Address;
  input: {
    mint: Address;
    decimals: number;
    /** Everything that leaves the wallet in the input token: swap amount plus Bound fee. */
    totalDebit: bigint;
    swapAmount: bigint;
    boundFee: bigint;
    feeDestination: Address | null;
  };
  output: {
    mint: Address;
    decimals: number;
    /** Enforced on chain: if less arrives, the whole transaction reverts. */
    minimumOutput: bigint;
  };
  networkFeeLimitLamports: bigint;
  /**
   * No token other than the input leaves the wallet. The network fee and the rent of a new account
   * are separate and are stated above; this field is about tokens, not about lamports.
   */
  otherTokenDebit: 0;
  /** Nothing the transaction grants outlives it: no delegate, no authority, no account. */
  persistentPermissions: 0;
  signers: readonly [Address, Address];
  externalProgram: Address;
  /**
   * The programs this transaction invokes directly. Those programs may invoke others of their own,
   * which no list built from the message can name; what bounds them is the isolation, not this.
   */
  directPrograms: readonly Address[];
  /** The slot of the chain state every rule was checked against, when the reader recorded one. */
  snapshotSlot: bigint | null;
};

export type Certification = { ok: true; certificate: Certificate } | { ok: false; violations: Violation[] };

const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

/** Verifies the transaction and, only if every rule holds, issues its certificate. */
export async function certify(transaction: Transaction, policy: Policy, snapshot: ChainSnapshot): Promise<Certification> {
  const verdict = await verify(transaction, policy, snapshot);
  if (!verdict.ok) return { ok: false, violations: verdict.violations };

  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const message = decompileTransactionMessage(compiled as never, { addressesByLookupTableAddress: snapshot.lookupTables as never });
  const programs = [...new Set((message.instructions as readonly { programAddress: Address }[]).map(ix => ix.programAddress))];
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(transaction.messageBytes)));
  const feeLimit = policy.maxNetworkFeeLamports < ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS ? policy.maxNetworkFeeLamports : ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS;

  return {
    ok: true,
    certificate: {
      verifierVersion: VERIFIER_VERSION,
      messageSha256: hex(digest),
      transactionVersion: compiled.version as 0 | 1,
      wallet: policy.owner,
      temporaryAuthority: policy.ephemeral,
      input: {
        mint: policy.inputMint,
        decimals: policy.inputDecimals,
        totalDebit: policy.amountIn,
        swapAmount: policy.swapAmount,
        boundFee: policy.fee,
        feeDestination: policy.accounts.feeDestination,
      },
      output: { mint: policy.outputMint, decimals: policy.outputDecimals, minimumOutput: policy.minOut },
      networkFeeLimitLamports: feeLimit,
      otherTokenDebit: 0,
      persistentPermissions: 0,
      signers: [policy.owner, policy.ephemeral],
      externalProgram: policy.jupiterProgram,
      directPrograms: programs,
      snapshotSlot: snapshot.slot ?? null,
    },
  };
}

/** JSON with amounts as decimal strings, for display, copying or a wallet integration. */
export const certificateJson = (c: Certificate) =>
  JSON.stringify(c, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
