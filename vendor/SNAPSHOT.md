# Public platform snapshots

Contracts, the bundler, and the typed control-plane client are copied verbatim
from OpenCloud platform commit `b4aa28d639f93001d9f6dfce9a3d2419451d5f1d`.
Their source paths are `packages/{contracts,bundler,control-plane-client}/src`.
Structural dashboard and integration contracts are retained because the public
operation type graph imports them; no platform service implementation is copied.

The public CLI owns disk upload/download adapters and manifest serialization in
`src/api-client.ts` and `src/bundle.ts`. Two upstream tests that inspect platform
package metadata/OpenAPI files are excluded from the public Vitest configuration.
All portable upstream contract and transport tests run here.

Browser SDK 2.3 source and tests are copied from platform commit
`d0c223a8f074bcb1c508ed6cc63654a11a5a499a` (`packages/browser-client/src`), including custom-origin session and
Realtime reconnect behavior. Previous immutable SDK artifacts are not changed.
