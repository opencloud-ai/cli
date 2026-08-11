# OpenCloud CLI

The public, versioned command-line client for building, validating, deploying,
and verifying applications on [OpenCloud](https://opencloud.ai).

This repository is the sole editable source for the application CLI. The
platform repository consumes exact published releases.

The CLI is intended for coding agents and humans with a terminal. A
browser-only chat that cannot run Node.js and shell commands can prepare an
offline source bundle, but cannot connect to or deploy through OpenCloud.

## Install a pinned release

OpenCloud application skills pin an exact CLI release. To install `v3.0.1` in
an isolated task directory:

```bash
OPENCLOUD_CLI_VERSION="v3.0.1"
OPENCLOUD_CLI_PACKAGE="opencloud-cli-3.0.1.tgz"
OPENCLOUD_CLI_DIR="$(mktemp -d)"

curl -fsSLo "$OPENCLOUD_CLI_DIR/$OPENCLOUD_CLI_PACKAGE" \
  "https://github.com/opencloud-ai/cli/releases/download/$OPENCLOUD_CLI_VERSION/$OPENCLOUD_CLI_PACKAGE"
curl -fsSLo "$OPENCLOUD_CLI_DIR/checksums.txt" \
  "https://github.com/opencloud-ai/cli/releases/download/$OPENCLOUD_CLI_VERSION/checksums.txt"

(
  cd "$OPENCLOUD_CLI_DIR"
  sha256sum --check --ignore-missing checksums.txt
  npm install --ignore-scripts --no-audit --no-fund \
    "./$OPENCLOUD_CLI_PACKAGE"
)

OPENCLOUD_CLI="$OPENCLOUD_CLI_DIR/node_modules/.bin/opencloud"
"$OPENCLOUD_CLI" --cli-version
```

## Account login and workspace connection

Sign in to an existing account through an explicit browser approval, then
select an app and connect its source directory:

```bash
"$OPENCLOUD_CLI" auth status
"$OPENCLOUD_CLI" login
"$OPENCLOUD_CLI" app list
cd /absolute/path/to/app
"$OPENCLOUD_CLI" app connect "$APP_ID"
"$OPENCLOUD_CLI" doctor
```

`login` prints and opens a short-lived HTTPS approval page. The user signs in
with a one-time email link or configured password and explicitly allows the
CLI. It does not start a localhost callback or ask anyone to paste a code,
email link, cookie, password, or token. Use `login --no-browser` when the
terminal cannot open a browser, or `login --force` to replace an unusable
stored login.

The 15-minute account access token and rotating 30-day refresh token are stored
in the operating-system credential service under `ai.opencloud.cli`. A
headless environment without a usable keyring falls back to a mode-`0600`
per-user credential file under the normal OpenCloud configuration directory.
Never inspect, print, copy, upload, or commit either credential backend.

The account credential can list, inspect, and create apps, but it cannot build
or deploy them. `app connect` writes only a non-secret `.opencloud/app.json`
binding and stores a separate renewable 24-hour app credential in the protected
backend. This lets later terminal sessions reuse the account login and lets one
user work safely across multiple app directories.

```bash
# Only when the requested app does not already exist:
"$OPENCLOUD_CLI" app create \
  --name "Family tasks" \
  --visibility private

# Revoke the login family and derived workspace credentials:
"$OPENCLOUD_CLI" logout
```

## Passwordless project onboarding

For a new project, agents can request passwordless onboarding directly. For an
existing account, use `login` and `app connect`.

Give the CLI the user's email and agreed project title:

```bash
"$OPENCLOUD_CLI" onboard \
  --email person@example.com \
  --name "Family tasks" \
  --visibility private
```

OpenCloud selects the app address from the title and adds a six-character
random suffix.

- A new email gets a provisional account, project, and 24-hour app credential
  immediately. The user confirms the Resend email within 24 hours.
- An existing email gets no credential until its owner confirms the emailed
  request. Then run `"$OPENCLOUD_CLI" onboard-complete`.

The CLI stores the short-lived secret in `.opencloud/session.json`, creates a
protective `.gitignore`, and forces mode `0600`. Never read, print, copy, or
commit that session file. Commands use it automatically:

```bash
"$OPENCLOUD_CLI" app list
"$OPENCLOUD_CLI" app get "$APP_ID"
"$OPENCLOUD_CLI" doctor
"$OPENCLOUD_CLI" init /absolute/path/to/app --version 2026.07.29-1
"$OPENCLOUD_CLI" artifact-check /absolute/path/to/app \
  --expect-app-id "$APP_ID" \
  --max-files 4
"$OPENCLOUD_CLI" validate /absolute/path/to/app
"$OPENCLOUD_CLI" deploy /absolute/path/to/app
"$OPENCLOUD_CLI" app verify "$APP_ID"
```

`deploy` uses the canonical server draft, file-change, validation, and
deployment contract. It refuses deployment when the local and server bundle
digests differ. For normal agent work, prefer the isolated development and
verified-promotion flow below.

The provisional account may create multiple apps during its 24-hour window.
If the email remains unverified when that window ends, OpenCloud pauses every
linked app, function, and cron schedule while preserving data and releases.
Email verification resumes them.

Declare secret intent in `opencloud.yaml`; values never cross the terminal
transcript:

```yaml
secrets:
  SESSION_KEY: generated
  PAYMENT_API_KEY: required
  ORGANIZATION_LABEL: optional
```

Generated values are provisioned automatically. Use these commands only to
rotate a generated value or securely configure a required/optional value:

```bash
"$OPENCLOUD_CLI" secret rotate "$APP_ID" SESSION_KEY
"$OPENCLOUD_CLI" secret configure "$APP_ID" PAYMENT_API_KEY
```

Rotation never returns the generated value. Configuration returns a one-time
browser URL where the owner enters a value directly into OpenCloud.

Existing installations can still supply `OPENCLOUD_API_URL` and
`OPENCLOUD_TOKEN` explicitly.

See the [OpenCloud CLI reference](https://docs.opencloud.ai/reference/cli) and
[agent guide](https://docs.opencloud.ai/getting-started/agents).

## Isolated development environments

Use the stable capability preview and isolated migration-replayed database before changing production:

```bash
"$OPENCLOUD_CLI" app dev start .
"$OPENCLOUD_CLI" app dev sync .
"$OPENCLOUD_CLI" app dev request . /
"$OPENCLOUD_CLI" app dev data . items create \
  --values '{"title":"Preview item"}'
"$OPENCLOUD_CLI" app dev data . items updateById \
  --id "$ITEM_ID" --values '{"title":"Updated preview item"}'
"$OPENCLOUD_CLI" app dev invoke . function-name --body '{"example":true}'
"$OPENCLOUD_CLI" app dev requests .
"$OPENCLOUD_CLI" app dev verify . --parallelism 5
"$OPENCLOUD_CLI" app dev promote . --idempotency-key "$IDEMPOTENCY_KEY"
"$OPENCLOUD_CLI" app dev receipts .
"$OPENCLOUD_CLI" app dev evidence .
```

Development data is isolated from production and uses dummy records. Auth,
Files, and Functions are available; Realtime and cron are not. Manifest-
generated secrets receive isolated synthetic development values, while owner-
configured required values remain unavailable and optional values may be
absent. Functions
imported from `@opencloud/server` remain dormant until `app dev invoke` or a
deliberate preview interaction calls them. Exact-revision verification requires
every declared Function to have a successful explicit invocation and runs the
immutable `tests/opencloud.e2e.js` specification. The conventional test source
stays outside `frontend.directory`, is included in the deterministic artifact,
and must use only the bounded `@opencloud/test` UI fixtures.

`app dev promote` is the completion path: it deploys only the verified receipt,
follows the durable production operation, runs feature-aware production
verification, prints the live HTTPS URL, and removes the dev environment only
after success. If deployment or verification fails, dev remains available for
repair.

## Agent Feed and alert rules

Read the stable app health, signal, alert, and recent-event contract without
depending on internal Prometheus, Loki, or Grafana APIs:

```bash
"$OPENCLOUD_CLI" agent-feed "$APP_ID"
"$OPENCLOUD_CLI" alert-rule list "$APP_ID"
"$OPENCLOUD_CLI" alert-rule put "$APP_ID" too-many-overdue \
  --name "Too many overdue tasks" \
  --metric overdue_tasks \
  --aggregation latest \
  --operator gt \
  --threshold 10 \
  --window 15m
```

Custom metrics and rules are bounded platform contracts. Alerts inform an
agent; they do not authorize automatic rollback or destructive repair.

## Verification

`app verify` is the authoritative durable release gate. OpenCloud runs health,
exact runtime metadata, SDK-pin, HTTPS, Chromium diagnostics, and the
app-declared interaction contract on the server:

```bash
"$OPENCLOUD_CLI" app verify "$APP_ID"
```

CLI v3 has one release-verification command. The former local smoke, Chromium,
session, and verification-contract commands were removed so agents cannot
mistake a partial diagnostic for the authoritative gate.

## Develop

```bash
npm ci
npm test
npm run typecheck
npm run build
node dist/index.cjs --cli-version
```

The release bundle contains the exact OpenCloud manifest contracts and
JavaScript SDK version used by that CLI release. Release tarballs are generated
from tags and accompanied by SHA-256 checksums.
