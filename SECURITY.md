# Security model

## Guarantee

For every swap Bound builds:

1. The external swap program (Jupiter's route) can move at most `q − f` of the input token, where `q`
   is the amount the user entered and `f` is the Bound fee. The fee is compiled into the page at
   build time (0.2% by default) and the verifier refuses anything above 1% (`MAX_FEE_BPS`). When
   the route opens an account in the temporary key's name and charges it the rent (both of
   Pump.fun's markets do, once per buyer), it can also reach exactly that rent, which is measured in simulation, capped at
   0.005 SOL (`MAX_TAKER_RENT_LAMPORTS`) and stated before signing. Nothing else in SOL.
2. It never receives the wallet W or any token account of W except the output account `W_out`. Any
   delegate on `W_out` is revoked by a trusted instruction before the swap runs, and a `W_out` with
   a close authority is refused.
3. The transaction grants no new authority over W's assets (no approvals, no ownership changes).
4. The user receives at least the minimum they accepted before signing, which is never below the
   quote less the slippage: 0.5%, or 3% when the route trades on a Pump.fun bonding curve. Bound
   checks it on chain after the swap; if less arrived, the whole transaction reverts. When a token
   is bought, the check compares the user's account for that token with its balance when the swap
   was prepared, and that balance is read from the RPC: the check assumes the RPC reports it
   truthfully, and a transfer into that account from someone else at the same moment counts toward
   it. Jupiter's program also enforces a floor on chain, a second one that does not depend on the
   RPC: it measures what its own instruction delivers, and the verifier requires that instruction to
   deliver into the user's own account (or E's temporary one for SOL), so that floor is always on the
   right account (research audit), and requires it to reach the whole minimum, not only the quote:
   when the user accepted more than the route's own floor, Bound tightens the route's tolerance until
   it does (engineering review H-03). A transfer arriving at the same moment, or another swap into
   the same token, cannot then make up for a route that delivered less. Bound never runs two of its
   own swaps into the same token at once in the same browser.

Bound has one minimum-output model for every router: an exact base-unit amount enforced by a trusted
instruction in the same transaction and checked independently by the verifier. A router's own
threshold may make that amount stricter, never weaker. Router-only, off-chain or differently shaped
guarantees are not substitutes; an integration that cannot compile to this balance floor is not a
supported protected route.

SOL leaving W in one swap is at most:

```
network fee (≤ F_max, and never above 0.001 SOL)
+ q, when SOL is the input
+ rent, only when the swap opens W's account for the output token
  (1,488,440 lamports ≈ 0.0015 SOL on 23 September 2026, read from the cluster; the rent per byte
  falls again in November 2026 under SIMD-0437, and Bound shows whatever the cluster says)
+ route rent, only when the route opens an account in E's name
  (1,346,200 or 1,478,280 lamports ≈ 0.0013–0.0015 SOL on Pump.fun's markets, September 2026;
  at most 0.005 SOL), of which the account's own rent comes back in the same transaction
  (1,346,200 lamports: all of it on PumpSwap, all but 132,080 on a bonding curve that grows)
```

The account the route rent pays for, Pump.fun's per-buyer volume accumulator, is closed at the end of
the same transaction and its lamports go straight back to W (review FA-05): Bound adds Pump's own
`close_user_volume_accumulator`, signed by E, and a transfer of what it returned from E to W. What
the market keeps is only what it spent elsewhere (132,080 lamports when a bonding curve grows its
own account; nothing on PumpSwap), and that is what the page shows as the market's account fee.
This is the one instruction of a market's program that Bound itself places, and the verifier admits
it only in its exact IDL shape, for E's own account (the PDA is derived, not read), for Pump's two
programs, and only **after E's last token account is closed**: when it runs, E's signature reaches
nothing but the lamports it returns. A Pump program changed by its upgrade authority could keep
those lamports; the transfer to W would then fail and the whole swap revert, costing the network
fee. When closing is not possible (the transaction would not fit, or the simulation says no), the
swap goes ahead without it, as before, and that rent stays under a discarded key. Through the agent
API, E is derived from Bound's server secret and the ticket's nonce; Bound never re-derives it after
finalize and never logs nonces.

The rent stays in the user's own new token account and is shown before signing. Bound never makes the
user pay rent for Bound's own fee account.

The fee (0.2%) is taken in the order Jupiter prefers for its own (its pricing and token list differ):
in SOL first, then USDC, then USDT, on
whichever side of the swap they are and the treasury can receive them; otherwise in the input token
when the treasury has an account for it; otherwise the swap is fee-free. On the input it is 0.2% of
the amount, paid before the swap. On the output it is 0.2% of the enforced minimum, paid after the
minimum is checked (from the wallet once E_out has paid out, for SOL; from `W_out`, for USDC or
USDT): the minimum the user sees and accepts is what the wallet keeps after it, and the fee is never
more than 0.2% of what the swap delivers, since Jupiter's own floor holds the route to that minimum
whatever else arrives in the account (engineering review H-03). This is what lets a memecoin sold for SOL pay, where the treasury
could never hold an account for every new token.

## Why it holds: R6 first

The load-bearing rule is **R6**: the transaction has exactly two signers, W and E, and W pays. **R1**
keeps W out of the external instruction, so W's signature is never available to the external
program. Everything that needs W's signature to move is out of reach even if its account were passed:
SPL transfers from W's accounts, SOL, stake, account closes, authority changes.

R1's address filter then only has to cover what can move **without** W's signature:

- token accounts with a pre-existing delegate: none of W's token accounts reach the external program
  except `W_out`, and `W_out`'s delegate is revoked before the swap;
- mints with a permanent delegate: such a delegate moves tokens without W's signature. Inside the
  swap it can reach only accounts of that mint the route was given: E's, which are the route's
  anyway, and `W_out`. What protects `W_out` is the minimum-output check, which counts `W_out`'s
  balance after the swap against its balance before, so anything the delegate takes out is netted.
  Bound also refuses a delegate that is a program-derived address, but that rule is not what
  protects the user: an "ordinary" delegate can still be a Token-program multisig whose signer is a
  program, and the delegate can be reassigned after the snapshot (review BR-05, AUDIT.md sections
  0j and 0m). A transfer hook with a real program is refused. Tokens used only inside the route's
  own pools never reach W's accounts; the external instruction is untrusted anyway.

Anyone changing R1 or R6 must re-read this section. The same note sits above the rules in
`packages/verifier/src/verify.ts`.

## Trusted computing base

The guarantee holds if these are correct and unmodified:

| Component | Assumption | Mitigation |
| --- | --- | --- |
| Solana runtime | A program cannot use accounts or signatures it was not given | Runtime attack tests (T1) and a malicious swap program run in a real Solana VM against classic SPL and Token-2022 (T6, 32/32) |
| SPL Token and Token-2022 programs | Transfers respect owner and amount; a self-transfer checks the balance | Audited, widely used; the self-transfer behaviour is tested on mainnet state (T5) and both programs are exercised through hostile CPI (T6) |
| Bound code in the browser | Compiler and verifier are correct and untampered | Independent verifier, mutation and property tests, nonce-based CSP, minimal dependencies |
| Bound's server | Serves the genuine page, and relays RPC answers and token metadata | CI compares two builds and the page uses partial SRI (details below). The server cannot change the fee or the treasury (compiled into the page); F_max from the server is capped by the verifier; decimals are checked against the mint on chain |
| RPC | Returns true lookup tables and account state | v1 has no lookup tables, but account state (owners, balances, decimals, authorities) still comes from the RPC; v0 tables come from the same single provider (see "One RPC provider") |
| Wallet | Signs what it is given | The returned message is re-verified byte for byte before E signs |

The largest remaining risk is a modified frontend (compromised server or supply chain). Serve it
from a reproducible build, keep dependencies minimal, and review every dependency update. What
"minimal" currently means is counted under "The dependencies that run in your browser".

## Adversaries covered

- A malicious or compromised DEX or program inside the route: limited to the approved amount; less
  than the minimum output reverts the transaction.
- A compromised Jupiter API response: rejected by the verifier (R1–R7) if it breaks isolation. A
  bad price, or a route label, is not something the verifier can detect.
- Changes after verification (wallet, extension, network): rejected by the wallet-return check (R6).
- A compromised Bound server that still serves the genuine page: it sees mints, amounts, E's public
  key and the user's address, never the wallet's key. (The agent API is different: its server holds
  the secret E is derived from, and an agent that skips the verification in the skill trusts the
  server with its whole wallet; see AGENT-API.md.) It can pause swaps, change the alpha limit and
  the excluded DEXes, and lower F_max, but it cannot raise the fee above 1%, the network fee above
  0.001 SOL, or send the fee anywhere else. It also relays RPC answers, Jupiter's answers and token
  metadata. Wrong decimals are caught against the chain, but a relay that under-reports the balance
  of the user's output account and forges a route through its own pool can defeat Bound's minimum
  for a token output, and take the whole swap amount from a user who already holds that token
  (review BR-01). Jupiter's on-chain threshold does not help against a forged route. The defence
  is serving the genuine page and relays from a published, monitored release (section "Verifying
  the code you are running").

## Not covered

- A compromised server or dependency that serves a **modified** page (see the TCB above).
- Phishing sites that do not use Bound, and approvals the user granted elsewhere before.
- The value of the token bought (rug pulls, freeze authority, mint authority). The page warns about
  the last two.
- Price movement and MEV within the slippage tolerance (0.5%, or 3% on a Pump.fun bonding curve):
  the minimum output is the quoted amount minus that tolerance.
- Token-2022 tokens whose extensions Bound refuses: a permanent delegate a program can sign for,
  accounts frozen by default, pausable, non-transferable, interest-bearing, a scaled UI amount, a
  required memo, a transfer hook with a real program, or any extension the verifier does not know.
- What a token's issuer can do outside the swap. A stablecoin such as PYUSD gives its issuer a
  delegate that can move or freeze it in any wallet; Bound accepts it only when that delegate cannot
  act inside the swap, and says so to the user, but it cannot and does not limit the issuer.
- A token that charges its own transfer fee is supported, and costs more through Bound than
  elsewhere: the fee applies to every transfer, and a protected swap makes one transfer more than
  an unprotected one. The page says so before the swap and again while the wallet is open. That
  money goes to the token, never to Bound.
- A price that is worse than the open market: a protected route must fit in one transaction and
  leaves out pools that would leave an account behind. From 0.5% the page shows the difference and
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
against. The page does not show it: the person swapping is told the amounts, the minimum and the
costs in plain words. The certificate travels with the prepared swap for whoever wants to check it.

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
- Live quotes are asked for a neutral address. The swap built ahead of the click, while the user
  reads the quote, is asked for with the user's output account (an associated account, so the user's
  address follows from it): Jupiter can learn who is about to swap before they click (review FA-11),
  a trade made for latency.

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
build and the tab. Next signs only the scripts it writes itself; the chunks of the page's own code
are written by React, so each page preloads them with the hashes Next computed at build time and
React copies the hash onto the tag (`apps/web/lib/server/scriptIntegrity.ts`). Today 7 of 8 script
tags carry one. The eighth is Next's layout chunk (router and error boundaries), which is written
before any page code runs; the browser test names it and fails if a second tag loses its hash. It
is still covered by the digest above, which is over every file.

**The live site is compared with the release.** A tag `v*` publishes a GitHub release with
`build-digest.txt`, the hash of every file for that commit (`.github/workflows/release.yml`). Every
three hours `tools/check-live.ts` fetches each of those files from the site and fails if one
differs, if a page refers to a static file the release does not have, or if a page loads a script
from anywhere else (`.github/workflows/live-check.yml`). Anyone can run the same check:
`node tools/check-live.ts --site <url> --manifest build-digest.txt`.

Neither of these protects against a backend that serves a different page on purpose, or a
different page to some visitors only; the inline HTML is also outside the digest, since its nonce
changes on every request. What they do is make a changed deploy visible to anyone who looks,
instead of impossible to tell. For a user to rebuild and compare, the source must be readable.

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

The rules are applied to a snapshot the RPC provides, so the RPC is trusted for more than lookup
tables. What depends on it, from the v1 review (AUDIT.md section 0m):

| Read | Used for | If the RPC lies |
| --- | --- | --- |
| Balance of the output account | The minimum-output check for a token output | Bound's check can pass with less delivered, but Jupiter's floor still holds the route to the whole minimum: the verifier requires Jupiter to deliver into that same account and its floor (quote less tolerance) to reach the minimum, and Jupiter measures what its instruction delivered, not the balance (engineering review H-03) |
| Lookup table contents | R1 | Together with a lying Jupiter, an account could be hidden. v1 transactions have no lookup tables |
| Owners and data of the route's accounts | R1's test for W's own accounts | A W account with a delegate the user set up earlier could be hidden |
| Mints: owner, decimals, extensions | R2, R7, amounts | A wrong decimals value reverts on chain (TransferChecked); a hidden extension falls back on the minimum |
| Simulation | The route rent sent to E | Up to the 0.005 SOL cap, stated before signing |
| Whether the treasury has an account | Fee on or off | Only Bound's revenue |
| Blockhash, fee, epoch | Lifetime, the fee check, tax pricing | Expiry or a revert, never a loss |
| Statuses, block height | What the page reports | A landed swap could be shown as expired |

What does not depend on it: that W's signature never reaches the external program, the exact debit
templates, the fee caps, and the bytes the wallet signs.

A v1 transaction carries no lookup tables at all, so the assumption disappears as wallets adopt
it. The optional cross-check against a second provider was removed on 23 September 2026 to keep
Bound simple; it never ran in the setup Bound uses, and bringing it back would be a code change.

## Operational controls

- Kill switch `BOUND_DISABLED=1`: enforced by the server (`/api/jupiter/build`, `sendTransaction`
  on `/api/rpc` and both agent endpoints are refused), not only hidden in the UI. **On Vercel an
  environment change reaches only new deployments** (review FA-02), so flipping it in the dashboard
  does nothing until a redeploy. The runbook:
  1. Keep a paused deployment ready: deploy the current release once more with `BOUND_DISABLED=1`
     and leave it unpromoted. Rebuild it with every release.
  2. To pause: promote that deployment (dashboard, "Promote to Production", or `vercel promote <url>`),
     which takes seconds. To resume: promote the normal deployment back ("Instant Rollback").
  3. Revoking an API key or rotating `BOUND_API_SECRET` is a redeploy; for an urgent revocation,
     pause first (step 2), then redeploy with the key removed.
  4. Rehearse it once on a preview: promote, check `/api/status` says paused and a
     `sendTransaction` is refused, promote back, and write down how long each step took.
- The treasury only receives fees. Its key never touches the server; keep it on a hardware wallet
  or a multisig (e.g. Squads).
- Relays: `/api/rpc` sends and simulates only transactions shaped like a Bound swap (two signers,
  one Jupiter route the verifier can read, otherwise only its trusted instruction shapes; review
  FA-06). That narrows what Bound's RPC account can be used for, but a shape says nothing about
  amounts or destinations, so it does not prove a request is a paid Bound swap (engineering review
  M-08); the app's rate limit is per instance. What bounds the cost: a firewall rule per path at the
  host, spend alerts on the RPC account, and separate keys for the agent API
  (`RPC_URL_AGENTS`, `JUPITER_API_KEY_AGENTS`). Jupiter counts its limits per organisation, not per
  key: the API's Jupiter key has a quota of its own only if it comes from a separate Jupiter account
  (research audit F-10).
- Upstream changes: Jupiter, Pump.fun and Token-2022 are upgraded while Bound runs (on 24 September
  2026 the Pump curve program was half a day old and Jupiter's two days; the canary prints the dates
  each run), and a Jupiter instruction the verifier cannot read stops every swap with `route-format`
  ("waiting for an update"). `node tools/canary.ts` builds and simulates six swaps on mainnet state,
  each with its fee where it belongs (SOL on either side, USDC from the output), one as a v1
  transaction, and Pump.fun buys on the curve and on PumpSwap; it fails on such a change, on a fee
  that is no longer taken where it should be, and exits 2 when nothing could be checked at all
  (engineering review M-09). `.github/workflows/canary.yml` runs it every 30 minutes once the repository
  variable `BOUND_CANARY` is `1` (off by default: on a private repository it would use more than the
  free Actions minutes). The page and the API also log Jupiter refusing Bound's key (401, 403) or
  an endpoint that is gone (404, 410) (research audit F-07, F-08).
- Releases: deploy only tagged commits, and only after CI is green. The release workflow runs the
  typecheck, the tests and the skill bundle's check itself before it publishes a digest. Actions are pinned by commit, and
  a second job builds on another runner image and must match the digest (review FA-10). A tag `v*` publishes the build's digest as a GitHub
  release, built with the public settings in the repository variables, which must match
  production's; the live check compares the site with it every three hours and needs
  `BOUND_SITE_URL`. The build is deterministic: CI builds every commit twice and fails if the two
  digests differ, and a Vercel build takes its build id from the commit.
- No limit per swap: the guarantee is the same for any amount, and nothing in Bound holds funds.
  `BOUND_MAX_USD_PER_SWAP` exists as an operational valve and is unset by default; while it applies
  it is enforced in the page only, and tokens without a USD price are blocked. A large swap is
  limited by the route, not by us: if no route fits inside one transaction, Bound refuses to build
  it rather than splitting the swap (section "What Bound does not protect").
- API routes are stateless: allowlisted RPC methods and Jupiter parameters (`payer` is refused),
  request bodies counted in bytes and capped at
  64 KiB, 15 s timeouts upstream, and no request bodies are stored.
- Rate limits are keyed on the one header the ingress overwrites (`BOUND_CLIENT_IP_HEADER`, default
  `x-vercel-forwarded-for`); no other header is read. They are per instance: set a rate-limit rule in
  the hosting firewall for a limit across instances.

## Reporting

Please report vulnerabilities privately to the maintainers before disclosing them publicly.
