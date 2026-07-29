# OpenCloud CLI

The public, versioned command-line client for building, validating, deploying,
and verifying applications on [OpenCloud](https://opcl.app).

The CLI is intended for coding agents and humans with a terminal. A regular
browser-only chat cannot execute a downloaded CLI; use an OpenCloud tool or
plugin when one is available in that environment.

## Install a pinned release

OpenCloud application skills pin an exact CLI release. To install `v0.1.0` in
an isolated task directory:

```bash
OPENCLOUD_CLI_VERSION="v0.1.0"
OPENCLOUD_CLI_PACKAGE="opencloud-cli-0.1.0.tgz"
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

Keep `OPENCLOUD_TOKEN` in the process environment. Never put it in source,
shell history, screenshots, or reports.

```bash
export OPENCLOUD_API_URL="https://api.opcl.app"
export OPENCLOUD_TOKEN="set-without-echoing"

"$OPENCLOUD_CLI" app list
"$OPENCLOUD_CLI" app get "$APP_ID"
"$OPENCLOUD_CLI" artifact-check /absolute/path/to/app \
  --expect-app-id "$APP_ID" \
  --max-files 4
"$OPENCLOUD_CLI" validate /absolute/path/to/app
```

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
