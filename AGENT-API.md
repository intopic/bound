# Orientim agent API

Protected swaps on Solana for bots and AI agents. Your wallet signs a swap in which the swap program
(Jupiter's route) only ever holds a one-time key and a temporary account with the amount you
approved. It cannot touch anything else in the wallet, and if less than your minimum would arrive,
the whole transaction reverts.

Two calls. Orientim builds and verifies the transaction; your wallet signs it first; Orientim signs last,
with the one-time key, and sends it. Orientim never holds your key or your funds.

Calls may carry `x-orientim-skill: <version>`, as the skill does. When a change old copies of the skill
cannot follow requires it, prepare answers an older version with `426 skill-outdated` and the
`minimum` it serves; finalize is never refused for it, so a swap already signed always completes.

**Verify before you sign.** Orientim's server builds the transaction your wallet signs. Run Orientim's
verifier on it, with chain state from your own RPC, before signing: the skill below does it
(`checkPrepared`, verifier bundled in `lib/orientim-verify.mjs`). With that check, a compromised server
or impostor URL can refuse or delay a swap, not make you sign one that moves more than the approved
amount, or one whose minimum is below a floor you got yourself (`minOut`; the check asks Jupiter
for one when you have none). **Without it, you are trusting Orientim's server with your whole wallet.**

Wallets that cannot sign first and hand back a partially signed transaction cannot use Orientim:
Phantom's embedded wallets (sign-and-send only) and multisig or smart-wallet vaults (Squads, Swig).
A local keypair or a remote signer that signs one key (Turnkey, for one) works: the skill's example
takes a service that signs raw bytes (`signerFromSignBytes`) or one that signs a transaction and
hands it back unsent (`signerFromSignTransaction`). Bots in other languages use the skill's
`bin/orientim-verify.mjs` (needs Node): it prepares, checks, finalizes and settles, and the bot only
signs one message with its own key.

For coding agents there is a skill, `skills/orientim-protected-swap/` (`SKILL.md` and a working
example, `examples/swap.ts`, that needs only `@solana/kit` 8):

```bash
npx skills add intopic/bound --skill orientim-protected-swap
```

```
POST /api/v1/prepare    → an unsigned transaction and a ticket
   (you sign the transaction as your wallet)
POST /api/v1/finalize   → Orientim signs last and sends it once
```

## Authentication

Every request carries an API key:

```
Authorization: Bearer ori_...
```

Requests are limited per key (60 per minute per endpoint by default). A `429` means wait and retry.

### API access: a key for your wallet, at once

A key comes from the wallet itself, with no form: the wallet signs Orientim's message, a Sign In With
Solana text that names it, and gets a key bound to it. Signing moves nothing. The key prepares swaps
for that wallet only (another `owner` is refused with `403 wrong-wallet`), so a leaked key is worth
nothing for any other wallet; its limits count per wallet. It lasts 90 days; sign again for a new
one. The wallet must hold at least 0.01 SOL.

```http
GET /api/v1/keys/challenge?wallet=<address>
→ { "message": "orientim.com wants you to sign in with your Solana account:
<address>
...", "challenge": "...", "expiresAt": "..." }

POST /api/v1/keys
{ "message": "<the message, unchanged>", "challenge": "...", "signature": "<the wallet's ed25519 signature of message, base58 or base64>" }
→ { "key": "ori_w1....", "wallet": "<address>", "expiresAt": "..." }
```

The challenge must be signed within 10 minutes. **Sign only Orientim's key message for your own
wallet**: a signature over bytes someone else chose could be a signature for a transaction. The skill's
`requestApiKey` (and `orientim-verify key-challenge`, then `key`) checks the message before anything is
signed: this host, this wallet, the key statement, plain text and nothing more. Keys issued by hand
keep working beside these.

The message always names Orientim's own site (`ORIENTIM_PUBLIC_ORIGIN` on the deployment), whatever
host a request claims, and a message naming another site is refused. A signed challenge is not
spent when it is used: within its 10 minutes it can be exchanged again, for another key of the same
wallet, which gives nothing more. A key is revoked by its wallet: `ORIENTIM_API_REVOKED` lists
`<wallet>` (all its keys) or `<wallet>@<unix seconds>` (its keys issued until then, so that the
wallet's owner can sign again for a new one).

## Fee

0.3%, inside the transaction, taken the way Jupiter takes its own: in SOL first, then USDC, then
USDT, on whichever side of the swap they are; otherwise in the input token. `amounts.feeMint` says
which. On the input it is 0.3% of `amountIn`; on the output it is 0.3% of the enforced minimum, paid
after the minimum is checked, and `amounts.minOut` is what your wallet keeps after it. It is part of
the message you sign, and Orientim signs only the exact message it built, so a transaction with the fee
removed is not signed. The verifier refuses anything above 1%.

A swap between two tokens neither of which can carry the fee (no SOL, USDC or USDT on it, and no
treasury account for the input) pays it in SOL from your wallet, before the swap: 0.3% of what the
swap is worth in SOL, as Jupiter prices it when prepare builds it. `amounts.feeMint` is then SOL,
`policy.feeSide` is `sol` and `certificate.solFee` states it. The rules cannot see a price, so the
skill's check requires a limit of your own for it (`maxSolFeeLamports`; `ownSolFeeLimit` asks Jupiter
for one, and the example does this itself). Without a treasury wallet, or when the swap cannot be
priced in SOL, it is fee-free.

## 1. Prepare

```http
POST /api/v1/prepare
Content-Type: application/json
Authorization: Bearer ori_...

{
  "owner": "<your wallet address>",
  "inputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "outputMint": "So11111111111111111111111111111111111111112",
  "amountIn": "5000000",
  "minOut": "42400000"
}
```

| Field | | |
| --- | --- | --- |
| `owner` | required | The wallet that pays and receives. It signs first. |
| `inputMint`, `outputMint` | required | Mint addresses. SOL is `So11111111111111111111111111111111111111112`. |
| `amountIn` | required | Base units, as a string (`"5000000"` is 5 USDC). The fee comes out of it. |
| `minOut` | optional | Your own floor, in base units of the output: what your wallet must keep, after a fee taken from the output. Orientim never enforces less than this. Without it, the floor is the route's quote less 0.5% (3% on a Pump.fun bonding curve), which is Orientim's word: the skill's check refuses to sign without a floor of your own, and `ownMinimum` gets one from Jupiter directly. For a large order, take it from a source independent of Jupiter as well (an oracle, another aggregator, limits of your own). |
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
  "blocksLeft": "148",
  "amounts": { "amountIn": "5000000", "fee": "127700", "feeMint": "So11111111111111111111111111111111111111112",
               "feeBps": "30", "swapAmount": "5000000", "quotedOut": "42780667", "minOut": "42439063",
               "priceImpactPct": 0.0001 },
  "costs": { "networkFeeLamports": "124480", "outputAccountRentLamports": "0", "routeRentLamports": "0", "routeRefundLamports": "0",
             "keptSolLamports": "124480", "tokenTax": null },
  "notices": { "removesDelegate": false },
  "route": ["Kipseli", "AlphaQ"],
  "certificate": { "...": "what this exact transaction does, bound to messageSha256" },
  "policy": { "...": "the rules the transaction was verified against" }
}
```

All amounts are strings in base units. The transaction lives 150 blocks, about 40 seconds at
today's block times (until `lastValidBlockHeight`; `blocksLeft` is what was left when prepare
answered). Verify, sign and finalize promptly; with fewer than 30 blocks left, prepare again instead.

Before signing, run the verifier: `verifyPrepared(prepared, limits, yourRpc)` from the skill's
`lib/orientim-verify.mjs`, where `limits` is what you asked for and the most you accept (fee, network
fee, optionally Orientim's treasury address) and your own minimum, which is required: a price you got
yourself, never Orientim's (`ownMinimum` asks Jupiter for one). It holds `policy` to those limits, reads
every account the message names from your RPC, runs the verifier's rules on the exact bytes, and
simulates the transaction there: nothing may stay under the one-time key, in its own account or in
the account a Pump.fun market opens in its name, and no account the route opens may stay open,
whatever market it belongs to. Rent the route keeps (`costs.routeRentLamports` less
`costs.routeRefundLamports`) is accepted only up to your `maxRouteCostLamports`, 0.001 SOL unless you
set it (a Pump.fun bonding curve keeps about 0.00013 SOL of every buy). `costs.keptSolLamports` is
all the SOL the swap costs and does not return, in one number: the network fee, rent the route keeps,
and Orientim's fee when it is paid in SOL (a new output account's rent is apart: that account stays
yours). To hold it to one ceiling of your own, set `maxSolCostLamports`; the check computes it from
the bytes, not from this statement. The `certificate` and `amounts` are Orientim's statements; the check is what makes them
evidence, and holds the amounts stated to the policy the bytes are checked against.

`notices.networkBusy` means the network fee is at its limit, so the swap may land late or expire.
`amounts.feeBps` is 0 when the swap is fee-free.

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

The transaction's signature, its id on chain, is your wallet's signature: you know it now, before
finalize (`getSignatureFromTransaction(signed)`). Keep it, with the ticket, before calling finalize.
Whatever finalize answers, or if no answer arrives, that signature is how you find out what happened.

## 3. Finalize

```http
POST /api/v1/finalize
Content-Type: application/json
Authorization: Bearer ori_...

{ "ticket": "eyJ2Ijox....", "signedTransaction": "<base64, signed by your wallet>" }
```

Orientim checks that the message is byte for byte the one it built and looks the transaction up on
chain first: if an earlier finalize of this ticket already sent it, the answer is that same
transaction again and nothing is sent. Otherwise it checks that your wallet's signature is valid,
that the transaction has not expired, and that your output account holds what it held at prepare
(another swap or a transfer in between would count toward the minimum); then it signs as the
one-time key and sends it once. Run one swap per output token at a time.

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
| `sent` | The RPC accepted it, or it is already on chain. Confirm it on chain; re-broadcast `signedTransaction` until it confirms or `lastValidBlockHeight` passes. It can land only once. |
| `unknown` | The connection failed after the request left. It may have been forwarded: check the signature before doing anything else. |
| `rejected` | This request never broadcast it (`refusal`: `network` is the RPC's preflight, usually a price that moved). No `signedTransaction` is returned. |

Finalizing the same ticket again, after an answer that never arrived, answers for the same
transaction: while it is not on chain it is sent again (the same bytes can land only once), and
once it is on chain the answer is `sent` with the same bytes, even after its lifetime or during a
pause.

**Before preparing again for the same swap**, make sure the transaction you signed can no longer
land: its signature has no record on your RPC and the finalized block height is past
`lastValidBlockHeight`, **read as one view**. Take the finalized slot and height from one answer
(`getEpochInfo` at `finalized`), and accept "no record" only from a status answer whose `context.slot`
is at least that slot. A provider may answer from several nodes, and a lagging node's silence proves
nothing. An answer from finalize, `rejected` or an error, speaks only for that one
request; an earlier finalize of the ticket whose answer was lost may have sent it. Take the last
block from your own RPC too (your block height when you sign, plus 150, plus a margin for a
lagging node): the blockhash is older than that, so the server's figure cannot shorten the wait.

"No record" is proof only while the node that answers still holds every block the transaction could
have landed in. A node answers first from its status cache, its last 300 blocks, and only then from
its ledger history or an archive, which can be pruned or missing; an archive that fails answers "no
record" too. So accept it only when the answering node's height (the finalized height plus the slots
its `context.slot` is ahead of the finalized slot) is below the height you signed at plus 300, less a
margin: in practice, the half-minute after the lifetime. Later, the outcome is unknown until you look
the signature up in a full history. The skill's example does all of this (`protectedSwap`, `confirm`
with `earliestHeight`, `recoverPending`), and `orientim-verify resolve` settles by hand a swap it can no
longer prove.

## Errors

Every error is `{ "error": { "code": "...", "message": "..." } }`, and the request that received it
signed and sent nothing. From finalize, once the ticket and message check out, the error also names
the transaction (`signature`, `lastValidBlockHeight`): an earlier finalize of the same ticket may
have sent it, so check it before preparing again (see above). `price-moved` and `costs-more` carry
`requiresApproval: true`: a worse price or a costlier route is the user's decision, not a retry.

| HTTP | `code` | What to do |
| --- | --- | --- |
| 400 | `bad-request` | Fix the request; `message` says which field. |
| 400 | `invalid-ticket` | The ticket was not issued to this API key, or was altered. |
| 400 | `transaction-changed` | The message is not the one Orientim built. Sign the transaction exactly as returned. |
| 400 | `wallet-changed-transaction` | Your wallet's signature is missing or does not match (`violations`). |
| 401 | `unauthorized` | Missing or unknown API key. |
| 404 | `not-enabled` | The deployment has no agent API. |
| 409 | `price-moved` | The market cannot meet your `minOut`. `newMinOut` is what it supports now: with the user's approval, prepare again with it; or not. |
| 409 | `costs-more` | The route that fits in one protected transaction is `gapBps` below the open market. With the user's approval, prepare again with `acceptCostBps`. |
| 409 | `output-balance-changed` | Your balance of the output token moved since prepare, so this request signed nothing. Check `signature` as above, then prepare again. |
| 410 | `expired` | The transaction's lifetime passed before this finalize signed it. Check `signature` as above, then prepare again. |
| 422 | `unsupported-token`, `no-route`, `bad-quote`, `insufficient-sol`, `insufficient-balance`, `simulation-failed`, `verification-failed`, `token-data-mismatch`, `output-account-restricted`, `input-account-restricted` | This swap cannot be built safely right now; `message` says why. |
| 429 | `rate-limited` | Too many requests for this key. Wait `Retry-After` seconds. |
| 503 | `busy`, `unavailable` | Jupiter or the network is overloaded or silent (from finalize: Orientim could not read whether the transaction was already sent). Wait `Retry-After` seconds and retry. |
| 503 | `paused` | Orientim has paused protected swaps. Your funds are not affected. A transaction already on chain is still reported by finalize. |
| 503 | `route-format` | Jupiter changed its swap instruction and Orientim refuses what it cannot read. Nothing builds until Orientim is updated: wait `Retry-After` (300) seconds, not less. |

## What Orientim can and cannot do with your swap

- It never has your key, and after your wallet signs, no byte of the message can change without
  breaking that signature. What you sign is what the verifier approved, if you ran it on your own
  RPC; if you did not, you signed what Orientim's server built.
- No permission over your wallet outlives the transaction. On Pump.fun routes the market opens a
  per-buyer account under the one-time key; Orientim closes it at the end of the same transaction and
  sends its rent back to your wallet (`costs.routeRefundLamports`). When that cannot be done (the
  account also holds a cashback coin's cashback, or the close does not fit in the transaction), that
  route is refused, and so is any route that opens an account of another market and leaves it
  open. Orientim's server can derive the key again from its secret, so whoever holds that secret could
  collect what stayed under it: that is why nothing may, and why the skill's check simulates the
  transaction on your RPC and refuses one that leaves anything under the key or any account the
  route opened, and rent that does not come back beyond your limit. Orientim derives a key only for its
  ticket's finalize, repeated or not, and never logs the nonces it derives from.
- It keeps no state (no database): two prepares for the same order are two different transactions
  to it. One swap per order is kept by your order book (the skill's `OrderBook`, shared by every
  worker that may take the order), not by Orientim.
- It can refuse or delay: a signed transaction it holds back simply expires, in about 40 seconds.
- It sees the addresses and amounts of the swaps you ask for, as any swap API does.

## For operators

The API is off unless the deployment sets `ORIENTIM_API_SECRET` and `ORIENTIM_API_KEYS`
(`node tools/agent-key.ts --secret` and `node tools/agent-key.ts <id>` make them; only a hash of
each key is stored). Optional: `ORIENTIM_API_SECRET_PREVIOUS` while rotating the secret,
`ORIENTIM_API_FEE_BPS`, `ORIENTIM_API_PER_MINUTE`. The kill switch `ORIENTIM_DISABLED=1` stops both
endpoints. Threat model: `SECURITY.md`; the history of every review and fix: `docs/AUDIT.md`.
