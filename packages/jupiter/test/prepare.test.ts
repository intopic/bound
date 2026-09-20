/**
 * The second review's proofs of concept, as regression tests: the real pipeline (prepare → compile →
 * verify) runs against a fake RPC and a fake Jupiter that answer the way an attacker would.
 */
import { describe, expect, it } from 'vitest';
import {
  address, decompileTransactionMessage, generateKeyPairSigner, getAddressEncoder, getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import type { Address } from '@solana/kit';
import { ataOf, JUPITER_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from '@bound/core';
import type { SolanaRpc } from '@bound/solana';
import { BoundError, DEFAULT_SETTINGS, prepareProtectedSwap } from '../src/swap.ts';
import { JupiterError } from '../src/client.ts';
import type { BuildParams, BuildResponse, JupiterClient } from '../src/client.ts';

const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const BONK = address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
const DECIMALS: Record<string, number> = { [USDC]: 6, [WSOL_MINT]: 9, [BONK]: 5 };
const DEX = address('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const POOL = address('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ');
const OUT = 1_000_000_000n;
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
  }
  return { owner: TOKEN_PROGRAM, data };
}

function fakeRpc(accounts: Map<string, Account>, opts: { feeFails?: boolean; epochFails?: boolean } = {}): SolanaRpc {
  const call = (fn: (...a: never[]) => unknown) => (...a: never[]) => ({ send: async () => fn(...a) });
  return {
    getMultipleAccounts: call((addresses: string[]) => ({
      context: { slot: 300_000_000n },
      value: addresses.map(a => {
        const acc = accounts.get(a);
        return acc ? { owner: acc.owner, lamports: 2_000_000n, data: [b64(acc.data), 'base64'], executable: false, space: BigInt(acc.data.length) } : null;
      }),
    })),
    getLatestBlockhash: call(() => ({ value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1_000n } })),
    simulateTransaction: call(() => ({ value: { err: null, logs: [], unitsConsumed: 200_000n } })),
    getFeeForMessage: call(() => {
      if (opts.feeFails) throw new Error('RPC unavailable');
      return { value: 15_000n };
    }),
    getMinimumBalanceForRentExemption: call(() => 1_488_440n),
    getEpochInfo: call(() => {
      if (opts.epochFails) throw new Error('RPC unavailable');
      return { epoch: 900n };
    }),
  } as unknown as SolanaRpc;
}

/** Answers like Jupiter for whatever is asked, with the floor and amounts an attacker chooses. */
function fakeJupiter(answer: { threshold?: bigint; inAmountFactor?: bigint; failFirst?: number; extraAccounts?: readonly Address[]; worseByBps?: bigint } = {}): JupiterClient {
  let calls = 0;
  return {
    async build(p: BuildParams): Promise<BuildResponse> {
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
        otherAmountThreshold: (answer.threshold ?? (OUT * 9_950n) / 10_000n).toString(),
        routePlan: [{ percent: 100, swapInfo: { label: 'Whirlpool', ammKey: POOL } }],
        computeBudgetInstructions: [],
        setupInstructions: [],
        swapInstruction: {
          programId: JUPITER_PROGRAM,
          accounts: [
            meta(TOKEN_PROGRAM), meta(E, true), meta(eIn, false, true), meta(destination, false, true),
            meta(p.inputMint), meta(p.outputMint), meta(DEX), meta(POOL, false, true),
            // A large swap splits over many pools; enough of them and nothing fits in one transaction.
            ...(answer.extraAccounts ?? []).map(a => meta(a, false, true)),
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
} = {}) {
  const { W, accounts } = await setup(output, opts);
  if (opts.inputFeeBps) accounts.set(USDC, feeMint(DECIMALS[USDC], opts.inputFeeBps));
  return prepareProtectedSwap(
    { rpc: fakeRpc(accounts, { feeFails: opts.feeFails, epochFails: opts.epochFails }), jupiter: opts.jupiter ?? fakeJupiter(), settings },
    {
      owner: W, ephemeral: await generateKeyPairSigner(), inputMint: USDC, outputMint: output, amountIn: 1_000_000n,
      inputDecimals: opts.inputDecimals ?? DECIMALS[USDC], outputDecimals: DECIMALS[output], version: 1,
      acceptedMinOut: opts.acceptedMinOut, acceptedCostBps: opts.acceptedCostBps,
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
