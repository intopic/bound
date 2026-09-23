# Bound agent API

Protected swaps on Solana for bots and AI agents. Your wallet signs a swap in which the swap program
(Jupiter's route) only ever holds a one-time key and a temporary account with the amount you
approved. It cannot touch anything else in the wallet, and if less than your minimum would arrive,
the whole transaction reverts.

Two calls. Bound builds and verifies the transaction; your wallet signs it first; Bound signs last,
with the one-time key, and sends it. Bound never holds your key or your funds.

For coding agents there is a skill, `skills/bound-protected-swap/` (`SKILL.md` and a working
example, `examples/swap.ts`, that needs only `@solana/kit`):

```bash
npx skills add intopic/bound --skill bound-protected-swap
```

```
POST /api/v1/prepare    → an unsigned transaction and a ticket
   (you sign the transaction as your wallet)
POST /api/v1/finalize   → Bound signs last and sends it once
```

## Authentication

Every request carries an API key:

```
Authorization: Bearer bnd_...
```

Requests are limited per key (60 per minute per endpoint by default). A `429` means wait and retry.

## Fee

0.2% of the input amount, in the input token, inside the transaction. It is part of the message you
sign, and Bound signs only the exact message it built, so a transaction with the fee removed is not
signed. The fee is shown in `amounts.fee` before you sign; the verifier refuses anything above 1%.
When the treasury has no account for the input token, the swap is fee-free.

## 1. Prepare

```http
POST /api/v1/prepare
Content-Type: application/json
Authorization: Bearer bnd_...

{
  "owner": "<your wallet address>",
  "inputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "outputMint": "So11111111111111111111111111111111111111112",
  "amountIn": "5000000",
  "minOut": "42500000"
}
```

| Field | | |
| --- | --- | --- |
| `owner` | required | The wallet that pays and receives. It signs first. |
| `inputMint`, `outputMint` | required | Mint addresses. SOL is `So11111111111111111111111111111111111111112`. |
| `amountIn` | required | Base units, as a string (`"5000000"` is 5 USDC). The fee comes out of it. |
| `minOut` | optional | Your own floor, in base units of the output. Bound never enforces less than this. Without it, the floor is the route's quote less 0.5% (3% on a Pump.fun bonding curve). |
| `acceptCostBps` | optional | Accept a protected route this many bps below the open market (see `costs-more`). |
| `version` | optional | `0` (default). `1` only where the deployment enables it. |

`200` response:

```json
{
  "ticket": "eyJ2Ijox....",
  "transaction": "<base64, unsigned>",
  "messageSha256": "<hex>",
  "wallet": "<owner>",
  "temporaryAuthority": "<the one-time key E>",
  "lastValidBlockHeight": "312345678",
  "amounts": { "amountIn": "5000000", "fee": "10000", "feeBps": "20", "swapAmount": "4990000",
               "quotedOut": "42780667", "minOut": "42566764", "priceImpactPct": 0.0001 },
  "costs": { "networkFeeLamports": "124480", "outputAccountRentLamports": "0", "routeRentLamports": "0", "tokenTax": null },
  "notices": { "removesDelegate": false },
  "route": ["Kipseli", "AlphaQ"],
  "certificate": { "...": "what this exact transaction does, bound to messageSha256" },
  "policy": { "...": "the rules the transaction was verified against" }
}
```

All amounts are strings in base units. The transaction lives about a minute (until
`lastValidBlockHeight`); sign and finalize it promptly, or prepare again.

Before signing, check what matters to you: `amounts.amountIn`, `amounts.fee`, `amounts.minOut`,
that the transaction's message hashes to `messageSha256`, and that its only signers are your wallet
and `temporaryAuthority`. The `certificate` states the same for that exact message.

## 2. Sign as your wallet

Sign the transaction's message with the owner's key and leave the other signature empty. With
`@solana/kit`:

```ts
import { getTransactionDecoder, getTransactionEncoder, partiallySignTransaction } from '@solana/kit';

const tx = getTransactionDecoder().decode(Buffer.from(prepared.transaction, 'base64'));
const signed = await partiallySignTransaction([wallet.keyPair], tx);
const signedTransaction = Buffer.from(getTransactionEncoder().encode(signed)).toString('base64');
```

Do not change the message: any change, including removing the fee, makes finalize refuse it.

## 3. Finalize

```http
POST /api/v1/finalize
Content-Type: application/json
Authorization: Bearer bnd_...

{ "ticket": "eyJ2Ijox....", "signedTransaction": "<base64, signed by your wallet>" }
```

Bound checks that the message is byte for byte the one it built, that your wallet's signature is
valid, and that the transaction has not expired; then it signs as the one-time key and sends it
once.

```json
{
  "signature": "5h...",
  "status": "sent",
  "signedTransaction": "<base64, fully signed>",
  "lastValidBlockHeight": "312345678"
}
```

| `status` | Meaning |
| --- | --- |
| `sent` | The RPC accepted it. Confirm it on chain; re-broadcast `signedTransaction` until it confirms or `lastValidBlockHeight` passes. It can land only once. |
| `unknown` | The connection failed after the request left. It may have been forwarded: check the signature before doing anything else. |
| `rejected` | Provably never broadcast (`refusal`: `network` is the RPC's preflight, usually a price that moved). Prepare again. |

Finalizing the same ticket twice returns the same transaction and signature.

## Errors

Every error is `{ "error": { "code": "...", "message": "..." } }`, and nothing was signed by Bound or
sent unless the code says otherwise.

| HTTP | `code` | What to do |
| --- | --- | --- |
| 400 | `bad-request` | Fix the request; `message` says which field. |
| 400 | `invalid-ticket` | The ticket was not issued to this API key, or was altered. |
| 400 | `transaction-changed` | The message is not the one Bound built. Sign the transaction exactly as returned. |
| 400 | `wallet-changed-transaction` | Your wallet's signature is missing or does not match (`violations`). |
| 401 | `unauthorized` | Missing or unknown API key. |
| 404 | `not-enabled` | The deployment has no agent API. |
| 409 | `price-moved` | The market cannot meet your `minOut`. `newMinOut` is what it supports now: prepare again with it to accept, or not. |
| 409 | `costs-more` | The route that fits in one protected transaction is `gapBps` below the open market. Prepare again with `acceptCostBps` to accept. |
| 410 | `expired` | The transaction's lifetime passed before finalize. Prepare again. |
| 422 | `unsupported-token`, `no-route`, `bad-quote`, `insufficient-sol`, `simulation-failed`, `verification-failed`, `token-data-mismatch`, `output-account-restricted` | This swap cannot be built safely right now; `message` says why. |
| 429 | `rate-limited` | Too many requests for this key. Wait `Retry-After` seconds. |
| 503 | `busy`, `unavailable` | Jupiter or the network is overloaded or silent. Wait `Retry-After` seconds and retry. |
| 503 | `paused` | Bound has paused protected swaps. Your funds are not affected. |

## What Bound can and cannot do with your swap

- It cannot move your funds: it never has your key, and after your wallet signs, no byte of the
  message can change without breaking that signature.
- The one-time key it signs with owns nothing outside this one transaction.
- It can refuse or delay: a signed transaction it holds back simply expires in about a minute.
- It sees the addresses and amounts of the swaps you ask for, as any swap API does.

## For operators

The API is off unless the deployment sets `BOUND_API_SECRET` and `BOUND_API_KEYS`
(`node tools/agent-key.ts --secret` and `node tools/agent-key.ts <id>` make them; only a hash of
each key is stored). Optional: `BOUND_API_SECRET_PREVIOUS` while rotating the secret,
`BOUND_API_FEE_BPS`, `BOUND_API_PER_MINUTE`. The kill switch `BOUND_DISABLED=1` stops both
endpoints. Design and threat model: `API-AGJENTET.md`.
