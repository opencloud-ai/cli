# Changelog

## 3.2.0

- Validate manifest-declared Postgres-backed queues, their bounded retry and
  concurrency policy, and system-only consumer Functions in local bundles.
- Preserve queue-free schema-2 archive compatibility while including declared
  queues in deterministic artifacts and development capability validation.
- Add `jobs list|get` for retained production depth, created/retried/succeeded/
  failed rollups, inclusive creation-time filtering, cursor pagination, and
  metadata-only job inspection without payloads or idempotency keys.

## 3.1.0

- Add `app email list|get` for filtered, cursor-paginated production message
  diagnostics and authorized retained content inspection.
- Add `app dev email list|get|inject` for provider-free capture and synthetic
  inbound testing, including file-backed text/HTML and bounded attachments.
- Vendor the application-email manifest, control-plane, and bundler contracts
  so aliases, system-only inbound handlers, and email-capable bundles validate
  locally before a development session or deployment.

## 3.0.1

- Include the conventional `tests/opencloud.e2e.js` source in deterministic
  bundles, validate its bounded test contract locally, and expose its immutable
  SHA-256 metadata.
- Require exact-revision external E2E evidence during `app dev verify`, with an
  optional bounded parallelism override, so a missing specification fails
  closed instead of producing a legacy receipt.
- Generate new projects with a deliberately failing external E2E starter that
  agents must replace with the app's primary outcomes before promotion.

## 3.0.0

- Vendor the hard-cut OpenCloud browser SDK 2.0.0 and final schema-2 manifest
  contract. Legacy SDK surfaces and `requiredSecrets` are rejected instead of
  translated.
- Replace raw-path development fixture writes with SDK-shaped table actions:
  `create`, `createMany`, `updateById`, and `deleteById`.
- Make secret intent declarative through `generated`, `required`, and
  `optional` manifest modes. Generated values are provisioned automatically;
  the CLI exposes only explicit `secret rotate` and secure `secret configure`
  workflows.
- Generate new projects with the stable singleton browser SDK and an empty
  declarative secret map.

## 2.0.0

- Make manifest schema 2 the only application contract. Projects now use
  `runtime.sdk`, `files.access`, and Function `access`; schema-1 fields fail
  with focused migration errors instead of being preserved or translated.
- Vendor OpenCloud SDK 1.0.0 and generate apps that import the stable
  `opencloud` singleton from `/_opencloud/sdk.js`.
- Replace deployment and draft response aliases with the canonical
  `sdkVersion` and `artifactFiles` fields, and expose the exact development
  capability contract.
- Generate a working SDK-connected starter with Files enabled and make
  `app sdk-inspect` report only the stable SDK module and declarations paths.
- Remove the partial local smoke, Chromium, session, and runtime-contract
  verification commands. `app verify` is now the single authoritative release
  gate.

## 1.0.0

- Add reusable account login through an explicit browser approval flow with
  `login`, `auth status`, and `logout`; no localhost callback, pasted code, or
  copied credential is required.
- Store rotating account credentials in the operating-system keyring with a
  protected per-user file fallback.
- Add `app create` and `app connect` so one account login can select and work
  across multiple app workspaces using renewable app-scoped credentials.
- Keep non-secret workspace bindings separate from protected credentials and
  retain legacy email onboarding as a compatibility path.
- Add source/artifact checkpoint evidence, runtime-aware SDK warnings, richer
  verification coverage, owner launch URLs, and refreshable typed API tokens.
- Move canonical CLI ownership entirely to this public repository.

## 0.6.1

- Negotiate development-session capabilities with the control plane instead
  of requiring one hard-coded capability vector.
- Accept boolean development capability values so a newly enabled platform
  capability cannot turn a successful response into a client-side schema
  failure.

## 0.6.0

- Add `doctor` with redacted session, endpoint, CLI, and deployed-platform diagnostics.
- Discover the nearest protected session file from nested source directories.
- Add bounded isolated fixture writes with `app dev data`.
- Add durable verification history and redacted exports with `app dev receipts` and `app dev evidence`.
- Surface undeclared conventional migration and Function entrypoint warnings during local validation, dev sync, and deployment.
- Make `app dev promote` follow deployment, run feature-aware production verification, report the live URL, and clean up dev only after success.

## 0.5.0

- Add isolated app development sessions with stable preview URLs, migration-replayed dummy databases, immutable revisions, and correlated diagnostics.
- Add `app dev start|sync|status|request|invoke|requests|verify|promote|stop`.
- Require successful explicit invocation of every dormant development Function before exact-revision verification.
- Promote only the verified receipt and refuse stale source, migration, or production-base revisions.
- Vendor the public dev-environment API contracts and bundler safeguards for the reserved `.opencloud` runtime directory.

## 0.4.0

- Add `agent-feed` for the stable, bounded app health, signal, alert, and
  recent-event contract.
- Add `alert-rule list|put|delete` for app-scoped fixed-window custom metric
  alert rules.
- Vendor the JavaScript SDK 0.2.2 custom counter/gauge contract and the updated
  control-plane/OpenAPI operation registry.

## 0.3.0

- Converge terminal deployment on the canonical control-plane registry,
  generated OpenAPI contract, shared typed client, and shared deterministic
  bundler.
- Add server-hosted source drafts with revision and base-hash guards,
  authoritative validation, exact digest matching, and validated-draft deploy.
- Add durable `app verify` with server-side HTTPS, SDK-pin, health, and
  Chromium verification.
- Support multiple apps from a provisional 24-hour account and automatic
  pause/resume after email expiry/verification.
- Add server-generated secrets and one-time browser entry links; remove
  plaintext secret setting from the CLI.
- Remove unsupported archive, unarchive, and restart commands from the
  canonical CLI surface.

## 0.2.1

- Make `opencloud.ai` the default hosted OpenCloud API and documentation
  domain.
- Keep existing explicit API URLs and saved sessions compatible with the
  previous domain during the hosted-service migration.

## 0.2.0

- Add zero-copy passwordless agent onboarding for new OpenCloud users and
  projects.
- Generate readable collision-resistant app addresses on the server.
- Gate existing-email requests on explicit 24-hour email confirmation.
- Store app-scoped credentials and completion secrets in an ignored mode-0600
  workspace session file instead of printing them.
- Preserve the onboarding idempotency key locally so failed requests retry
  without creating duplicate users or projects.
- Infer `init --app-id` from the onboarded workspace.

## 0.1.0

- First standalone OpenCloud CLI release.
- Build deterministic application bundles.
- Deploy and follow durable operations.
- Inspect applications, releases, logs, metrics, usage, secrets, cron, and
  backups.
- Run edge smoke, UI, session, and feature-aware runtime verification.
