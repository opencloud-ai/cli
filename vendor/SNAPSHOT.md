# Public platform snapshots

## CLI 3.21.0 container compute

Public Contracts and control-plane client files needed by this release are
verbatim snapshots from accepted platform commit `f7249b1c`; the compute price
catalog, settings projection and installed SDK test are from `0f8cb1b0`.
The bundler and compute-protocol files are from `78d17bf5`. Browser and Function
SDK source/tests are from `68650784` (SDK 2.8.0); immutable older SDK artifacts
are untouched. The CLI does not take its default SDK from this snapshot:
`@opencloud/js` resolves to the CLI-owned `src/sdk-version.ts`, which
re-exports the vendored browser client but sets `OPEN_CLOUD_SDK_VERSION`, the
version the vendored bundler gives an unpinned manifest, per manifest: 2.3.0
(CLI 3.20's default, which every supported OpenCloud installs, and what
`init` pins), or 2.8.0 when the manifest declares containers.
Unrelated brand and installer snapshots retain their previous provenance.

The final candidate refresh takes `contracts/src/containers.ts` and its tests
from platform `37f2ad50`, including exact 413/431 ingress errors and JSON Schema
serialization with unchanged normalized payloads. `compute-protocol/src/index.ts`
and its tests are from `3ccc51f2`, including the required explicit null-or-pinned
digest for guarded unresolved image retention release. These files are also
verbatim; private platform administration and MCP implementation are not vendored.
`contracts/src/control-plane.ts` and its tests are refreshed from `56448bad` so
alert detail can retain container metric provenance while Feed v1 stays unchanged.
The final resource-sampling refinement takes `compute-protocol/src/index.ts`,
its tests and `contracts/src/compute-observation.ts` verbatim from `b17c3617`.
Optional running/terminal metadata preserves each counter's measurement time;
older samples remain valid without inferred per-counter timestamps.
`contracts/src/containers.ts` and its tests are subsequently refreshed verbatim
from `ef62035c`: service-body Base64 validation uses bounded linear work and
checks the decoded 32 MiB limit without a repeated-group regex stack overflow.
`compute-protocol/src/index.ts` and its tests are subsequently refreshed verbatim
from `ff05f2af`. Retired allowances with lost counters have explicit null byte
measurements and separate full daily-quota forfeiture; measured receipts remain
readable. This internal transport refinement adds no public CLI authority.
The same two files are refreshed verbatim from `b21f1d1e` to distinguish proven
never-started allowances with explicit `unused` accounting. Lost counters still
require forfeiture; neither receipt is a diagnostic byte measurement.
`contracts/src/containers.ts` and its tests are then refreshed verbatim from
platform `8c99de9df` (`feat/container-runtime-exploration`, after the
container usability fixes): executions carry a required, nullable
`waitReason`; the catalog adds `COMPUTE_HOST_UNAVAILABLE`, `COMPUTE_NOT_LIVE`,
`COMPUTE_RELEASE_REPLACED` and `COMPUTE_CAPABILITY_INVALID`; and a Function's
request body to a service is capped at 4 MiB while responses keep 32 MiB.
Failed jobs' `details.exitCode` and `details.signal` were already optional
fields of the error details.
The same file is refreshed again verbatim from platform `da2040de5`: the
catalog adds `COMPUTE_NOT_OFFERED`, `COMPUTE_METRIC_INVALID`,
`COMPUTE_METRIC_LIMIT`, `COMPUTE_OUTPUT_DIRECTORY_MISSING` and
`COMPUTE_FUNCTION_FAILED` (which replaces `COMPUTE_UPSTREAM_FAILED` on
container capability calls), and error details gain an optional
`upstreamStatus`. Its tests are unchanged. `server/src/index.ts` and its
tests, the Function SDK 2.8.0 source, are refreshed verbatim from the same
commit: its container types name `waitReason` and every catalog code (a test
compares them with this catalog), and it refuses a service request body over
4 MiB, as the contract does. The CLI bundle does not import the Function SDK.
`contracts/src/{compute-control-plane.ts,containers.ts,control-plane.ts}` and
`control-plane-client/src/browser.test.ts` are then refreshed verbatim from
platform `2858c4d11` (`feat/container-runtime-exploration`): pause, resume,
restart and scale answer with `computeControlReceiptSchema` (`workloadName`,
the new `generation` and `acceptedAt`), which replaces
`computeOperationReceiptSchema` and its `operationId`, because the change
commits at once and has no operation to follow. The log page's `surface`
filter documents the accepted names and aliases; its shape is unchanged.
Upstream `compute-observation.test.ts` and `control-plane-client/src/compute.test.ts`
also changed in that range and are still not copied: they import the private
administrator contracts and client. The CLI's own tests and
`test:contract` read the new receipt instead.
`contracts/src/control-plane-browser.ts` and
`compute-protocol/src/{index.ts,index.test.ts,host-quiescence.test.ts}` are
then refreshed verbatim from platform `3fcfd7251` (the same files as at
`2858c4d11`), which the 3.21 candidate had drifted from: the browser entry
exports the `ComputeInstanceDiagnostics` type, and the protocol carries the
platform's current internal transport. The symbols the vendored contracts
import from it keep their shapes. The trimmed `package.json` stubs and the
brand and installer snapshots keep their earlier provenance.

Validation waiting takes `contracts/src/control-plane.test.ts` and
`control-plane-client/src/{node.ts,browser.ts,browser-entry.test.ts,draft-validation.ts,draft-validation.test.ts}`
verbatim from accepted platform `151106e207ee5c872bdbdecbbb13a2c05fcdc3c0`.
`contracts/src/control-plane.ts` and
`control-plane-client/src/development-readiness.test.ts` are verbatim from
accepted platform `03bee78b8da592d638bf1565b1c11845c71a50cd`, adding the exact
validation progress contract and documented development readiness allowance.
The platform source prefix for these paths is `packages/`; the CLI prefix is
`vendor/`. The CLI's durable mutation recovery remains in its own `src/`.
`contracts/src/{control-plane.ts,api.ts}` and
`control-plane-client/src/browser.test.ts` are then refreshed verbatim from
platform `ea8759cf4` (`feat/container-runtime-exploration`): log page entries
keep the optional `fields` a Function logged. The same files bring the
platform's compute-off operation views (used by MCP only), Agent Feed v2
schemas factored into named parts with unchanged shapes, and its current
draft validation descriptions; no parsed shape the CLI reads changes.

The Contracts public type graph requires the exact `model-choices`, `reasoning`,
`identifiers`, `task-preparation`, and `platform-ai` Agent protocol files from
`f7249b1c`. The CLI-owned `src/agent-protocol-snapshot.ts` facade exports only
their public credential-free dependencies; no Agent service implementation is
included. The public package still contains only the standalone bundle and
release documents.

Portable compute, manifest, transport and SDK tests run locally. Upstream
`compute-control-plane.test.ts` and `compute-observation.test.ts` are not copied
because they import private administrator contracts. The copied feature flag
test also requires private administrator contracts, and installation-section
tests compare a platform docs build copy, so Vitest excludes those alongside
the existing platform packaging tests. `src/compute.test.ts` and
`scripts/compute-http-contract.mjs` cover public compute validation, routes,
session isolation, immutable replay, errors, logs and Feed behavior here.

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

## CLI 3.12.0 SDK 2.7.0

The contract, typed-client, and bundler snapshots are copied from platform
commit `c349f235cce46738dc38a24939d39b31e5c50c6a` (pull request #363), which
adds SDK 2.7.0 to the installed manifest versions. Every vendored contract,
typed-client, and bundler file is byte-identical to that commit. Browser SDK
2.3.0 remains the local default. The brand, installer, and installation tests
read platform files (`SKILL.md`, `install.sh`, brand assets, private admin
contracts) and are excluded from the public Vitest configuration like the
earlier platform-only checks.

## CLI 3.13.0 release source and platform builds

The contract, typed-client, and bundler snapshots are copied from platform
commit `f762d21b7c0da56d339046aba22100282f17f718` (pull request #378). It
contains pull request #374, which keeps each release's draft source, adds the
release source and artifact downloads, and accepts
`expectedActiveDeploymentId` on deploys and dev starts, and #378 itself, which
builds a frontend that declares `frontend.build` during validation and lets a
local bundle leave that frontend out. `contracts/src/ai-capacity.ts` is new
because the public operation type graph now imports it. Every vendored
contract, typed-client, and bundler source file is byte-identical to that
commit. Browser SDK 2.3.0 remains the local default.

## CLI 3.14.0 signed-in identity

The contract, typed-client, and bundler snapshots are copied from platform
commit `f08e2e699c4b5b35df507525454cb93cf356368b` (pull request #404), which
adds `GET /v1/auth/identity` (`getCurrentIdentity`). It also brings the
contracts merged since #378 (organisation billing, brand packs, organisation
directory, and installation capabilities). Every vendored contract,
typed-client, and bundler source file is byte-identical to that commit.
Browser SDK 2.3.0 remains the local default.

## CLI 3.19.0 executable Agent tasks

`contracts/src/agent-tasks.ts`, `contracts/src/manifest.ts` and their tests are
copied from platform commit `6854d1edef741987727cd33223f1394597171a0b`
(pull request #480), which lets an Agent task name a declared `access: system`
Function as its `entrypoint` instead of static `instructions`. Those four files
are byte-identical to that commit. The manifest file also carries that
commit's `latestCronOccurrence` helper, which the CLI does not use. Every other
vendored file stays as in the 3.14.0 snapshot (platform commit
`f08e2e699c4b5b35df507525454cb93cf356368b`). Browser SDK 2.3.0 remains the
local default.
