# Releasing the plugin

This file is not shipped (`files` in package.json lists `dist` and `README.md` only).

The plugin is built and tested inside the Orientim repository, with the repository's tools
(rolldown, vitest and TypeScript, declared at its root). Building needs Node 22.18 or later, for
`node build.ts`. The package itself runs on Node 22.

```bash
npm ci                                  # at the repository root: the tools
cd integrations/solana-agent-kit
npm ci --ignore-scripts                 # the Agent Kit, @solana/web3.js and zod, for the tests
npm run typecheck && npm test           # the tests build dist/ and load it both ways
```

CI (`.github/workflows/ci.yml`, job `plugin`) does the same. It then packs the package, installs it
in an empty project with the Agent Kit, and loads it with `import` and with `require`.

## Before the first release

- The owner holds the `@orientim` scope on npm.
- The owner chooses a licence (`license` is `UNLICENSED` until then).
- The owner removes `"private": true`.
- The release is published from a tag, by CI, with `npm publish --provenance`, never from a laptop.
  Its tarball's sha256 is recorded in docs/AUDIT.md.
- The peer ranges are the versions tested: solana-agent-kit 2.0.10, @solana/web3.js 1.99.0,
  zod 3.25.76. Widen them only after testing the older versions.
