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

import {
  b64, BONK, DECIMALS, DEX, fakeJupiter, fakeRpc, feeMint, fundedAccounts, hookMint, lamportsSentToTaker, mint, OUT, plain2022Mint, POOL, PUMP,
  tokenAccount, USDC,
} from './fakes.ts';
import type { Account } from './fakes.ts';

async function setup(output: Address, opts: { delegate?: boolean; wOutExists?: boolean; memo?: boolean; frozenWOut?: boolean } = {}) {
  const W = (await generateKeyPairSigner()).address;
  const accounts = new Map<string, Account>([
    [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
    [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [POOL, { owner: DEX, data: new Uint8Array(300) }],
  ]);
  if (output !== WSOL_MINT && (opts.wOutExists || opts.delegate || opts.memo || opts.frozenWOut)) {
    accounts.set(await ataOf(W, output), tokenAccount(W, output, { delegate: opts.delegate, memo: opts.memo, frozen: opts.frozenWOut }));
  }
  return { W, accounts };
}

const settings = { ...DEFAULT_SETTINGS, treasury: null, jupiterProgram: JUPITER_PROGRAM };

async function prepare(output: Address, opts: {
  jupiter?: JupiterClient; inputDecimals?: number; feeFails?: boolean; delegate?: boolean; wOutExists?: boolean;
  acceptedMinOut?: bigint; memo?: boolean; inputFeeBps?: number; epochFails?: boolean; acceptedCostBps?: bigint;
  chain?: Iterable<[string, Account]>; takerRent?: bigint; priceMoves?: number; walletShort?: boolean;
  input?: Address; treasury?: Address; amountIn?: bigint; feeLevels?: bigint[] | 'fails'; simulations?: { count: number };
  expectCurve?: boolean; version?: 0 | 1; frozenWOut?: boolean; cashback?: bigint; pumpSlippage?: number;
  wIn?: { amount?: bigint; frozen?: boolean }; failBeforeSwap?: boolean;
} = {}) {
  const { W, accounts } = await setup(output, opts);
  // The wallet holds the input token, unless a test says otherwise through `chain`.
  if ((opts.input ?? USDC) !== WSOL_MINT) for (const [key, account] of await fundedAccounts(W, opts.input ?? USDC, opts.wIn)) accounts.set(key, account);
  if (opts.inputFeeBps) accounts.set(USDC, feeMint(DECIMALS[USDC], opts.inputFeeBps));
  for (const [key, account] of opts.chain ?? []) accounts.set(key, account);
  return prepareProtectedSwap(
    {
      rpc: fakeRpc(accounts, {
        feeFails: opts.feeFails, epochFails: opts.epochFails, takerRent: opts.takerRent, priceMoves: opts.priceMoves,
        walletShort: opts.walletShort, feeLevels: opts.feeLevels, simulations: opts.simulations, cashback: opts.cashback,
        pumpSlippage: opts.pumpSlippage, failBeforeSwap: opts.failBeforeSwap,
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

  it("so is a refusal on price by a Pump.fun market inside the route: the curve is not left out (research audit)", async () => {
    const prepared = await prepare(BONK, { pumpSlippage: 1, jupiter: fakeJupiter({ label: 'Pump.fun', curveProgram: true }), expectCurve: true });
    expect(prepared.attempts[0].simulation).toBe('output below the minimum');
    expect(prepared.attempts.at(-1)!.excluded).not.toContain('Pump.fun');
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
    // Said before signing: the swap may land late or expire (review FA-15).
    expect(prepared.priorityFeeCapped).toBe(true);
    expect((await prepare(BONK, { feeLevels: [60_000n] })).priorityFeeCapped).toBe(false);
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

  it("a refused key or a path that is gone is Bound's to fix, not a missing route (research audit F-08)", async () => {
    for (const status of [401, 403, 404, 410]) {
      expect(await codeOf(prepare(WSOL_MINT, { jupiter: refusing(status, 'Unauthorized') }))).toBe('unavailable');
    }
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: refusing(400, '{"error":"No routes found"}') }))).toBe('no-route');
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

describe('accounts frozen by the token issuer (review FA-12)', () => {
  const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

  it("a frozen fee account makes the swap fee-free instead of impossible (a stablecoin's blacklist, say)", async () => {
    const feeAccount = await ataOf(TREASURY, USDC);
    const frozen = await prepare(WSOL_MINT, { treasury: TREASURY, chain: [[feeAccount, tokenAccount(TREASURY, USDC, { frozen: true })]] });
    expect(frozen.policy.fee).toBe(0n);
    const open = await prepare(WSOL_MINT, { treasury: TREASURY, chain: [[feeAccount, tokenAccount(TREASURY, USDC)]] });
    expect(open.policy.fee).toBeGreaterThan(0n);
  });

  it('a frozen output account is refused with its real reason, not as a failed route', async () => {
    const error = await prepare(BONK, { frozenWOut: true }).then(() => null, (e: unknown) => e as BoundError);
    expect(error?.code).toBe('output-account-restricted');
    expect(error?.message).toContain('frozen');
  });
});

describe("Pump's per-buyer account under E is closed after the swap and its rent returned (review FA-05)", () => {
  const curve = () => fakeJupiter({ label: 'Pump.fun', curveProgram: true, routeAccount: true });

  it('the rent the market takes comes back to the wallet in the same transaction', async () => {
    const prepared = await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, jupiter: curve(), takerRent: 1_346_200n, expectCurve: true });
    expect(prepared.policy.takerRent).toBe(1_346_200n);
    expect(prepared.policy.routeRefund).toBe(1_346_200n);
    expect(prepared.oneTimeCosts.routeRefund).toBe(1_346_200n);
    // The close and the transfer to W are the last two instructions, and the verifier passed them.
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(prepared.transaction.messageBytes) as never);
    const [close, refund] = message.instructions.slice(-2);
    expect(close.programAddress).toBe(PUMP);
    expect(refund.programAddress).toBe(SYSTEM_PROGRAM);
    expect(refund.accounts?.[1].address).toBe(prepared.policy.owner);
    expect(prepared.certificate.routeRefundLamports).toBe(1_346_200n);
  });

  it('one more simulation than before, to check E ends with nothing', async () => {
    const simulations = { count: 0 };
    await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, jupiter: curve(), takerRent: 1_346_200n, expectCurve: true, simulations });
    expect(simulations.count).toBe(3);
  });

  it('a route that opens no such account returns nothing and adds nothing', async () => {
    const prepared = await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, takerRent: 1_346_200n, jupiter: fakeJupiter({ label: 'Pump.fun Amm' }) });
    expect(prepared.policy.routeRefund).toBe(0n);
    expect(prepared.oneTimeCosts.routeRefund).toBe(0n);
  });

  it("a cashback coin's account holds more than its rent: it is left alone, so the swap cannot revert on the refund (F-03)", async () => {
    const simulations = { count: 0 };
    const prepared = await prepare(BONK, {
      input: WSOL_MINT, amountIn: 100_000_000n, jupiter: curve(), takerRent: 1_346_200n, expectCurve: true, cashback: 1_234n, simulations,
    });
    expect(prepared.policy.takerRent).toBe(1_346_200n);
    expect(prepared.policy.routeRefund).toBe(0n);
    expect(prepared.oneTimeCosts.routeRefund).toBe(0n);
    // No simulation with the close either: nothing was tried that could fail.
    expect(simulations.count).toBe(2);
  });

  it('a route that fits only without the close is built without it, never sent to the RPC oversized', async () => {
    // Pad a curve route until the close no longer fits in v0: the swap is built as before FA-05.
    let droppedForSize = 0;
    for (let n = 0; n <= 20; n++) {
      const extraAccounts = await Promise.all(Array.from({ length: n }, async () => (await generateKeyPairSigner()).address));
      const jupiter = fakeJupiter({ label: 'Pump.fun', curveProgram: true, routeAccount: true, extraAccounts });
      const outcome = await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, jupiter, takerRent: 1_346_200n, expectCurve: true, version: 0 })
        .then(p => ({ p, code: 'ok' }), (e: unknown) => ({ p: null, code: e instanceof BoundError ? e.code : String(e) }));
      // Never the RPC's raw refusal of an oversized transaction: a route that no longer fits with
      // its rent is a route that does not fit, and the pipeline says so in its own words.
      expect(['ok', 'no-route', 'simulation-failed'], `${n} extra accounts: ${outcome.code}`).toContain(outcome.code);
      if (outcome.p && outcome.p.policy.takerRent > 0n && outcome.p.policy.routeRefund === 0n) droppedForSize++;
    }
    expect(droppedForSize).toBeGreaterThan(0);
  });

  it('without rent to pay there is no account to close', async () => {
    const prepared = await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, jupiter: curve(), expectCurve: true });
    expect(prepared.policy.routeRefund).toBe(0n);
  });
});

describe('the reason is named, not blamed on the market (research audit)', () => {
  it('a Jupiter instruction of a new format is a format change, not a bad price (F-07)', async () => {
    const failure = await prepare(BONK, { jupiter: fakeJupiter({ unknownFormat: true }) }).catch((e: BoundError) => e);
    expect((failure as BoundError).code).toBe('route-format');
    expect((failure as BoundError).message).toContain("can't read yet");
  });

  it("an input account frozen by the token's issuer is refused before anything is quoted (F-09)", async () => {
    const failure = await prepare(BONK, { wIn: { frozen: true } }).catch((e: BoundError) => e);
    expect((failure as BoundError).code).toBe('input-account-restricted');
  });

  it('an input balance short of the amount is named, with the numbers the user typed (F-09)', async () => {
    const failure = await prepare(BONK, { wIn: { amount: 250_000n }, amountIn: 1_000_000n }).catch((e: BoundError) => e);
    expect((failure as BoundError).code).toBe('insufficient-balance');
    expect((failure as BoundError).message).toContain('holds 0.25 of the input token, less than the 1 this swap needs');
  });

  it("a failure in Bound's own steps before the swap stops at once, without blaming a market (F-09)", async () => {
    const simulations = { count: 0 };
    const failure = await prepare(BONK, { failBeforeSwap: true, simulations }).catch((e: BoundError) => e);
    expect((failure as BoundError).code).toBe('simulation-failed');
    expect((failure as BoundError).message).toContain('before it reaches the market');
    expect(simulations.count).toBe(1);
  });
});
