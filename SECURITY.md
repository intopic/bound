# Security model

## Guarantee

For every swap Bound builds:

1. The external swap program (Jupiter's route) can move at most `q − f` of the input token, where `q`
   is the amount the user entered and `f` is the Bound fee. The fee is compiled into the page at
   build time (0.5% by default) and the verifier refuses anything above 1% (`MAX_FEE_BPS`).
2. It never receives the wallet W or any token account of W except the output account `W_out`. Any
   delegate on `W_out` is revoked by a trusted instruction before the swap runs, and a `W_out` with
   a close authority is refused.
3. The transaction grants no new authority over W's assets (no approvals, no ownership changes).
4. The user receives at least the minimum they accepted before signing, which is never below the
   quote less the 0.5% slippage. Bound checks it on chain after the swap; if less arrived, the whole
   transaction reverts. When a token is bought, the check compares the user's account for that
   token with its balance when the swap was prepared: a transfer into that account from someone else
   at the same moment counts toward it. Bound never runs two of its own swaps into the same token at
   once.

SOL leaving W in one swap is at most:

```
network fee (≤ F_max, and never above 0.001 SOL)
+ q, when SOL is the input
+ rent, only when the swap opens W's account for the output token
  (1,488,440 lamports ≈ 0.0015 SOL on 19 September 2026, read from the cluster)
```

The rent stays in the user's own new token account and is shown before signing. Bound never makes the
user pay rent for Bound's own fee account: if the treasury has no account for the input token, that
swap is fee-free.

## Why it holds: R6 first

The load-bearing rule is **R6**: the transaction has exactly two signers, W and E, and W pays. **R1**
keeps W out of the external instruction, so W's signature is never available to the external
program. Everything that needs W's signature to move is out of reach even if its account were passed:
SPL transfers from W's accounts, SOL, stake, account closes, authority changes.

R1's address filter then only has to cover what can move **without** W's signature:

- token accounts with a pre-existing delegate: none of W's token accounts reach the external program
  except `W_out`, and `W_out`'s delegate is revoked before the swap;
- mints with a permanent delegate: input and output must be classic SPL tokens, and the Token-2022
  mint of an intermediate account that Bound creates may carry neither a permanent delegate nor a
  transfer hook. Tokens used only inside the route's own pools never reach W's accounts; the
  external instruction is untrusted anyway.

Anyone changing R1 or R6 must re-read this section. The same note sits above the rules in
`packages/verifier/src/verify.ts`.

## Trusted computing base

The guarantee holds if these are correct and unmodified:

| Component | Assumption | Mitigation |
| --- | --- | --- |
| Solana runtime | A program cannot use accounts or signatures it was not given | Runtime attack tests (T1) |
| SPL Token program | Transfers respect owner and amount; a self-transfer checks the balance | Audited, widely used; the self-transfer behaviour is tested on mainnet state (T5) |
| Bound code in the browser | Compiler and verifier are correct and untampered | Independent verifier, mutation and property tests, nonce-based CSP, minimal dependencies |
| Bound's server | Serves the genuine page, and relays RPC answers and token metadata | Reproducible build and SRI are planned. The server cannot change the fee or the treasury (compiled into the page); F_max from the server is capped by the verifier; decimals are checked against the mint on chain |
| RPC | Returns true lookup tables and account state | v1 has no lookup tables, but account state (owners, balances, decimals, authorities) still comes from the RPC; v0 tables must match in full on a second RPC when one is configured |
| Wallet | Signs what it is given | The returned message is re-verified byte for byte before E signs |

The largest remaining risk is a modified frontend (compromised server or supply chain). Serve it from
a reproducible build, keep dependencies minimal, and review every dependency update.

## Adversaries covered

- A malicious or compromised DEX or program inside the route: limited to the approved amount; less
  than the minimum output reverts the transaction.
- A compromised Jupiter API response: rejected by the verifier (R1–R7).
- Changes after verification (wallet, extension, network): rejected by the wallet-return check (R6).
- A compromised Bound server that still serves the genuine page: it sees mints, amounts, E's public
  key and the user's address, never a private key. It can pause swaps, change the alpha limit and
  the excluded DEXes, and lower F_max, but it cannot raise the fee above 1%, the network fee above
  0.001 SOL, or send the fee anywhere else. It also relays RPC answers and token metadata: wrong
  decimals are caught against the chain, but lying account state is the RPC assumption above.

## Not covered

- A compromised server or dependency that serves a **modified** page (see the TCB above).
- Phishing sites that do not use Bound, and approvals the user granted elsewhere before.
- The value of the token bought (rug pulls, freeze authority, mint authority). The page warns about
  the last two.
- Price movement and MEV within the 0.5% slippage tolerance: the minimum output is the quoted amount
  minus that tolerance.
- Token-2022 input and output tokens.

## The temporary key (D7)

E is a non-extractable WebCrypto key: its private bytes cannot be exported, not even by Bound's own
code. That is not the same as "cannot be used": while the page is open, script running in it could
ask E to sign. This does not break the guarantee, because E's accounts are empty outside the
transaction and nothing moves without W's signature, but it is one more reason the page's CSP
matters.

## Certificate

After a transaction passes every rule, the verifier (`@bound/verifier`) issues a certificate bound
to the SHA-256 of the exact message: approved total debit, swap amount, Bound fee, minimum output,
signers, programs invoked, "other assets debited: none" and "persistent permissions: none". The page
shows it while the wallet is open. A certificate is as trustworthy as the verifier that issued it: a
wallet or auditor that does not trust the page should run the verifier on the same bytes.

## Frontend hardening

- Content-Security-Policy with a fresh nonce per request and `'strict-dynamic'` (no `'unsafe-inline'`
  for scripts), images only from Bound's origin and `data:`, network connections only to Bound's
  origin, no framing.
- Token icons are fetched by Bound's server from a fixed list of HTTPS hosts and served from Bound's
  origin, so token creators' hosts never see users' IP addresses.
- This closes direct channels out of the page, not every channel: same-origin endpoints that relay a
  query to Jupiter (`/api/jupiter/tokens`, `/api/token-icon`) remain. The CSP is a mitigation, not a
  guarantee.
- Live quotes are asked for a neutral address, so Jupiter never receives the user's address before a
  swap.

## Data

Bound maintains no customer database, no wallet database and no transaction history as part of its
protection engine; a user's swap history lives only in their own browser. Requests are computed and
discarded. The hosting platform and the RPC provider keep their own operational logs, so Bound does
not promise that nothing is logged anywhere.

## Operational controls

- Kill switch `BOUND_DISABLED=1`: enforced by the server (`/api/jupiter/build` and `sendTransaction`
  on `/api/rpc` are refused), not only hidden in the UI.
- The treasury only receives fees. Its key never touches the server; keep it on a hardware wallet
  or a multisig (e.g. Squads).
- Releases: build from a clean checkout of a signed tag and publish the build's hash, so anyone can
  check that the page served is the one reviewed (reproducible build and SRI are planned).
- Alpha limit per swap `BOUND_MAX_USD_PER_SWAP`, enforced in the page. A token without a USD price is
  blocked while the limit applies. This is a UX limit, not a security boundary.
- API routes are stateless: allowlisted RPC methods and Jupiter parameters (`payer` is refused), a
  second RPC that answers only lookup-table reads, request bodies counted in bytes and capped at
  64 KiB, 15 s timeouts upstream, and no request bodies are stored.
- Rate limits are keyed on the one header the ingress overwrites (`BOUND_CLIENT_IP_HEADER`, default
  `x-vercel-forwarded-for`); no other header is read. They are per instance: set a rate-limit rule in
  the hosting firewall for a limit across instances.

## Reporting

Please report vulnerabilities privately to the maintainers before disclosing them publicly.
