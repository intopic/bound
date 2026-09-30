# Running the agent API

For whoever runs an Orientim deployment. Integrators read `AGENT-API.md`, which is also the
reference inside the skill download; nothing here is published with it.

## Turning it on

The API is off unless the deployment sets `ORIENTIM_API_SECRET` and `ORIENTIM_API_KEYS`
(`node tools/agent-key.ts --secret` and `node tools/agent-key.ts <id>` make them; only a hash of
each key is stored). Keys issued by hand keep working beside self-serve keys.

Optional: `ORIENTIM_API_SECRET_PREVIOUS` while rotating the secret, `ORIENTIM_API_FEE_BPS`,
`ORIENTIM_API_PER_MINUTE` (60 by default). The kill switch `ORIENTIM_DISABLED=1` stops both
endpoints. A prepare with `version: 1` is served only where `NEXT_PUBLIC_ORIENTIM_ENABLE_V1=1`.
Every setting is listed in `apps/web/lib/server/agent/config.ts`.
Keep `ORIENTIM_API_FEE_BPS` at or below 30 and no higher than `NEXT_PUBLIC_ORIENTIM_FEE_BPS`;
the API fails closed otherwise. The public fee setting also has a 30 bps maximum.

## Self-serve keys

`ORIENTIM_KEY_SECRET` turns them on. The key message always names `ORIENTIM_PUBLIC_ORIGIN`,
whatever host a request claims. A key is revoked by its wallet: `ORIENTIM_API_REVOKED` lists
`<wallet>` (all its keys) or `<wallet>@<unix seconds>` (its keys issued until then, so that the
wallet's owner can sign again for a new one).

## Pausing, revoking and rotating

The kill switch `ORIENTIM_DISABLED=1` refuses both agent endpoints, prepare and finalize. **On Vercel
an environment change reaches only new deployments**, so flipping it in the dashboard does nothing
until a redeploy. The runbook:

1. Keep a paused deployment ready: deploy the current release once more with `ORIENTIM_DISABLED=1`
   and leave it unpromoted. Rebuild it with every release.
2. To pause: promote that deployment (dashboard, "Promote to Production", or `vercel promote <url>`),
   which takes seconds. To resume: promote the normal deployment back ("Instant Rollback").
3. Revoking an API key or rotating `ORIENTIM_API_SECRET` is a redeploy; for an urgent revocation,
   pause first (step 2), then redeploy with the key removed. A self-serve key is revoked by its
   wallet in `ORIENTIM_API_REVOKED` (section above). Rotating `ORIENTIM_KEY_SECRET` ends every
   self-serve key at once: every agent must sign again (the skill does it by itself, a key stored by
   hand stops working). Moving the old secret to `ORIENTIM_KEY_SECRET_PREVIOUS` keeps them working
   while agents move over.
4. Rehearse it once on a preview: promote, check that `/api/status` says `enabled: false` and that a
   prepare is refused with `503 paused`, promote back, and write down how long each step took.

## The treasury

The treasury only receives fees. Its key never touches the server and never signs a swap; keep it
on a hardware wallet or a multisig (e.g. Squads), with its USDC and USDT accounts open. If its key
is compromised, the key can take the fees it holds and nothing else. Then:

1. Stop sending fees there: pause (runbook above, step 2).
2. Move what is left to a safe wallet, if the key is still yours.
3. Make a new treasury, with its USDC and USDT accounts. Put it in `NEXT_PUBLIC_ORIENTIM_TREASURY`
   (in Vercel and in the repository variables) and in the skill (`ORIENTIM_TREASURY` in
   `skills/orientim-protected-swap/src/verify.ts`), then rebuild the skill. Agents refuse a fee to
   any treasury but the one pinned in their copy of the skill.
4. Release, redeploy and promote. Agents on an older copy of the skill refuse every swap until they
   update, so raise `ORIENTIM_MIN_SKILL_VERSION` to the new skill's version and tell them.
5. Record the old and the new address, with the date of the change.

## Cost and monitoring

- Orientim's RPC and Jupiter quota are spent only through the agent API, and the app's rate limit is
  per instance. What bounds the cost: a rate-limit rule per path in the hosting firewall, spend
  alerts on the RPC account, and, if wanted, separate keys for the agent API (`RPC_URL_AGENTS`,
  `JUPITER_API_KEY_AGENTS`). Jupiter counts its limits per organisation, not per key.
- Rate limits are keyed on the one header the ingress overwrites (`ORIENTIM_CLIENT_IP_HEADER`,
  default `x-vercel-forwarded-for`); no other header is read.
- Upstream programs (Jupiter, Pump.fun, Token-2022) are upgraded while Orientim runs, and a Jupiter
  instruction the verifier cannot read stops every swap with `route-format`. `node tools/canary.ts`
  builds and simulates swaps on mainnet state and fails on such a change or on a fee that is no
  longer taken where it should be, and exits 2 (incomplete, not a pass) when a market it promises,
  such as a Pump.fun curve or PumpSwap, could not be proven that run. `.github/workflows/canary.yml` runs it every twelve hours once
  the repository variable `ORIENTIM_CANARY` is `1` and the secrets `CANARY_RPC_URL` and
  `CANARY_JUPITER_API_KEY` are set. Until then, and until `ORIENTIM_SITE_URL` is set for the live
  check, nothing watches production.
- `/api/status` shows the kill switch only; `/api/health` checks the RPC and Jupiter, that the
  agent API is on (`agentApi`), the API's own RPC (`RPC_URL_AGENTS`, or the site's) and a small swap
  Jupiter builds with the API's own key (`JUPITER_API_KEY_AGENTS`, or the site's). An agent API left
  off by the settings (a missing secret or keys, a fee above 30 bps) is `agentApi: "off"` and 503; a
  pause by the kill switch is `paused: true` and stays 200. An uptime monitor on `/api/health` every
  few minutes, alerting on 503, covers outages.

## Verifying the code you are running

**The build is reproducible.** `ORIENTIM_BUILD_ID=<commit> npm run build && node tools/build-digest.ts`
prints one hash over every file the browser can load from `/_next/static`. Two builds of the same
commit produce the same hash (CI proves it for every release tag by building twice), so the digest
published with a release can be compared against a build made from the source.

**The live site is compared with the release.** A tag `v*` publishes a GitHub release with
`build-digest.txt`, the hash of every file for that commit (`.github/workflows/release.yml`), built
with the public settings in the repository variables, which must match production's
(`NEXT_PUBLIC_ORIENTIM_TREASURY`, `NEXT_PUBLIC_ORIENTIM_FEE_BPS`). Every six hours
`tools/check-live.ts` fetches each of those files from the site and fails if one differs, if a page
refers to a static file the release does not have, or if a page loads a script from anywhere else
(`.github/workflows/live-check.yml`). The same check runs by hand:
`node tools/check-live.ts --site <url> --manifest build-digest.txt`.

Deploy only tagged commits, and only after CI is green. Before tagging a release, run the Fuzz, CPI
and Canary workflows by hand on the commit to be tagged, and stop the release if one fails.

## Further reading

Threat model: `SECURITY.md`.
