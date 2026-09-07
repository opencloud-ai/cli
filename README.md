# OpenCloud CLI

The public, versioned command-line client for building, validating, deploying,
and verifying applications on [OpenCloud](https://opencloud.ai).

This repository is the sole editable source for the application CLI. The
platform repository consumes exact published releases.

The CLI is intended for coding agents and humans with a terminal. A
browser-only chat that cannot run Node.js and shell commands can prepare an
offline source bundle, but cannot connect to or deploy through OpenCloud.

## Install a pinned release

OpenCloud application skills pin an exact CLI release. To install `v3.8.2` in
an isolated task directory:

```bash
OPENCLOUD_CLI_VERSION="v3.8.2"
OPENCLOUD_CLI_PACKAGE="opencloud-cli-3.8.2.tgz"
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

`app create` runs before an app-scoped recovery journal exists, so it requires
a caller-stable `--idempotency-key`; reuse that key only for retries of the
same create request. `app connect` is an unkeyed credential exchange. If its
response is lost before protected storage completes, the bounded 24-hour
credential may remain orphaned until expiry and rerunning connect mints a
replacement.

```bash
# Only when the requested app does not already exist:
"$OPENCLOUD_CLI" app create \
  --name "Family tasks" \
  --visibility private \
  --idempotency-key "$IDEMPOTENCY_KEY"

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
  immediately. The user confirms the OpenCloud email within 24 hours.
- An existing email gets no credential until its owner confirms the emailed
  request. Then run `"$OPENCLOUD_CLI" onboard-complete`.

The CLI stores the short-lived secret in `.opencloud/session.json`, creates a
protective `.gitignore`, and forces mode `0600`. Never read, print, copy, or
commit that session file. Commands use it automatically:

```bash
"$OPENCLOUD_CLI" app list
"$OPENCLOUD_CLI" app get "$APP_ID"
"$OPENCLOUD_CLI" doctor
"$OPENCLOUD_CLI" init /absolute/path/to/app
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

New projects use manifest schema 3 and omit a top-level release version;
OpenCloud assigns that version while promoting the immutable artifact. Pass
`init --version <legacy-version>` only when intentionally creating a
schema-2-compatible source tree.

## Exact-app owner operations

CLI 3.7 provides public command parity for an exact-app owner Agent: app lifecycle
and access changes, source drafts, production data and Function execution,
streamed managed Files, integration bindings, visitors, and durable operation
recovery. Run `opencloud <group> --help` for the bounded command contract.

Mutation commands that return an operation follow it to terminal success by
default. Use `--no-follow` to retain the accepted operation immediately, and
recover an interrupted or timed-out wait without repeating the mutation:

```bash
"$OPENCLOUD_CLI" operation get "$OPERATION_ID" --follow \
  --interval 2 --timeout 300
"$OPENCLOUD_CLI" operation list "$APP_ID" --limit 50
```

Reuse one `--idempotency-key` for retries of the same intended effect. Every
success emits one compact JSON document; failures emit redacted structured JSON
and exit non-zero. `secret set` reads only standard input. `app
credential-create` requires `--token-file`, refuses overwrite, writes the
one-time token with mode `0600`, and never includes it in command output.

Mutations are retained in a protected local recovery journal. Agent runtimes
set `OPENCLOUD_MUTATION_JOURNAL_DIR` to the dedicated persistent Linux mount at
`/workspace/.opencloud/agent-mutations`; the CLI verifies the exact mount,
rejects symlinked components, retains inode-anchored journal directories, and
binds unresolved work to the exact API base, app, runtime root, and credential
family before replay. Human use remains portable and defaults to the nearest
connected workspace, or the protected OpenCloud configuration directory when
no workspace exists. All development start/sync/promote/stop workflows also
share one stale-recoverable cross-process lock so a completed stop cannot race
with a late state write. Journal files contain only opaque digests, idempotency
keys, and server coordinates—never credentials, request bodies, email
addresses, secret fingerprints, bearer URLs, or absolute source paths. The
journal guarantee applies to exact-app mutations. Account OAuth,
passwordless legacy onboarding, app creation, and app connection are separately
audited authority/bootstrap boundaries with the recovery limits described
above.

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
"$OPENCLOUD_CLI" app dev email inject . \
  --to support --from customer@example.test \
  --subject "Test request" --text "Please acknowledge this message."
"$OPENCLOUD_CLI" app dev email list .
"$OPENCLOUD_CLI" app dev email get . "$MESSAGE_ID"
"$OPENCLOUD_CLI" app dev notifications list .
"$OPENCLOUD_CLI" app dev invoke . function-name --body '{"example":true}'
"$OPENCLOUD_CLI" app dev requests .
"$OPENCLOUD_CLI" app dev verify . --parallelism 5
"$OPENCLOUD_CLI" app dev promote . --idempotency-key "$IDEMPOTENCY_KEY"
"$OPENCLOUD_CLI" app dev receipts .
"$OPENCLOUD_CLI" app dev evidence .
```

`app dev start` returns `session.browserPreviewUrl`, and `app dev status`
returns the same owner/builder review link as top-level `browserPreviewUrl`.
Give that URL to a human reviewer: it opens the isolated revision in a
persistent **Development preview — Not live** shell with Full size, Tablet,
Mobile, and Reload controls. Keep the raw `previewUrl` for CLI and agent
inspection; opening it directly in a normal browser may return
`AUTH_REQUIRED`.

Development data is isolated from production and uses dummy records. Auth,
Files, Functions, and background jobs are available; Realtime and cron are not. Manifest-
generated secrets receive isolated synthetic development values, while owner-
configured required values remain unavailable and optional values may be
absent. Web Push deliveries are captured for inspection with
`app dev notifications list` instead of contacting browser push services.
Ordinary Functions imported from `@opencloud/server` remain dormant
until `app dev invoke` or a deliberate preview interaction calls them. A
Function enqueue wakes its declared system consumer in the same isolated
namespace. Exact-revision verification requires every declared Function to be
successfully exercised through its intended path and runs the
immutable `tests/opencloud.e2e.js` specification. The conventional test source
stays outside `frontend.directory`, is included in the deterministic artifact,
and must use only the bounded `@opencloud/test` UI fixtures.

`app dev promote` is the completion path: it deploys only the verified receipt,
follows the durable production operation, runs feature-aware production
verification, prints the live HTTPS URL, and removes the dev environment only
after success. If deployment or verification fails, dev remains available for
repair.

## Application email

Inspect retained production message metadata with cursor, alias, direction,
and date filters, then fetch one authorized message's normalized text/HTML,
safe headers, and attachment metadata:

```bash
"$OPENCLOUD_CLI" app email list "$APP_ID" \
  --alias support --direction inbound --limit 25
"$OPENCLOUD_CLI" app email get "$APP_ID" "$MESSAGE_ID"
```

Pass the returned `nextCursor` back through `--cursor` for the next page. Raw
MIME and attachment bytes are never returned. Development Function sends are
captured instead of delivered; `app dev email inject` accepts only reserved
`.test` sender and Reply-To addresses, and body/attachment file paths resolve
relative to the app directory.

## Web Push notifications

Read retained production history with `app notifications list <app-id>` and
inspect a payload with `app notifications get <app-id> <message-id>`. Listing
supports `--cursor`, `--limit` (1–200), `--user-id`, `--status`, `--from`, and
`--to`. Supply the same filters and limit when continuing with `nextCursor`.
History is retained for 30 days. `accepted` means provider acceptance, not
device receipt, display, or engagement. Results omit subscription and provider
target identifiers. These commands do not send notifications.

For paginated durable operations, use
`operation list <app-id> --page --limit 50 --type deploy --state succeeded`.
Continue with `--cursor <nextCursor>` and the same filters and limit. Page
results contain `asOf`, `operations`, and `nextCursor`. Without `--page`,
`--cursor`, `--type`, or `--state`, the original array result is preserved.

Declare `notifications.webPush: true` with runtime SDK `2.1.0`, then use
`opencloud.notifications.status()`, `.subscribe()`, and `.unsubscribe()` in the
frontend. Subscribing must follow a user click or tap. Functions send visible
notifications through their managed `notifications.send()` context; app code
never receives VAPID keys or browser endpoints.

The optional manifest `notifications.icon` is the app-wide fallback. A Function
may override it per message, and OpenCloud uses its own logo if neither is
provided. Browsers may apply platform-specific presentation rules; iOS and
iPadOS currently display the installed web app icon instead of the per-message
Web Push icon.

## Background jobs

Inspect retained production queue depth, per-queue policy and outcomes, or one
job's safe execution metadata:

```bash
"$OPENCLOUD_CLI" jobs list "$APP_ID" --limit 25
"$OPENCLOUD_CLI" jobs list "$APP_ID" \
  --queue reminder-delivery --state dead_lettered \
  --from 2026-08-18T09:00:00Z --to 2026-08-18T17:00:00Z
"$OPENCLOUD_CLI" jobs get "$APP_ID" "$JOB_ID"
```

`--from` and `--to` are inclusive ISO 8601 creation times and apply to totals,
queue rollups, and history. Pass `nextCursor` back through `--cursor` to
continue history. Successful and failed terminal records are retained for 14
days; active work remains visible until terminal. These commands never return
job payloads, idempotency keys, or enqueuing user identifiers, and intentionally
provide no cancel or redrive action.

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

Installation-managed runtimes can set `OPENCLOUD_PUBLIC_EDGE_HOST` to route
`app request` through a local public-edge bridge when public-address loopback
is unavailable. This changes address resolution only: the canonical HTTP Host,
TLS server name, and certificate checks remain active. It cannot be combined
with the separate `OPENCLOUD_EDGE_URL` test adapter.

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
npm run test:contract
npm run test:package
node dist/index.cjs --cli-version
```

The release bundle contains the exact OpenCloud manifest contracts and
JavaScript SDK version used by that CLI release. Release tarballs are generated
from tags and accompanied by SHA-256 checksums.
