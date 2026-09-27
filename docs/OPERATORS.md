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

## Self-serve keys

`ORIENTIM_KEY_SECRET` turns them on. The key message always names `ORIENTIM_PUBLIC_ORIGIN`,
whatever host a request claims. A key is revoked by its wallet: `ORIENTIM_API_REVOKED` lists
`<wallet>` (all its keys) or `<wallet>@<unix seconds>` (its keys issued until then, so that the
wallet's owner can sign again for a new one).

## Further reading

Threat model: `SECURITY.md`.
