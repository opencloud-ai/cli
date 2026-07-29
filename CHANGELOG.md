# Changelog

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
