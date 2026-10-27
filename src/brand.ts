/**
 * The product and command names in text people read. An installation's CLI
 * installer can run this CLI through a wrapper with another name, such as
 * `sprout`, that sets OPENCLOUD_CLI_PRODUCT_NAME and OPENCLOUD_CLI_COMMAND.
 * The sentences the CLI writes then name that product and the command that
 * exists: help, status lines, error messages and hints, and `next` steps.
 * JSON documents are never rewritten, and what programs read keeps
 * OpenCloud's names: field names, codes, API data and paths, OPENCLOUD_*
 * variables, `.opencloud` files, the keyring service and error reports.
 */

export const PRODUCT_NAME_VARIABLE = "OPENCLOUD_CLI_PRODUCT_NAME";
export const COMMAND_VARIABLE = "OPENCLOUD_CLI_COMMAND";

export interface Brand {
  /** The product people see, such as "Sprout". */
  readonly productName: string;
  /** The command people run, such as "sprout". */
  readonly command: string;
}

export const OPENCLOUD_BRAND: Brand = Object.freeze({
  productName: "OpenCloud",
  command: "opencloud",
});

// Product names follow the platform's brand packs; a command is one word.
const PRODUCT_NAME = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,39}$/;
const COMMAND = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The CLI's top-level commands. Only `opencloud <command>` names the CLI:
 * `opencloud.yaml`, `.opencloud/`, `@opencloud/js` and the SDK's `opencloud`
 * object never change.
 */
export const CLI_COMMANDS: readonly string[] = Object.freeze([
  "agent-feed",
  "alert-rule",
  "app",
  "artifact-check",
  "auth",
  "backup",
  "cron",
  "data",
  "deploy",
  "deployment",
  "doctor",
  "draft",
  "file",
  "function",
  "init",
  "integration",
  "jobs",
  "login",
  "logout",
  "logs",
  "metrics",
  "onboard",
  "onboard-complete",
  "operation",
  "pull",
  "secret",
  "telemetry",
  "usage",
  "validate",
  "visitors",
  "whoami",
]);

/** The brand an environment names; an absent or invalid value keeps OpenCloud's. */
export function resolveBrand(environment: NodeJS.ProcessEnv = process.env): Brand {
  const productName = environment[PRODUCT_NAME_VARIABLE];
  const command = environment[COMMAND_VARIABLE];
  return {
    productName:
      productName !== undefined && PRODUCT_NAME.test(productName)
        ? productName
        : OPENCLOUD_BRAND.productName,
    command:
      command !== undefined && COMMAND.test(command)
        ? command
        : OPENCLOUD_BRAND.command,
  };
}

let processBrand: Brand | undefined;

function currentBrand(): Brand {
  return (processBrand ??= resolveBrand());
}

export function commandName(): string {
  return currentBrand().command;
}

const INVOCATION = new RegExp(
  // Not part of a name or path, such as x-opencloud or bin/opencloud.
  "(?<![\\w./\\\\@:$-])opencloud" +
    `(?= (?:${[...CLI_COMMANDS, "help", "--help", "--cli-version", "-V"].join("|")})(?![\\w-]))` +
    // `opencloud` as inline code names the command itself.
    "|(?<=`)opencloud(?=`)",
  "g",
);
// A standalone word, not part of a name (OpenCloudClient, X-OpenCloud-*), a
// file name (OpenCloud.csv) or a path (Application Support/OpenCloud); "an"
// before it follows the new name.
const PRODUCT = /(?<![\w/\\.-])(?:(an|An) )?OpenCloud(?![\w/\\]|\.\w)/g;

let renderer: { brand: Brand; render: (text: string) => string } | undefined;

/**
 * Rewrites OpenCloud's product name and `opencloud <command>` invocations in
 * text people read. Without a brand it returns the text unchanged. Apply it to
 * whole sentences the CLI writes, never to JSON documents or data.
 */
export function brandText(text: string, brand: Brand = currentBrand()): string {
  if (
    renderer?.brand.productName !== brand.productName ||
    renderer.brand.command !== brand.command
  ) {
    renderer = { brand, render: compile(brand) };
  }
  return renderer.render(text);
}

function compile(brand: Brand): (text: string) => string {
  const rules: Array<(text: string) => string> = [];
  if (brand.command !== OPENCLOUD_BRAND.command) {
    rules.push((text) => text.replace(INVOCATION, () => brand.command));
  }
  if (brand.productName !== OPENCLOUD_BRAND.productName) {
    const vowel = /^[aeiou]/i.test(brand.productName);
    rules.push((text) =>
      text.replace(PRODUCT, (_match, article: string | undefined) =>
        article === undefined
          ? brand.productName
          : `${article.startsWith("A") ? "A" : "a"}${vowel ? "n" : ""} ${brand.productName}`,
      ),
    );
  }
  return (text) => rules.reduce((value, rule) => rule(value), text);
}

/**
 * A structured CLI error with its `message` and `hint` in the brand's words.
 * Its code, other fields and their order are unchanged.
 */
export function brandCliError<T extends { error: Record<string, unknown> }>(
  value: T,
  brand: Brand = currentBrand(),
): T {
  const error = Object.fromEntries(
    Object.entries(value.error).map(([key, field]) => [
      key,
      (key === "message" || key === "hint") && typeof field === "string"
        ? brandText(field, brand)
        : field,
    ]),
  );
  return { ...value, error };
}
