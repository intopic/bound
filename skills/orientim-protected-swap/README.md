# Orientim protected swap

Swap Solana tokens from a wallet your agent or bot controls, so that the swap's route can only
touch the amount you approve (any token Orientim's checks accept; others are refused with the reason). Orientim builds the transaction; this folder checks it on **your own
RPC** before your wallet signs, and reads the outcome on the chain.

```bash
npm ci               # the one dependency, @solana/kit 8.3.0, as the lockfile pins it (Node 22.18 or later)
```

- **Agents** (Claude and other coding agents): `SKILL.md` is the skill. `examples/swap.ts` is the
  whole flow, with recovery after a stop and one worker per wallet.
- **Bots in JavaScript or TypeScript**: import `protectedSwap` from `examples/swap.ts`. A wallet held
  by a signing service works through `signerFromSignBytes` or `signerFromSignTransaction`.
- **Bots in Python, Rust, Go...**: `bin/orientim-verify.mjs` (see "Bots in other languages" in
  `SKILL.md`). The bot signs one message with its own key; the command does the rest.
- **The API itself**: `reference/AGENT-API.md`.

You need an API key from Orientim (`ORIENTIM_API_KEY`) and an RPC of your own (`SOLANA_RPC_URL`). Never
put a wallet key in a prompt, a message, a log or a command line.

**Check your copy before it signs anything.** `SHA256SUMS` lists the hash of every file here, and
Orientim's site serves the same list at `/skill/SHA256SUMS`: compare the two, then run
`sha256sum -c SHA256SUMS` in this folder (on Windows, `Get-FileHash` on each file). `npm ci` installs
exactly the versions in `package-lock.json`, each checked against its recorded hash.

Contents: `lib/orientim-verify.mjs` is Orientim's verifier, bundled; `bin/orientim-verify.mjs` the command;
`src/` their sources. Orientim's fee (0.3%) and treasury are pinned in the check: a swap that charges
more or pays anyone else is refused before your wallet signs.
