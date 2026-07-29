# OpenCloud CLI

The public, versioned command-line client for building, validating, deploying,
and verifying applications on [OpenCloud](https://opcl.app).

The CLI is intended for coding agents and humans with a terminal. A regular
browser-only chat cannot execute a downloaded CLI; use an OpenCloud tool or
plugin when one is available in that environment.

## Install a pinned release

OpenCloud application skills pin an exact CLI release. To install `v0.2.0` in
an isolated task directory:

```bash
OPENCLOUD_CLI_VERSION="v0.2.0"
OPENCLOUD_CLI_PACKAGE="opencloud-cli-0.2.0.tgz"
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

For a new project, give the CLI the user's email and agreed title:

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
"$OPENCLOUD_CLI" init /absolute/path/to/app --version 2026.07.29-1
"$OPENCLOUD_CLI" artifact-check /absolute/path/to/app \
  --expect-app-id "$APP_ID" \
  --max-files 4
"$OPENCLOUD_CLI" validate /absolute/path/to/app
```

Existing installations can still supply `OPENCLOUD_API_URL` and
`OPENCLOUD_TOKEN` explicitly.

See the [OpenCloud CLI reference](https://docs.opcl.app/reference/cli) and
[agent guide](https://docs.opcl.app/getting-started/agents).

## Browser verification

`app verify-ui` uses Playwright. Point it at an existing Chromium executable:

```bash
"$OPENCLOUD_CLI" app verify-ui "$APP_ID" \
  --chromium-path /usr/bin/chromium \
  --require-interaction
```

If Chromium is not installed, install the browser and its required host
libraries through the operating system or use OpenCloud's pinned verification
container from a platform checkout.

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
