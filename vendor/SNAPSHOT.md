# Public platform snapshots

Contracts, the bundler, and the typed control-plane client are copied verbatim
from the OpenCloud platform source paths
`packages/{contracts,bundler,control-plane-client}/src`. Structural dashboard,
organisation, and integration contracts are retained because the public
operation type graph imports them; no platform service implementation is copied.
The private operator contracts (`contracts/src/platform-admin*.ts`) and client
(`control-plane-client/src/platform-admin/`) are excluded: the public graph does
not import them, and they depend on private platform packages.

The public CLI owns disk upload/download adapters and manifest serialization in
`src/api-client.ts` and `src/bundle.ts`. Two upstream tests that inspect platform
package metadata/OpenAPI files are excluded from the public Vitest configuration.
All portable upstream contract and transport tests run here.

Browser SDK 2.3 source and tests are copied from platform commit
`d0c223a8f074bcb1c508ed6cc63654a11a5a499a` (`packages/browser-client/src`), including custom-origin session and
Realtime reconnect behavior. Previous immutable SDK artifacts are not changed.
Its `OPEN_CLOUD_SDK_VERSION` is the default for `init` and unpinned bundles, so
this snapshot changes only when the CLI deliberately changes that default.

## CLI 3.11.0 organisation-built integrations

The contract and typed-client snapshots are synchronized from the platform
`design/shareable-integrations` working tree: commit
`b2b9645011aee4567b158bb6d5a4f20bb78eafce` plus its uncommitted
organisation-built integration contracts. The files below differed from that
commit when copied, so these exact source digests identify the snapshot. Every
other vendored contract, typed-client, and bundler file is byte-identical to
that commit. Browser SDK 2.3.0 remains the local default; providers that
declare sync, webhooks, or events explicitly select SDK 2.6.0 on an updated
platform.

| Source under `packages/` | SHA-256 |
| --- | --- |
| `contracts/src/control-plane.ts` | `461689f5f5918d0c0839f4d9878c1966797765741c88baa15589e8bc193e56d7` |
| `contracts/src/custom-integrations.ts` | `5b017e21685cf66659244d8d96050e6854e21d1f08c285cd8106b4bd6e7f9a86` |
| `contracts/src/custom-integrations.test.ts` | `6eb5e593fbd10d3668a4e6ab260f00d0e5a59fb141d0b9996e913fd5d025e32c` |
| `contracts/src/dashboard-integrations.ts` | `1169beac508bd1c8ac6559b10906c35513a7eea3a3b6b2c6f58e60ed018d65f9` |
| `contracts/src/dashboard-routes.ts` | `ae5ec46878cbe8e5c4027d955b6552f6ef1da047e7417ff910d02949449f3f90` |
| `contracts/src/integration-manifest.ts` | `880dfddda74a5020830604d1f97ce50178186b85dfc5393e2416e39011197ac7` |
| `contracts/src/manifest.ts` | `56d86c3b2b761ab77b5d153a175b18e676ee38e91526c15b4742d22601d87908` |
| `contracts/src/manifest.test.ts` | `3a073d8e2faba63a691a3efa8adc99125e2d20d57444de1891e1f25039a400b9` |
