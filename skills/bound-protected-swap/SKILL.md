---
name: bound-protected-swap
description: Swap tokens on Solana through Bound's agent API, so the swap program can only touch the approved amount and a minimum output is enforced on chain. Use when an agent or bot needs to swap any Solana token (SOL, USDC, SPL, Token-2022, Pump.fun) from a wallet it controls and must not give the route authority over the rest of that wallet.
---

# Bound protected swap

Bound builds a swap in which Jupiter's route only ever holds a one-time key and a temporary account
with the approved amount. The wallet signs first, Bound signs last with the one-time key, and if
less than the minimum would arrive, the whole transaction reverts. Bound never holds the wallet's
key or its funds. Full reference: `AGENT-API.md` in the Bound repository.

## Setup

The user provides these; never ask for them in chat, and never print or log them:

- `BOUND_API_URL`: the Bound deployment, e.g. `https://bound.example`
- `BOUND_API_KEY`: `bnd_...`, sent as `Authorization: Bearer <key>`
- `SOLANA_RPC_URL`: the agent's own RPC, used to confirm (not Bound's)
- `BOUND_WALLET_KEYPAIR`: path to the wallet's keypair file. Load the key from the file in code;
  it must never appear in a prompt, a message, a log or a command line.

## The flow

`examples/swap.ts` implements all of it with `@solana/kit` only; prefer running or adapting it over
writing the flow from scratch.

1. **Prepare.** `POST {BOUND_API_URL}/api/v1/prepare` with
   `{ owner, inputMint, outputMint, amountIn, minOut? }`. All amounts are integer strings in base
   units (5 USDC is `"5000000"`; SOL is 9 decimals, mint `So11111111111111111111111111111111111111112`).
   `amountIn` includes Bound's 0.2% fee. Set `minOut` to the least output the user accepts.
2. **Check before signing** (`checkPrepared` in the example). Refuse to sign if any fails:
   - the transaction's message hashes (SHA-256) to `messageSha256`, and so does `certificate.messageSha256`;
   - its only signers are the owner and `temporaryAuthority`, and the fee payer is the owner;
   - `certificate.input.totalDebit` equals the `amountIn` you asked for, and the mints match;
   - `amounts.fee` is at most 0.2% of `amountIn` (or the limit the user set);
   - `amounts.minOut` is not below the user's `minOut`, and equals `certificate.output.minimumOutput`;
   - `costs.networkFeeLamports` is within the user's limit.
3. **Sign as the wallet only**: `partiallySignTransaction([wallet.keyPair], tx)`. Do not modify the
   transaction in any way; a changed message, including a removed fee, is refused at finalize.
4. **Finalize** within about a minute: `POST /api/v1/finalize` with `{ ticket, signedTransaction }`.
   Bound signs last and sends once, and returns `signature`, `status` and the fully signed
   `signedTransaction`.
5. **Confirm on your own RPC.** For `status` `sent` or `unknown`, poll `getSignatureStatuses` and
   re-broadcast `signedTransaction` every few seconds until it is confirmed or the block height
   passes `lastValidBlockHeight` (re-broadcasting the same bytes is safe; it lands once). For
   `rejected`, it was never broadcast: prepare again.

## Handling errors

Errors are `{ "error": { "code", "message" } }`. Report `message` to the user as it is.

- `409 price-moved`: the market no longer meets `minOut`. `newMinOut` is what it supports now. Ask
  the user before preparing again with `minOut: newMinOut`; never lower a minimum on your own.
- `409 costs-more`: the protected route is `gapBps` below the open market. Ask the user; to accept,
  prepare again with `acceptCostBps: gapBps`.
- `503 busy` / `unavailable`, `429 rate-limited`: wait the `Retry-After` seconds, then retry. Do not
  retry in a tight loop.
- `410 expired`: the minute passed before finalize; prepare again.
- `503 paused`: Bound has paused swaps; the user's funds are not affected. Try later.
- `400 transaction-changed` / `wallet-changed-transaction`: the signed transaction differs from the
  one prepared, or the wallet's signature is missing. Sign exactly what prepare returned.
- `422` (`unsupported-token`, `no-route`, `insufficient-sol`, `simulation-failed`, ...): this swap
  cannot be built safely now; tell the user why, from `message`.

## Rules

- Never change a prepared transaction, never send one without finalize, and never finalize a ticket
  for a transaction you did not check.
- Never accept a lower minimum, a costlier route or a higher fee without the user's explicit yes.
- A swap is done only when confirmed on chain; `sent` is not done.
- Quote amounts to the user in whole tokens, converting from base units with the mint's decimals.

## Dry run

To see what a swap would cost without signing anything:

```bash
node examples/swap.ts --in <mint> --out <mint> --amount <base units> --owner <address> --dry-run
```
