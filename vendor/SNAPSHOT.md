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

## CLI 3.10.0 task compatibility

The task, search and file-job contracts are synchronized from the platform
agent-task branch at `d0d692d7`, which includes current main.
These exact source digests identify the snapshot.
Other vendored files retain their provenance above. Browser SDK 2.3.0 remains
the local default; task apps explicitly select SDK 2.5.0 on an updated platform.

| Source under `packages/` | SHA-256 |
| --- | --- |
| `contracts/src/manifest.ts` | `45f7c2159f5eb354ddba176056bbe5127f0d81588122b902940349f2d47b3912` |
| `contracts/src/index.ts` | `97224eede02775810fb6818812691392df1bd1fb2019c05e583ead26225143fc` |
| `contracts/src/agent-tasks.ts` | `27e1db73014c9932722ca137f820977bd1582092c99aa50521e15c95762723cd` |
| `contracts/src/data-search.ts` | `cc620ee6a25c8f1374bf77d00419aef2ebaa139b2387112618d0c8e946633601` |
| `contracts/src/job-file-delegation.ts` | `ade94687a0009ebfcaf053810ed523ef79159d8d65f25b2538dc4b1055b05ab0` |
