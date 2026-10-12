import { OPENCLOUD_CLI_EXECUTABLE } from "./brand-text.js";

/**
 * Renders the public CLI installer (`docs/site/public/install.sh`) for an
 * installation. The canonical script installs the pinned CLI release, checks
 * its published checksum and links the `opencloud` executable; for the CLI's
 * own command and product name it is returned unchanged. A brand command
 * additionally gets a small `<command>` wrapper that defaults
 * `OPENCLOUD_API_URL` to this installation's API (an explicit value still
 * wins) and runs the installed executable, and the messages name the brand.
 * Stored logins stay separate per installation because the CLI keys them by
 * API URL.
 */
export interface CliInstallerValues {
  readonly productName: string;
  readonly cliCommand: string;
  /** The installation's API origin, e.g. https://api.opencloud.ai */
  readonly apiUrl: string;
}

const CANONICAL_PRODUCT = "OpenCloud CLI";
const DOWNLOAD_ANCHOR = 'download_directory="$(mktemp -d';
const LINK_ANCHOR = 'ln -sfn "$opencloud_executable" "$opencloud_link"\n';
const SUCCESS_ANCHOR =
  "printf 'OpenCloud CLI %s installed at %s\\n' \"$CLI_VERSION\" \"$opencloud_link\"\n";
const RUN_HINT = "printf 'Run: opencloud doctor\\n'\n";
const PATH_HINT =
  "printf '\\nAdd the CLI to PATH, then run opencloud doctor:\\n'\n";

export function renderCliInstaller(
  template: string,
  values: CliInstallerValues,
): string {
  const product = `${values.productName} CLI`;
  if (
    values.cliCommand === OPENCLOUD_CLI_EXECUTABLE &&
    product === CANONICAL_PRODUCT
  ) {
    return template;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 .-]{0,39}$/.test(values.productName)) {
    throw new Error("Installer product name is invalid");
  }
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(values.cliCommand)) {
    throw new Error("Installer command is invalid");
  }
  if (!/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(values.apiUrl)) {
    throw new Error("Installer API URL must be an origin");
  }
  for (const anchor of [
    DOWNLOAD_ANCHOR,
    LINK_ANCHOR,
    SUCCESS_ANCHOR,
    RUN_HINT,
    PATH_HINT,
  ]) {
    if (template.split(anchor).length !== 2) {
      throw new Error(
        "The CLI installer template no longer has its expected shape",
      );
    }
  }
  let script = template
    .replace(
      SUCCESS_ANCHOR,
      values.cliCommand === OPENCLOUD_CLI_EXECUTABLE
        ? SUCCESS_ANCHOR
        : SUCCESS_ANCHOR.replace('"$opencloud_link"', '"$brand_link"'),
    )
    .replaceAll(CANONICAL_PRODUCT, product);
  if (values.cliCommand === OPENCLOUD_CLI_EXECUTABLE) return script;

  const command = values.cliCommand;
  script = script
    .replace(
      DOWNLOAD_ANCHOR,
      `brand_command='${command}'
brand_api_url='${values.apiUrl}'
brand_marker='# Managed by the ${product} installer.'
brand_link="$bin_directory/$brand_command"

brand_managed() {
  local line
  while IFS= read -r line; do
    [[ "$line" == "$brand_marker" ]] && return 0
  done < "$1"
  return 1
}

if [[ -L "$brand_link" ]] ||
  { [[ -e "$brand_link" ]] && ! brand_managed "$brand_link"; }; then
  fail "$brand_link already exists and is not managed by this installer"
fi

${DOWNLOAD_ANCHOR}`,
    )
    .replace(
      LINK_ANCHOR,
      `${LINK_ANCHOR}
brand_wrapper="$(mktemp "$bin_directory/.$brand_command.XXXXXX")"
{
  printf '#!/usr/bin/env bash\\n'
  printf '%s\\n' "$brand_marker"
  printf 'export OPENCLOUD_API_URL="\${OPENCLOUD_API_URL:-%s}"\\n' "$brand_api_url"
  printf 'exec %q "$@"\\n' "$opencloud_executable"
} > "$brand_wrapper"
chmod 0755 "$brand_wrapper"
mv -f "$brand_wrapper" "$brand_link"
`,
    )
    .replace(RUN_HINT, `printf 'Run: ${command} doctor\\n'\n`)
    .replace(
      PATH_HINT,
      `printf '\\nAdd the CLI to PATH, then run ${command} doctor:\\n'\n`,
    );
  return script;
}
