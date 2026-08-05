# Changelog

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
