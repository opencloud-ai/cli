# Repository guidance for coding agents

## Source ownership

- This repository is the sole editable source for the public, versioned
  `opencloud` application CLI.
- `opencloud-ai/platform` owns the control-plane API and server implementation,
  but must consume published CLI releases rather than carrying a second CLI
  source tree.
- The private `opencloud-platform` deployment operator is a separate program
  and remains in the platform repository.

## Contract snapshots

- `vendor/` contains the exact public contract, JavaScript SDK, bundler, and
  typed-client snapshots required by this CLI release. Update the relevant
  snapshot, CLI source, and tests together when a platform contract changes.
- Do not import or copy unrelated platform internals into this public package.

## Releases

- Keep `package.json`, `src/index.ts`, `CHANGELOG.md`, and the Git tag on the
  same semantic version. Run `npm run verify:version` before release.
- Run tests, typechecking, the standalone build, and a packed-package smoke
  test before tagging. Publish this repository first; only then update the
  platform repository's exact release pin.
- Never commit credentials, tokens, browser cookies, or generated credential
  stores.
