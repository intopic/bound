/**
 * A fake RPC and a fake Jupiter that answer the way the chain and Jupiter do (or the way an attacker
 * would), shared by the pipeline's tests and the agent API's.
 */
import {
  address, decompileTransactionMessage, getAddressEncoder, getCompiledTransactionMessageDecoder, getTransactionDecoder,
} from '@solana/kit';
import type { Address } from '@solana/kit';
import { ataOf, ATA_PROGRAM, JUPITER_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from '@bound/core';
import type { SolanaRpc } from '@bound/solana';
import { JupiterError } from '../src/client.ts';
import type { BuildParams, BuildResponse, JupiterClient } from '../src/client.ts';

export const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const BONK = address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
export const DECIMALS: Record<string, number> = { [USDC]: 6, [WSOL_MINT]: 9, [BONK]: 5 };
export const DEX = address('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
export const POOL = address('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ');
export const OUT = 1_000_000_000n;
export const PUMP = address('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const b64 = (d: Uint8Array) => Buffer.from(d).toString('base64');

export type Account = { owner: Address; data: Uint8Array };

export function mint(decimals: number): Account {
  const data = new Uint8Array(82);
  data[44] = decimals;
  return { owner: TOKEN_PROGRAM, data };
}

/** A Token-2022 mint that charges `bps` on every transfer, with no cap. */
export function feeMint(decimals: number, bps: number): Account {
  const data = new Uint8Array(166 + 4 + 108);
  data[44] = decimals;
  data[165] = 1; // AccountType::Mint
  const view = new DataView(data.buffer);
  view.setUint16(166, 1, true); // TransferFeeConfig
  view.setUint16(168, 108, true);
  const newer = 170 + 90; // two authorities, the withheld amount, then older and newer
  view.setBigUint64(newer, 0n, true); // from epoch 0
  view.setBigUint64(newer + 8, 2n ** 63n, true); // no practical cap
  view.setUint16(newer + 16, bps, true);
  return { owner: TOKEN_2022_PROGRAM, data };
}

/** A Token-2022 mint that runs a transfer hook: arbitrary code on every transfer of it. */
export function hookMint(decimals: number, program: Address): Account {
  const data = new Uint8Array(166 + 4 + 64);
  data[44] = decimals;
  data[165] = 1; // AccountType::Mint
  const view = new DataView(data.buffer);
  view.setUint16(166, 14, true); // TransferHook
  view.setUint16(168, 64, true);
  data.set(getAddressEncoder().encode(program), 170 + 32); // authority, then the program it calls
  return { owner: TOKEN_2022_PROGRAM, data };
}

/** A plain Token-2022 mint with no extensions at all. */
export function plain2022Mint(decimals: number): Account {
  const data = new Uint8Array(166);
  data[44] = decimals;
  data[165] = 1;
  return { owner: TOKEN_2022_PROGRAM, data };
}

export function tokenAccount(owner: Address, mintAddress: Address, opts: { delegate?: boolean; memo?: boolean } = {}): Account {
  // A Token-2022 account that requires a memo carries extension 8 after the account-type byte.
  const data = new Uint8Array(opts.memo ? 171 : 165);
  data.set(getAddressEncoder().encode(mintAddress), 0);
  data.set(getAddressEncoder().encode(owner), 32);
  if (opts.delegate) data[72] = 1;
  data[108] = 1; // initialized
  if (opts.memo) {
    data[165] = 2; // AccountType::Account
    new DataView(data.buffer).setUint16(166, 8, true); // MemoTransfer
    new DataView(data.buffer).setUint16(168, 1, true);
    data[170] = 1; // requireIncomingTransferMemos = true
  }
  return { owner: TOKEN_PROGRAM, data };
}

/**
 * The SOL a transaction sends the temporary key: the signer that is not the fee payer, credited by
 * a System transfer (instruction 2).
 */
export function lamportsSentToTaker(wire: string): { taker: string; lamports: bigint; swapIndex: number } {
  const tx = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(wire, 'base64')));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const message = decompileTransactionMessage(compiled as never);
  const taker = compiled.staticAccounts.slice(1, compiled.header.numSignerAccounts)[0];
  let lamports = 0n;
  for (const ix of message.instructions) {
    const data = ix.data ?? new Uint8Array();
    if (ix.programAddress !== SYSTEM_PROGRAM || data[0] !== 2 || ix.accounts?.[1]?.address !== taker) continue;
    lamports += new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(4, true);
  }
  return { taker, lamports, swapIndex: message.instructions.findIndex(ix => ix.programAddress === JUPITER_PROGRAM) };
}

export function fakeRpc(
  accounts: Map<string, Account>,
  opts: {
    feeFails?: boolean; epochFails?: boolean; takerRent?: bigint; priceMoves?: number; walletShort?: boolean;
    feeLevels?: bigint[] | 'fails'; simulations?: { count: number };
    /** The block height the chain reports (the fake blockhash lives until 1,000). */
    height?: bigint;
    /** Every transaction sent, as the wire string. */
    sent?: string[];
  } = {},
): SolanaRpc {
  const call = (fn: (...a: never[]) => unknown) => (...a: never[]) => ({ send: async () => fn(...a) });
  let moved = 0;
  return {
    getMultipleAccounts: call((addresses: string[]) => ({
      context: { slot: 300_000_000n },
      value: addresses.map(a => {
        const acc = accounts.get(a);
        return acc ? { owner: acc.owner, lamports: 2_000_000n, data: [b64(acc.data), 'base64'], executable: false, space: BigInt(acc.data.length) } : null;
      }),
    })),
    getLatestBlockhash: call(() => ({ value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1_000n } })),
    getBlockHeight: call(() => opts.height ?? 1n),
    sendTransaction: call((wire: string) => {
      opts.sent?.push(wire);
      return 'sig';
    }),
    getSignatureStatuses: call(() => ({ value: [null] })),
    // A route that opens an account in the taker's name fails, as PumpSwap does, until the taker
    // holds its rent; with it, the taker ends holding whatever it was sent beyond the rent.
    simulateTransaction: call((wire: string, config: { accounts?: { addresses: string[] } }) => {
      const need = opts.takerRent ?? 0n;
      if (opts.simulations) opts.simulations.count++;
      const { taker, lamports, swapIndex } = lamportsSentToTaker(wire);
      // The wallet cannot pay for its own part: the first instruction, a rent payment, fails.
      if (opts.walletShort) {
        return { value: { err: { InstructionError: [0, { Custom: 1 }] }, logs: ['Transfer: insufficient lamports 400000, need 2039280'], unitsConsumed: 5_000n } };
      }
      if (lamports < need) {
        return { value: { err: { InstructionError: [swapIndex, { Custom: 1 }] }, logs: [`Transfer: insufficient lamports ${lamports}, need ${need}`], unitsConsumed: 90_000n } };
      }
      // The price moves between the quote and the simulation, and Jupiter stops the route itself.
      if (moved < (opts.priceMoves ?? 0)) {
        moved++;
        return {
          value: {
            err: { InstructionError: [swapIndex, { Custom: 6001 }] }, unitsConsumed: 150_000n,
            logs: [`Program ${JUPITER_PROGRAM} invoke [1]`, `Program ${JUPITER_PROGRAM} failed: custom program error: 0x1771`],
          },
        };
      }
      return {
        value: {
          err: null, logs: [], unitsConsumed: 200_000n,
          accounts: config.accounts?.addresses.map(a => (a === taker ? { lamports: lamports - need } : null)) ?? null,
        },
      };
    }),
    getFeeForMessage: call(() => {
      if (opts.feeFails) throw new Error('RPC unavailable');
      return { value: 15_000n };
    }),
    getMinimumBalanceForRentExemption: call((size: bigint) => (BigInt(size) === 0n ? 650_240n : 1_488_440n)),
    getBalance: call(() => ({ value: 400_000n })),
    getRecentPrioritizationFees: call(() => {
      if (opts.feeLevels === 'fails') throw new Error('RPC unavailable');
      return (opts.feeLevels ?? []).map((prioritizationFee, i) => ({ slot: BigInt(i), prioritizationFee }));
    }),
    getEpochInfo: call(() => {
      if (opts.epochFails) throw new Error('RPC unavailable');
      return { epoch: 900n };
    }),
  } as unknown as SolanaRpc;
}

/** Answers like Jupiter for whatever is asked, with the floor and amounts an attacker chooses. */
export function fakeJupiter(answer: {
  threshold?: bigint; inAmountFactor?: bigint; failFirst?: number; extraAccounts?: readonly Address[];
  worseByBps?: bigint; hop?: { mint: Address; tokenProgram: Address }; label?: string; asked?: BuildParams[];
  /** The route's swap instruction names the Pump.fun curve program, as a real curve route does. */
  curveProgram?: boolean;
} = {}): JupiterClient {
  let calls = 0;
  return {
    async build(p: BuildParams): Promise<BuildResponse> {
      answer.asked?.push(p);
      if (calls++ < (answer.failFirst ?? 0)) throw new JupiterError('Jupiter 400: No matching liquidity', 400);
      const E = p.taker;
      const eIn = await ataOf(E, p.inputMint);
      const destination = p.destinationTokenAccount ?? (await ataOf(E, WSOL_MINT));
      const meta = (pubkey: string, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
      return {
        inputMint: p.inputMint,
        outputMint: p.outputMint,
        inAmount: (p.amount * (answer.inAmountFactor ?? 1n)).toString(),
        // The baseline is asked for without exclusions and a protected route with them, so this
        // is how a route that costs more than the open market is simulated.
        outAmount: (p.excludeDexes?.length ? (OUT * (10_000n - (answer.worseByBps ?? 0n))) / 10_000n : OUT).toString(),
        // Like Jupiter, the threshold is the quote less the slippage it was asked for.
        otherAmountThreshold: (answer.threshold ?? (OUT * BigInt(10_000 - p.slippageBps)) / 10_000n).toString(),
        routePlan: [{ percent: 100, swapInfo: { label: answer.label ?? 'Whirlpool', ammKey: POOL } }],
        computeBudgetInstructions: [],
        // Jupiter asks for an ATA of the taker for every token the route passes through. Bound
        // does not run these; it recreates the accounts itself and closes them again (D14).
        setupInstructions: answer.hop
          ? [{
            programId: ATA_PROGRAM,
            accounts: [
              meta(E, true, true), meta(await ataOf(E, answer.hop.mint, answer.hop.tokenProgram), false, true),
              meta(E), meta(answer.hop.mint), meta(SYSTEM_PROGRAM), meta(answer.hop.tokenProgram),
            ],
            data: b64(new Uint8Array([1])),
          }]
          : [],
        swapInstruction: {
          programId: JUPITER_PROGRAM,
          accounts: [
            meta(TOKEN_PROGRAM), meta(E, true), meta(eIn, false, true), meta(destination, false, true),
            meta(p.inputMint), meta(p.outputMint), meta(DEX), meta(POOL, false, true),
            // A large swap splits over many pools; enough of them and nothing fits in one transaction.
            ...(answer.extraAccounts ?? []).map(a => meta(a, false, true)),
            ...(answer.curveProgram ? [meta(PUMP)] : []),
          ],
          data: b64(new Uint8Array([229, 23, 203, 151, 122, 227, 173, 42, 1])),
        },
        cleanupInstruction: null,
        otherInstructions: [],
        addressesByLookupTableAddress: null,
      };
    },
    async searchTokens() {
      return [];
    },
    async programLabels() {
      return {};
    },
  };
}
