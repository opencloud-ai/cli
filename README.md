# OpenCloud CLI

The public, versioned command-line client for building, validating, deploying,
and verifying applications on [OpenCloud](https://opencloud.ai).

The CLI is intended for coding agents and humans with a terminal. A
browser-only chat that cannot run Node.js and shell commands can prepare an
offline source bundle, but cannot connect to or deploy through OpenCloud.

## Install a pinned release

OpenCloud application skills pin an exact CLI release. To install `v0.6.1` in
an isolated task directory:

```bash
OPENCLOUD_CLI_VERSION="v0.6.1"
OPENCLOUD_CLI_PACKAGE="opencloud-cli-0.6.1.tgz"
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

## Passwordless project onboarding

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

Secrets never need to cross the terminal transcript:

```bash
"$OPENCLOUD_CLI" secret generate "$APP_ID" SESSION_KEY
"$OPENCLOUD_CLI" secret entry-link "$APP_ID" PAYMENT_API_KEY
```

The first command creates a server-generated value. The second returns a
one-time browser URL where the user enters a value directly into OpenCloud.

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
"$OPENCLOUD_CLI" app dev data . /rest/v1/items \
  --method POST --body '[{"title":"Preview item"}]'
"$OPENCLOUD_CLI" app dev invoke . function-name --body '{"example":true}'
"$OPENCLOUD_CLI" app dev requests .
"$OPENCLOUD_CLI" app dev verify .
"$OPENCLOUD_CLI" app dev promote . --idempotency-key "$IDEMPOTENCY_KEY"
"$OPENCLOUD_CLI" app dev receipts .
"$OPENCLOUD_CLI" app dev evidence .
```

Development data is isolated from production and uses dummy records. Auth,
Storage, Realtime, cron, and production secrets are unavailable. Functions
imported from `@opencloud/server` remain dormant until `app dev invoke` or a
deliberate preview interaction calls them. Exact-revision verification requires
every declared Function to have a successful explicit invocation.

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

The lower-level `app smoke` and `app verify-ui` commands remain diagnostic
helpers for platform development; they are not substitutes for `app verify`.

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
