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

The contract, typed-client, and bundler snapshots are copied from platform
commit `710446e3e6b8a604f077ba95911ff4ba7f7ca057` (merged in pull request
#330), which contains the organisation-built integration contracts and the
bundler check that each Function's relative imports stay inside its own
directory. Every vendored contract, typed-client, and bundler file is
byte-identical to that commit. Browser SDK 2.3.0 remains the local default;
providers that declare sync, webhooks, or events explicitly select SDK 2.6.0
on an updated platform.
