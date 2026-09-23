/**
 * The second review's proofs of concept, as regression tests: the real pipeline (prepare → compile →
 * verify) runs against a fake RPC and a fake Jupiter that answer the way an attacker would.
 */
import { describe, expect, it } from 'vitest';
import {
  address, decompileTransactionMessage, generateKeyPairSigner, getAddressEncoder, getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import type { Address } from '@solana/kit';
import {
  ataOf, ATA_PROGRAM, JUPITER_PROGRAM, MAX_TAKER_RENT_LAMPORTS, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT,
} from '@bound/core';
import type { SolanaRpc } from '@bound/solana';
import { BoundError, DEFAULT_SETTINGS, prepareProtectedSwap, revertedOnPrice } from '../src/swap.ts';
import { JupiterError } from '../src/client.ts';
import type { BuildParams, BuildResponse, JupiterClient } from '../src/client.ts';

const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const BONK = address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
const DECIMALS: Record<string, number> = { [USDC]: 6, [WSOL_MINT]: 9, [BONK]: 5 };
const DEX = address('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const POOL = address('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ');
const OUT = 1_000_000_000n;
const PUMP = address('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const b64 = (d: Uint8Array) => Buffer.from(d).toString('base64');

type Account = { owner: Address; data: Uint8Array };

function mint(decimals: number): Account {
  const data = new Uint8Array(82);
  data[44] = decimals;
  return { owner: TOKEN_PROGRAM, data };
}

/** A Token-2022 mint that charges `bps` on every transfer, with no cap. */
function feeMint(decimals: number, bps: number): Account {
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
function hookMint(decimals: number, program: Address): Account {
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
function plain2022Mint(decimals: number): Account {
  const data = new Uint8Array(166);
  data[44] = decimals;
  data[165] = 1;
  return { owner: TOKEN_2022_PROGRAM, data };
}

function tokenAccount(owner: Address, mintAddress: Address, opts: { delegate?: boolean; memo?: boolean } = {}): Account {
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
function lamportsSentToTaker(wire: string): { taker: string; lamports: bigint; swapIndex: number } {
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

function fakeRpc(
  accounts: Map<string, Account>,
  opts: {
    feeFails?: boolean; epochFails?: boolean; takerRent?: bigint; priceMoves?: number; walletShort?: boolean;
    feeLevels?: bigint[] | 'fails'; simulations?: { count: number };
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
function fakeJupiter(answer: {
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

async function setup(output: Address, opts: { delegate?: boolean; wOutExists?: boolean; memo?: boolean } = {}) {
  const W = (await generateKeyPairSigner()).address;
  const accounts = new Map<string, Account>([
    [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
    [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [POOL, { owner: DEX, data: new Uint8Array(300) }],
  ]);
  if (output !== WSOL_MINT && (opts.wOutExists || opts.delegate || opts.memo)) {
    accounts.set(await ataOf(W, output), tokenAccount(W, output, { delegate: opts.delegate, memo: opts.memo }));
  }
  return { W, accounts };
}

const settings = { ...DEFAULT_SETTINGS, treasury: null, jupiterProgram: JUPITER_PROGRAM };

async function prepare(output: Address, opts: {
  jupiter?: JupiterClient; inputDecimals?: number; feeFails?: boolean; delegate?: boolean; wOutExists?: boolean;
  acceptedMinOut?: bigint; memo?: boolean; inputFeeBps?: number; epochFails?: boolean; acceptedCostBps?: bigint;
  chain?: Iterable<[string, Account]>; takerRent?: bigint; priceMoves?: number; walletShort?: boolean;
  input?: Address; treasury?: Address; amountIn?: bigint; feeLevels?: bigint[] | 'fails'; simulations?: { count: number };
  expectCurve?: boolean; version?: 0 | 1;
} = {}) {
  const { W, accounts } = await setup(output, opts);
  if (opts.inputFeeBps) accounts.set(USDC, feeMint(DECIMALS[USDC], opts.inputFeeBps));
  for (const [key, account] of opts.chain ?? []) accounts.set(key, account);
  return prepareProtectedSwap(
    {
      rpc: fakeRpc(accounts, {
        feeFails: opts.feeFails, epochFails: opts.epochFails, takerRent: opts.takerRent, priceMoves: opts.priceMoves,
        walletShort: opts.walletShort, feeLevels: opts.feeLevels, simulations: opts.simulations,
      }),
      jupiter: opts.jupiter ?? fakeJupiter(), settings: { ...settings, treasury: opts.treasury ?? null },
    },
    {
      owner: W, ephemeral: await generateKeyPairSigner(), inputMint: opts.input ?? USDC, outputMint: output,
      amountIn: opts.amountIn ?? 1_000_000n,
      inputDecimals: opts.inputDecimals ?? DECIMALS[opts.input ?? USDC], outputDecimals: DECIMALS[output], version: opts.version ?? 1,
      acceptedMinOut: opts.acceptedMinOut, acceptedCostBps: opts.acceptedCostBps, expectCurve: opts.expectCurve,
    },
  );
}

const codeOf = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof BoundError ? e.code : String(e)));

describe('C-01: the amount the user typed is converted with on-chain decimals', () => {
  it('an interface that used metadata decimals (9 for USDC) is refused before anything is built', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { inputDecimals: 9 }))).toBe('token-data-mismatch');
  });

  it('matching decimals build normally', async () => {
    expect((await prepare(WSOL_MINT)).policy.inputDecimals).toBe(6);
  });
});

describe('the prepared swap carries its certificate and timings (ideas 35, 20)', () => {
  it('the certificate states the approved debit and the enforced minimum of this exact transaction', async () => {
    const prepared = await prepare(WSOL_MINT);
    const c = prepared.certificate;
    expect(c.input.totalDebit).toBe(prepared.policy.amountIn);
    expect(c.output.minimumOutput).toBe(prepared.policy.minOut);
    expect(c.messageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.timings.localMs).toBeLessThanOrEqual(prepared.timings.totalMs);
  });
});

describe('C-02: Bound computes the minimum itself', () => {
  it('a Jupiter floor of 1 is replaced by the quote less the accepted slippage', async () => {
    const prepared = await prepare(WSOL_MINT, { jupiter: fakeJupiter({ threshold: 1n }) });
    expect(prepared.policy.minOut).toBe((OUT * BigInt(10_000 - settings.slippageBps)) / 10_000n);
    expect(prepared.quote.minOut).toBe(prepared.policy.minOut);
  });

  it('a stricter Jupiter floor is kept', async () => {
    const prepared = await prepare(WSOL_MINT, { jupiter: fakeJupiter({ threshold: OUT - 1n }) });
    expect(prepared.policy.minOut).toBe(OUT - 1n);
  });

  it('the minimum the user accepted is enforced when it is stricter than the route floor', async () => {
    const accepted = OUT - 1_000n; // between the route floor and the quoted output
    expect((await prepare(WSOL_MINT, { acceptedMinOut: accepted })).policy.minOut).toBe(accepted);
  });

  it('when the route can no longer deliver the accepted minimum, the user is asked again', async () => {
    const error = await prepare(WSOL_MINT, { acceptedMinOut: OUT + 1n }).then(() => null, (e: unknown) => e as BoundError);
    expect(error?.code).toBe('price-moved');
    expect(error?.priceMoved?.newMinOut).toBe((OUT * BigInt(10_000 - settings.slippageBps)) / 10_000n);
  });

  it('an answer for a different amount is not a quote for this swap', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: fakeJupiter({ inAmountFactor: 1_000n }) }))).toBe('bad-quote');
  });

  it('a route priced right but too big is reported as not fitting, not as a bad quote', async () => {
    const extra = await Promise.all(Array.from({ length: 60 }, () => generateKeyPairSigner()));
    const error = await prepare(WSOL_MINT, { jupiter: fakeJupiter({ extraAccounts: extra.map(s => s.address) }) })
      .then(() => null, (e: unknown) => e as BoundError);
    expect(error?.code).toBe('no-route');
    expect(error?.message).toMatch(/does not fit in a single protected transaction/);
  });
});

describe('a protected route that costs more than the open market', () => {
  it('is put to the user, never refused on their behalf', async () => {
    const error = await prepare(WSOL_MINT, { jupiter: fakeJupiter({ worseByBps: 1_000n }) })
      .then(() => null, (e: unknown) => e as BoundError);
    expect(error?.code).toBe('costs-more');
    expect(Number(error?.costsMore?.gapBps)).toBeGreaterThanOrEqual(1_000);
  });

  it('is built once the user has accepted that cost', async () => {
    const prepared = await prepare(WSOL_MINT, { jupiter: fakeJupiter({ worseByBps: 1_000n }), acceptedCostBps: 1_000n });
    expect(prepared.quote.gapBps).toBe(1_000n);
  });

  it('is still put to the user well past the warning threshold', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: fakeJupiter({ worseByBps: 3_000n }) }))).toBe('costs-more');
  });

  it('is asked about from 0.5% below the market, and goes through silently below that', async () => {
    expect(settings.askAboveBps).toBe(50n);
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: fakeJupiter({ worseByBps: 70n }) }))).toBe('costs-more');
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: fakeJupiter({ worseByBps: 30n }) }))).toBe('ok');
  });

  it('is refused only when the answer is no longer a price at all', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: fakeJupiter({ worseByBps: 6_000n }) }))).toBe('bad-quote');
  });
});

describe('a token that taxes its own transfers', () => {
  it('is swappable: the route is quoted for what arrives, and the withheld fees are harvested', async () => {
    const prepared = await prepare(WSOL_MINT, { inputFeeBps: 300 });
    // These tests run without a treasury, so Bound takes no fee; the token keeps 3% on the way in.
    const swapAmount = 1_000_000n;
    const tax = (swapAmount * 300n + 9_999n) / 10_000n;
    expect(prepared.policy.swapAmount).toBe(swapAmount);
    expect(prepared.policy.inputTransferFee).toBe(true);
    expect(prepared.quote.inAmount).toBe(swapAmount - tax);
    expect(prepared.tokenTax).toEqual({ inputBps: 300, extraOnInput: tax });
  });

  it('its transaction harvests the withheld amount before closing the temporary account', async () => {
    const prepared = await prepare(WSOL_MINT, { inputFeeBps: 300 });
    const compiled = getCompiledTransactionMessageDecoder().decode(prepared.transaction.messageBytes);
    const message = decompileTransactionMessage(compiled as never, { addressesByLookupTableAddress: {} });
    const ixs = message.instructions as readonly { data?: ArrayLike<number> }[];
    const harvest = ixs.findIndex(i => i.data?.[0] === 26 && i.data?.[1] === 4);
    const close = ixs.findIndex(i => i.data?.length === 1 && i.data?.[0] === 9);
    expect(harvest).toBeGreaterThan(-1);
    expect(harvest).toBeLessThan(close);
  });

  it('without the epoch the tax cannot be priced, so nothing is built', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { inputFeeBps: 300, epochFails: true }))).toBe('token-data-mismatch');
  });

  it('a token that charges nothing needs no epoch at all', async () => {
    const prepared = await prepare(WSOL_MINT, { epochFails: true });
    expect(prepared.tokenTax).toBe(null);
  });

  it('a token with no tax neither harvests nor reports one', async () => {
    const prepared = await prepare(WSOL_MINT);
    expect(prepared.tokenTax).toBe(null);
    expect(prepared.policy.inputTransferFee).toBe(false);
  });
});

describe('Token-2022 accounts', () => {
  it('an output account that requires a memo on every transfer is refused before anything is built', async () => {
    expect(await codeOf(prepare(BONK, { memo: true }))).toBe('output-account-restricted');
  });
});

describe('transient Jupiter refusals', () => {
  it('"No matching liquidity" on the first quotes does not end the swap', async () => {
    const prepared = await prepare(WSOL_MINT, { jupiter: fakeJupiter({ failFirst: 2 }) });
    expect(prepared.quote.outAmount).toBe(OUT);
  });
});

describe('B-12: the network fee check fails closed', () => {
  it('without a price from the cluster, nothing goes to the wallet', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { feeFails: true }))).toBe('verification-failed');
  });

  it('the exact fee is returned for display', async () => {
    expect((await prepare(WSOL_MINT)).networkFeeLamports).toBe(15_000n);
  });
});

describe('C-09 and Revoke: costs and side effects are reported from the chain', () => {
  it('a new output account costs the rent the cluster quotes today', async () => {
    expect((await prepare(BONK)).oneTimeCosts.outputAccountRent).toBe(1_488_440n);
    expect((await prepare(BONK, { wOutExists: true })).oneTimeCosts.outputAccountRent).toBe(0n);
  });

  it('removing an existing delegate on the output account is disclosed', async () => {
    expect((await prepare(BONK, { delegate: true })).notices.removesDelegate).toBe(true);
    expect((await prepare(BONK, { wOutExists: true })).notices.removesDelegate).toBe(false);
  });
});

describe('the mints a route passes through are screened like its own two', () => {
  const HOP = address('HoPP1ng1111111111111111111111111111111111111');
  const HOOK = address('Hook1111111111111111111111111111111111111111');

  it('a hop through a token that runs a transfer hook is refused, and nothing is built', async () => {
    const code = await codeOf(prepare(BONK, {
      jupiter: fakeJupiter({ hop: { mint: HOP, tokenProgram: TOKEN_2022_PROGRAM } }),
      chain: [[HOP, hookMint(6, HOOK)]],
    }));
    expect(code).toBe('unsupported-token');
  });

  it('says which extension it was, so the refusal is not a shrug', async () => {
    await expect(prepare(BONK, {
      jupiter: fakeJupiter({ hop: { mint: HOP, tokenProgram: TOKEN_2022_PROGRAM } }),
      chain: [[HOP, hookMint(6, HOOK)]],
    })).rejects.toThrow(/transfer hook/);
  });

  it('a hop through a Token-2022 mint with no extensions builds normally', async () => {
    const prepared = await prepare(BONK, {
      jupiter: fakeJupiter({ hop: { mint: HOP, tokenProgram: TOKEN_2022_PROGRAM } }),
      chain: [[HOP, plain2022Mint(6)]],
    });
    expect(prepared.intermediates.map(x => x.mint)).toEqual([HOP]);
    expect(prepared.certificate.otherTokenDebit).toBe(0);
  });

  it('a hop that charges a transfer fee is still allowed, because the compiler harvests it', async () => {
    const prepared = await prepare(BONK, {
      jupiter: fakeJupiter({ hop: { mint: HOP, tokenProgram: TOKEN_2022_PROGRAM } }),
      chain: [[HOP, feeMint(6, 50)]],
    });
    expect(prepared.intermediates).toEqual([expect.objectContaining({ mint: HOP, transferFee: true })]);
  });
});

describe('a price that moves between the quote and the simulation', () => {
  it('is quoted again, and the market is not left out for it', async () => {
    const prepared = await prepare(BONK, { priceMoves: 1 });
    expect(prepared.attempts[0].simulation).toBe('output below the minimum');
    expect(prepared.attempts.at(-1)!.excluded).not.toContain('Whirlpool');
  });

  it('that keeps moving is reported as a price move, not as a broken market', async () => {
    const failure = await prepare(BONK, { priceMoves: 10 }).catch((e: BoundError) => e);
    expect(failure).toBeInstanceOf(BoundError);
    expect((failure as BoundError).code).toBe('simulation-failed');
    expect((failure as BoundError).message).toContain('price moved');
  });
});

describe("a route that opens an account in the taker's name (PumpSwap, the Pump.fun bonding curve)", () => {
  const RENT = 1_346_200n;

  it('the temporary key is sent exactly the rent the route spends, and nothing more', async () => {
    const prepared = await prepare(BONK, { takerRent: RENT });
    expect(prepared.policy.takerRent).toBe(RENT);
    expect(prepared.oneTimeCosts.routeRent).toBe(RENT);
    expect(prepared.certificate.routeRentLamports).toBe(RENT);
  });

  it('the same for a swap into SOL and a swap from SOL', async () => {
    expect((await prepare(WSOL_MINT, { takerRent: RENT })).policy.takerRent).toBe(RENT);
  });

  it('a route that needs no rent sends the temporary key none', async () => {
    const prepared = await prepare(BONK);
    expect(prepared.policy.takerRent).toBe(0n);
    expect(prepared.oneTimeCosts.routeRent).toBe(0n);
  });

  it('a route that wants more than the ceiling is not paying rent but spending, and is not funded', async () => {
    const code = await codeOf(prepare(BONK, { takerRent: MAX_TAKER_RENT_LAMPORTS + 1n }));
    expect(code).not.toBe('ok');
  });

  it('when the funded route fails because the price moved, that is what is acted on: quote again, keep the market', async () => {
    const prepared = await prepare(BONK, { takerRent: RENT, priceMoves: 1 });
    expect(prepared.policy.takerRent).toBe(RENT);
    expect(prepared.attempts[0].simulation).toBe('output below the minimum');
    expect(prepared.attempts.at(-1)!.excluded).not.toContain('Whirlpool');
  });
});

describe('slippage on a Pump.fun bonding curve', () => {
  const floor = (bps: number) => (OUT * BigInt(10_000 - bps)) / 10_000n;
  const curve = (extra: Parameters<typeof fakeJupiter>[0] = {}) =>
    fakeJupiter({ label: 'Pump.fun', curveProgram: true, ...extra });
  const onChain: [string, Account][] = [[PUMP, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }]];

  it('a route through the bonding curve is enforced at 3% below the quote, by Bound and by Jupiter', async () => {
    const asked: BuildParams[] = [];
    const prepared = await prepare(BONK, { jupiter: curve({ asked }), chain: onChain });
    expect(settings.curveSlippageBps).toBe(300);
    expect(prepared.policy.minOut).toBe(floor(300));
    expect(prepared.certificate.output.minimumOutput).toBe(floor(300));
    // Asked at the usual tolerance first, then again at the curve's once it was seen to be one.
    expect(asked.some(p => p.slippageBps === 300 && p.excludeDexes?.length)).toBe(true);
  });

  it('every other route, PumpSwap included, is built at 0.5%, so Jupiter enforces 0.5% on chain too (BR-01)', async () => {
    for (const label of ['Whirlpool', 'Pump.fun Amm']) {
      const asked: BuildParams[] = [];
      const prepared = await prepare(BONK, { jupiter: fakeJupiter({ label, asked }) });
      expect(prepared.policy.minOut).toBe(floor(50));
      expect(asked.every(p => p.slippageBps === 50)).toBe(true);
    }
  });

  it('the label alone does not widen the tolerance: the curve program must be in the route (BR-04)', async () => {
    const asked: BuildParams[] = [];
    const prepared = await prepare(BONK, { jupiter: fakeJupiter({ label: 'Pump.fun', asked }) });
    expect(prepared.policy.minOut).toBe(floor(50));
    expect(asked.every(p => p.slippageBps === 50)).toBe(true);
  });

  it('a minimum the user accepted still wins on the bonding curve when it is stricter', async () => {
    const accepted = floor(100);
    const prepared = await prepare(BONK, { jupiter: curve(), chain: onChain, acceptedMinOut: accepted });
    expect(prepared.policy.minOut).toBe(accepted);
  });
});

describe('a wallet short of SOL (review BR-10)', () => {
  it('is told how much SOL the swap needs, and no market is blamed for it', async () => {
    const failure = await prepare(BONK, { walletShort: true }).catch((e: BoundError) => e);
    expect(failure).toBeInstanceOf(BoundError);
    expect((failure as BoundError).code).toBe('insufficient-sol');
    expect((failure as BoundError).message).toMatch(/needs about \d+\.\d{4} SOL/);
    expect((failure as BoundError).message).toContain('Your wallet has 0.0004 SOL');
  });

  it("a route short of the taker's rent is still measured and funded, not reported as the wallet's", async () => {
    const prepared = await prepare(BONK, { takerRent: 1_346_200n });
    expect(prepared.policy.takerRent).toBe(1_346_200n);
  });
});

describe('a SOL fee into a treasury wallet that does not exist yet (review BR-06)', () => {
  const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

  it('is fee-free while the fee is below the rent minimum, instead of reverting', async () => {
    const prepared = await prepare(BONK, { input: WSOL_MINT, treasury: TREASURY, amountIn: 100_000_000n });
    expect(prepared.policy.fee).toBe(0n);
    expect(prepared.policy.treasury).toBeNull();
  });

  it('charges the fee once the treasury wallet exists', async () => {
    const funded: [string, Account] = [TREASURY, { owner: SYSTEM_PROGRAM, data: new Uint8Array(0) }];
    const prepared = await prepare(BONK, { input: WSOL_MINT, treasury: TREASURY, amountIn: 100_000_000n, chain: [funded] });
    expect(prepared.policy.fee).toBe((100_000_000n * settings.feeBps) / 10_000n);
    expect(prepared.policy.treasury).toBe(TREASURY);
  });
});

describe('latency without weaker protection', () => {
  const floor = (bps: number) => (OUT * BigInt(10_000 - bps)) / 10_000n;
  const onChain: [string, Account][] = [[PUMP, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }]];

  it('a page that already saw a curve route asks Jupiter at 3% once, not twice', async () => {
    const asked: BuildParams[] = [];
    const prepared = await prepare(BONK, {
      jupiter: fakeJupiter({ label: 'Pump.fun', curveProgram: true, asked }), chain: onChain, expectCurve: true,
    });
    expect(prepared.policy.minOut).toBe(floor(300));
    expect(asked.every(p => p.slippageBps === 300)).toBe(true);
  });

  it('a wrong curve hint still builds an ordinary route at 0.5% (BR-01 holds)', async () => {
    const asked: BuildParams[] = [];
    const prepared = await prepare(BONK, { jupiter: fakeJupiter({ asked }), expectCurve: true });
    expect(prepared.policy.minOut).toBe(floor(50));
    expect(asked.some(p => p.slippageBps === 50 && p.excludeDexes?.length)).toBe(true);
  });

  it('a Pump.fun route goes straight to measuring its rent: two simulations, not three', async () => {
    const simulations = { count: 0 };
    const prepared = await prepare(BONK, {
      jupiter: fakeJupiter({ label: 'Pump.fun', curveProgram: true }), chain: onChain, takerRent: 1_346_200n, simulations,
    });
    expect(prepared.policy.takerRent).toBe(1_346_200n);
    expect(simulations.count).toBe(2);
  });

  it('the priority fee follows recent fees on the pools, never below the default', async () => {
    const busy = await prepare(BONK, { feeLevels: [1_000n, 2_000n, 300_000n, 400_000n] });
    const quiet = await prepare(BONK, { feeLevels: [1n, 2n] });
    const unknown = await prepare(BONK, { feeLevels: 'fails' });
    expect(busy.priorityFeeLamports).toBeGreaterThan(quiet.priorityFeeLamports);
    expect(quiet.priorityFeeLamports).toBe(unknown.priorityFeeLamports);
  });

  it('a runaway fee level is capped so the whole fee stays within R4', async () => {
    const prepared = await prepare(BONK, { feeLevels: [10n ** 15n] });
    expect(prepared.priorityFeeLamports + 10_000n).toBeLessThanOrEqual(settings.maxNetworkFeeLamports);
  });
});

describe('a Jupiter that is overloaded or silent', () => {
  /** Jupiter answers the unrestricted baseline, and `status` for every protected route (or for all). */
  const refusing = (status: number, message: string, baselineToo = true): JupiterClient => {
    const honest = fakeJupiter();
    return {
      ...honest,
      async build(p) {
        if (baselineToo || p.excludeDexes?.length) throw new JupiterError(`Jupiter ${status}: ${message}`, status);
        return honest.build(p);
      },
    };
  };

  it('a 429 is reported as busy, never as "no route fits, try another token"', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: refusing(429, 'Too many requests') }))).toBe('busy');
  });

  it('the same when only the protected routes are refused', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: refusing(429, 'Too many requests', false) }))).toBe('busy');
  });

  it('a Jupiter that does not answer is unavailable, not a broken market', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: refusing(504, '{"error":"Jupiter did not answer"}') }))).toBe('unavailable');
  });

  it("the kill switch's own answer is passed on as it is", async () => {
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: refusing(503, '{"error":"Protected swaps are paused"}') }))).toMatch(/paused/);
  });
});

describe('a swap that landed and reverted: was it the price?', () => {
  for (const version of [0, 1] as const) it(`v${version}: Jupiter's own threshold (6001) and Bound's minimum check are the price; anything else is not`, async () => {
    const prepared = await prepare(BONK, { version });
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(prepared.transaction.messageBytes) as never);
    const instructions = message.instructions as unknown as { programAddress: string; accounts?: { address: string }[]; data?: Uint8Array }[];
    const swap = instructions.findIndex(ix => ix.programAddress === JUPITER_PROGRAM);
    const floor = instructions.findIndex(ix =>
      ix.programAddress === TOKEN_PROGRAM && ix.data?.[0] === 12 && ix.accounts?.[0].address === ix.accounts?.[2].address);
    expect(swap).toBeGreaterThanOrEqual(0);
    expect(floor).toBeGreaterThan(swap);
    const tx = prepared.transaction;
    const onPrice = (err: unknown) => revertedOnPrice(tx, err, JUPITER_PROGRAM);
    expect(onPrice({ InstructionError: [swap, { Custom: 6001 }] })).toBe(true);
    // As the send path records it: JSON, with the chain's integers as strings.
    expect(onPrice(JSON.stringify({ InstructionError: [String(swap), { Custom: '6001' }] }))).toBe(true);
    expect(onPrice({ InstructionError: [floor, { Custom: 1 }] })).toBe(true);
    expect(onPrice({ InstructionError: [swap, { Custom: 6000 }] })).toBe(false);
    expect(onPrice({ InstructionError: [floor, { Custom: 17 }] })).toBe(false); // a frozen account
    expect(onPrice({ InstructionError: [0, { Custom: 6001 }] })).toBe(false);
    expect(onPrice('InsufficientFundsForFee')).toBe(false);
  });
});
