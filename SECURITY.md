# Security model

## Guarantee

For every swap Bound builds:

1. The external swap program (Jupiter's route) can move at most `q − f` of the input token, where `q`
   is the amount the user entered and `f` is the Bound fee. The fee is compiled into the page at
   build time (0.3% by default) and the verifier refuses anything above 1% (`MAX_FEE_BPS`).
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
- mints with a permanent delegate: such a mint is refused outright, and the Token-2022
  mint of an intermediate account that Bound creates may carry neither a permanent delegate nor a
  transfer hook. Tokens used only inside the route's own pools never reach W's accounts; the
  external instruction is untrusted anyway.

Anyone changing R1 or R6 must re-read this section. The same note sits above the rules in
`packages/verifier/src/verify.ts`.

## Trusted computing base

The guarantee holds if these are correct and unmodified:

| Component | Assumption | Mitigation |
| --- | --- | --- |
| Solana runtime | A program cannot use accounts or signatures it was not given | Runtime attack tests (T1) and a malicious swap program run in a real Solana VM (T6, 19/19) |
| SPL Token program | Transfers respect owner and amount; a self-transfer checks the balance | Audited, widely used; the self-transfer behaviour is tested on mainnet state (T5) |
| Bound code in the browser | Compiler and verifier are correct and untampered | Independent verifier, mutation and property tests, nonce-based CSP, minimal dependencies |
| Bound's server | Serves the genuine page, and relays RPC answers and token metadata | CI compares two builds and the page uses partial SRI (details below). The server cannot change the fee or the treasury (compiled into the page); F_max from the server is capped by the verifier; decimals are checked against the mint on chain |
| RPC | Returns true lookup tables and account state | v1 has no lookup tables, but account state (owners, balances, decimals, authorities) still comes from the RPC; v0 tables must match in full on a second RPC when one is configured |
| Wallet | Signs what it is given | The returned message is re-verified byte for byte before E signs |

The largest remaining risk is a modified frontend (compromised server or supply chain). Serve it
from a reproducible build, keep dependencies minimal, and review every dependency update. What
"minimal" currently means is counted under "The dependencies that run in your browser".

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
- Token-2022 tokens whose extensions Bound refuses: a permanent delegate, accounts frozen by
  default, pausable, non-transferable, interest-bearing, a scaled UI amount, a required memo, a
  transfer hook with a real program, or any extension the verifier does not know.
- A token that charges its own transfer fee is supported, and costs more through Bound than
  elsewhere: the fee applies to every transfer, and a protected swap makes one transfer more than
  an unprotected one. The page says so before the swap and again while the wallet is open. That
  money goes to the token, never to Bound.
- A price that is worse than the open market: a protected route must fit in one transaction and
  leaves out pools that would leave an account behind. Above 1% the page shows the difference and
  asks, with a stronger warning past 5%; the swap is never blocked over it, because a person who
  understands the cost and still wants the guarantee is entitled to it. Bound refuses on its own
  only past 50%, where the answer is not a price but a broken one. Note that this difference is not
  price impact: the size of a trade moves the market for the protected and the unprotected route
  alike, so it cancels out of the comparison. **This comparison is a courtesy, not a guarantee:** both the protected route and
  the unrestricted one it is measured against come from Jupiter, so an aggregator that lowered both
  would pass it unnoticed. What protects the user is the minimum output they accepted, which is
  enforced on chain. A guarantee about the market price would need an independent price source.

## The temporary key (D7)

E is a non-extractable WebCrypto key: its private bytes cannot be exported, not even by Bound's own
code. That is not the same as "cannot be used": while the page is open, script running in it could
ask E to sign. This does not break the guarantee, because E's accounts are empty outside the
transaction and nothing moves without W's signature, but it is one more reason the page's CSP
matters.

## Certificate

After a transaction passes every rule, the verifier (`@bound/verifier`) issues a certificate bound
to the SHA-256 of the exact message: approved total debit, swap amount, Bound fee, minimum output,
signers, the programs the transaction invokes directly, "other tokens debited: none", "persistent
permissions: none", the verifier's version and the slot of the chain state the rules were checked
against. The page shows it while the wallet is open.

A certificate is a receipt, not a proof. It is not signed by anyone, and it is issued by the same
code that verified the transaction, so a compromised page could show one that says anything. It is
worth exactly what the verifier that issued it is worth: a wallet, an agent or an auditor that does
not trust the page should run `@bound/verifier` on the same bytes, policy and chain state and
compare. For an automated signer that is the intended use — run the verifier next to the signer.

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

## Verifying the code you are running

A page can claim anything. These are the two ways to check this one.

**The build is reproducible.** `BOUND_BUILD_ID=<commit> npm run build && node tools/build-digest.ts`
prints one hash over every file the browser can load from `/_next/static`. Two builds of the same
commit produce the same hash — CI proves it on every push by building twice — so the digest
published with a release can be compared against a build you made yourself.

**Scripts carry their own hashes.** The page sets `integrity` on the scripts it loads
(`experimental.sri`, SHA-384), so a browser refuses a script whose bytes were altered between the
build and the tab. Next does not put it on every chunk yet: today 5 of 7 script tags carry one, and
the browser test records the exact ratio on every run rather than assuming it. The chunks without
it are still covered by the digest above, which is over every file.

Neither of these protects against a backend that serves a different page on purpose. What they do
is make that visible to anyone who looks, instead of impossible to tell.

## The dependencies that run in your browser

"Keep dependencies minimal" is a claim until someone counts it. Counted on 2026-09-21:

| | |
| --- | --- |
| Known advisories, `npm audit` with and without dev | **0** |
| Packages in the whole locked tree that declare an install script | **1** — `fsevents`, macOS-only, optional, dev |
| Entries resolved from anywhere other than `registry.npmjs.org` | **0** |
| Entries without an integrity hash | **0** |
| Third-party code that can reach a browser | 55 packages, from 5 publishers |
| Built client JavaScript | 744 KB across 12 files |

An install script is how a supply-chain attack usually runs: it executes on `npm install`, with the
developer's or the build machine's privileges, before anyone has read a line of the package. One
package in this tree has one, it only installs on macOS, and it is a dev dependency of the test
runner. Nothing that ships has one.

The 55 browser-reachable packages are not 55 vendors. They are `@solana/*` (43 packages, one release
train of `@solana/kit`), `@solana-program/*` (3), `@wallet-standard/*` (2), React with its scheduler
(3), and Next's runtime helpers. Nothing else: no analytics, no error reporter, no font loader, no
wallet-adapter aggregator, no UI framework.

The Node-only packages `@solana/kit` carries for its own tooling — `ws`, `chalk`, `commander`,
`undici-types` — were checked against the built chunks rather than assumed away. None of their
markers appears anywhere in `.next/static`, so none of them reaches a browser.

Two things matter more than the count itself.

**`connect-src 'self'`.** A compromised dependency inside the page cannot send anything anywhere:
the CSP allows network calls only back to Bound's own origin, and `img-src` is `'self' data:`. What
it could still do is alter the transaction before the wallet sees it — but the verifier lives in the
same bundle, so a compromised bundle is compromised whatever its dependency count. That is what the
reproducible build and SRI above are for, and it is why they matter more than this table.

**`npm ci` everywhere.** Every workflow installs from the lockfile, so a build uses the exact
versions recorded rather than whatever the `^` ranges resolve to that day. One deviation: `cpi.yml`
adds `litesvm@1.4.1` with `npm install --no-save`, because litesvm publishes no Windows binding and
only CI can run that test. It is pinned to an exact version but sits outside the lockfile.

One limit of this count: 81 of the locked entries are native binaries for platforms other than this
one (`@next/swc-*`, `sharp`, `litesvm`), so they are not installed here and could not be read. A
different subset installs on the deploy platform. The install-script figure above comes from the
lockfile's own `hasInstallScript` flags, which cover every entry regardless of platform.

A dependency update is therefore a security event, not a chore. It changes the bytes a browser runs,
and the digest published with the release is what makes that visible.

## One RPC provider

Bound runs on a single RPC provider (Helius). That is an operational choice: two providers from two
companies would remove one trust assumption, at the cost of a second account, a second bill and a
second thing that can break.

What the second provider bought was a cross-check of address lookup tables. In a v0 transaction the
account list is partly stored in those tables, so the verifier has to read them from somewhere, and
an RPC that lied about a table could hide an account from rule R1. With one provider, Bound trusts
that provider for exactly that. Everything else it returns is checked: account contents are read
into a snapshot that every rule is applied to, and a transaction that does not match is refused.

Two things bound this risk. A v1 transaction carries no lookup tables at all, so the assumption
disappears as wallets adopt it. And setting `RPC_URL_SECONDARY` to a different company's endpoint
turns the cross-check back on at any time, with no code change.

## Operational controls

- Kill switch `BOUND_DISABLED=1`: enforced by the server (`/api/jupiter/build` and `sendTransaction`
  on `/api/rpc` are refused), not only hidden in the UI.
- The treasury only receives fees. Its key never touches the server; keep it on a hardware wallet
  or a multisig (e.g. Squads).
- Releases: build from a clean checkout of a signed tag and publish the build's digest
  (`npm run build:digest`), so anyone can check that the page served is the one reviewed. The build
  is deterministic: CI builds every commit twice and fails if the two digests differ.
- No limit per swap: the guarantee is the same for any amount, and nothing in Bound holds funds.
  `BOUND_MAX_USD_PER_SWAP` exists as an operational valve and is unset by default; while it applies
  it is enforced in the page only, and tokens without a USD price are blocked. A large swap is
  limited by the route, not by us: if no route fits inside one transaction, Bound refuses to build
  it rather than splitting the swap (section "What Bound does not protect").
- API routes are stateless: allowlisted RPC methods and Jupiter parameters (`payer` is refused), a
  second RPC that answers only lookup-table reads, request bodies counted in bytes and capped at
  64 KiB, 15 s timeouts upstream, and no request bodies are stored.
- Rate limits are keyed on the one header the ingress overwrites (`BOUND_CLIENT_IP_HEADER`, default
  `x-vercel-forwarded-for`); no other header is read. They are per instance: set a rate-limit rule in
  the hosting firewall for a limit across instances.

## Reporting

Please report vulnerabilities privately to the maintainers before disclosing them publicly.
