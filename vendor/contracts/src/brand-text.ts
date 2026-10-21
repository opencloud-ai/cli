import type { BrandPack } from "./brand-pack.js";

/**
 * Agent- and developer-facing text (SKILL.md, MCP instructions and tool
 * metadata, the docs, the CLI installer) is written once, for OpenCloud's
 * production installation. These canonical sources stay the single source of
 * truth: `renderBrandText` swaps each canonical OpenCloud value for the
 * installation's value. With the default pack and the production URLs every
 * substitution maps a value to itself, so the output is the source,
 * byte-for-byte.
 *
 * Internal protocol names never change on any brand: `opencloud.yaml`,
 * `@opencloud/*`, `/_opencloud/`, `x-opencloud-*`, the `opencloud` SDK
 * singleton, `OpenCloud*` type names, and the CLI's own executable, storage
 * paths and keyring service.
 */
export interface BrandTextValues {
  /** Product name people and agents see, e.g. "OpenCloud". */
  readonly productName: string;
  /** Command people run, e.g. "opencloud". */
  readonly cliCommand: string;
  /** Segment in the MCP session and connect tool names. */
  readonly mcpToolNameSegment: string;
  readonly mcpSkillResourceName: string;
  readonly domainChallengeLabel: string;
  /** Installation apex origin without a trailing slash. */
  readonly homeUrl: string;
  /** Public documentation origin without a trailing slash. */
  readonly docsUrl: string;
  /** Public CLI installer URL. */
  readonly installerUrl: string;
}

/** The executable the public CLI package installs. */
export const OPENCLOUD_CLI_EXECUTABLE = "opencloud";

/** The values the canonical sources are written with. */
export const CANONICAL_BRAND_TEXT: BrandTextValues = Object.freeze({
  productName: "OpenCloud",
  cliCommand: OPENCLOUD_CLI_EXECUTABLE,
  mcpToolNameSegment: "opencloud",
  mcpSkillResourceName: "opencloud-skill",
  domainChallengeLabel: "_opencloud-challenge",
  homeUrl: "https://opencloud.ai",
  docsUrl: "https://docs.opencloud.ai",
  installerUrl: "https://docs.opencloud.ai/install.sh",
});

/**
 * Top-level commands of the public CLI. Only `opencloud <command>` is a CLI
 * invocation; the same word elsewhere is the SDK singleton or fixture text.
 */
export const OPENCLOUD_CLI_COMMANDS = Object.freeze([
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
  "usage",
  "validate",
  "visitors",
] as const);

/** The MCP tools whose names carry the brand's tool-name segment. */
export function brandMcpToolNames(segment: string): {
  readonly session: string;
  readonly connect: string;
} {
  return { session: `get_${segment}_session`, connect: `connect_${segment}` };
}

/** The SKILL.md front-matter name agent clients register the skill under. */
export function brandSkillName(segment: string): string {
  return `${segment}-build-apps`;
}

export interface BrandTextUrls {
  readonly homeUrl: string;
  readonly docsUrl: string;
}

/** The installation's text values for a brand pack and its public URLs. */
export function brandTextValues(
  pack: Pick<BrandPack, "productName" | "cli" | "mcp" | "domainChallengeLabel">,
  urls: BrandTextUrls,
): BrandTextValues {
  const homeUrl = withoutTrailingSlash(urls.homeUrl);
  const docsUrl = withoutTrailingSlash(urls.docsUrl);
  return {
    productName: pack.productName,
    cliCommand: pack.cli.command,
    mcpToolNameSegment: pack.mcp.toolNameSegment,
    mcpSkillResourceName: pack.mcp.skillResourceName,
    domainChallengeLabel: pack.domainChallengeLabel,
    homeUrl,
    docsUrl,
    // The published installer links only the CLI's own executable. A brand
    // command is a wrapper bound to this installation's API, which only the
    // installation's own installer can write.
    installerUrl:
      pack.cli.command === OPENCLOUD_CLI_EXECUTABLE
        ? `${docsUrl}/install.sh`
        : `${homeUrl}/install.sh`,
  };
}

/**
 * Replaces canonical OpenCloud names and URLs in agent-facing text with the
 * installation's values. Rules are applied in order: exact URLs first, then
 * hosts, MCP and skill identifiers, CLI invocations and finally the product
 * name as a standalone word.
 */
export function renderBrandText(
  source: string,
  values: BrandTextValues,
  canonical: BrandTextValues = CANONICAL_BRAND_TEXT,
): string {
  return createBrandTextRenderer(values, canonical)(source);
}

type Rule = (text: string) => string;

/**
 * Compiles the substitution rules once for repeated rendering. When every
 * value is canonical the renderer returns its input unchanged.
 */
export function createBrandTextRenderer(
  values: BrandTextValues,
  canonical: BrandTextValues = CANONICAL_BRAND_TEXT,
): (text: string) => string {
  const rules: Rule[] = [
    urlRule(canonical.installerUrl, values.installerUrl),
    urlRule(canonical.docsUrl, values.docsUrl),
    urlRule(canonical.homeUrl, values.homeUrl),
  ];
  const canonicalHost = new URL(canonical.homeUrl).host;
  const canonicalDocsHost = new URL(canonical.docsUrl).host;
  const host = new URL(values.homeUrl).host;
  if (canonicalHost !== host) {
    // Other installation hosts, such as mcp.opencloud.ai, api.opencloud.ai or
    // support@opencloud.ai. The docs location follows only docsUrl above.
    const pattern = new RegExp(
      `(?<![\\w.-])((?:[a-z0-9-]+\\.)*|\\.)${escapeRegExp(canonicalHost)}(?![\\w-])`,
      "g",
    );
    rules.push((text) =>
      text.replace(pattern, (match, prefix: string) =>
        `${prefix}${canonicalHost}` === canonicalDocsHost
          ? match
          : `${prefix}${host}`,
      ),
    );
  }
  const canonicalTools = brandMcpToolNames(canonical.mcpToolNameSegment);
  const tools = brandMcpToolNames(values.mcpToolNameSegment);
  rules.push(
    identifierRule(canonicalTools.session, tools.session),
    identifierRule(canonicalTools.connect, tools.connect),
    identifierRule(canonical.mcpSkillResourceName, values.mcpSkillResourceName),
    identifierRule(
      brandSkillName(canonical.mcpToolNameSegment),
      brandSkillName(values.mcpToolNameSegment),
    ),
    identifierRule(canonical.domainChallengeLabel, values.domainChallengeLabel),
  );
  if (canonical.cliCommand !== values.cliCommand) {
    const command = escapeRegExp(canonical.cliCommand);
    const invocation = [
      ...OPENCLOUD_CLI_COMMANDS.map(escapeRegExp),
      "--cli-version",
      "--help",
      "--version",
      "<command>",
    ].join("|");
    // `opencloud` as inline code names the command itself.
    const inlineCode = new RegExp("`" + command + "`", "g");
    const call = new RegExp(
      `(?<![\\w./@:$\\-])${command}(?= (?:${invocation})(?![\\w-]))`,
      "g",
    );
    rules.push((text) =>
      text
        .replace(inlineCode, "`" + values.cliCommand + "`")
        .replace(call, values.cliCommand),
    );
  }
  if (canonical.productName !== values.productName) {
    // A standalone word: not part of an identifier (OpenCloudError), a path
    // segment (Application Support/OpenCloud), a header (X-OpenCloud-*) or the
    // legal operator's name.
    const pattern = new RegExp(
      `(?<![\\w/\\\\.-])${escapeRegExp(canonical.productName)}(?![\\w/\\\\]| Solutions Limited)`,
      "g",
    );
    rules.push((text) => text.replace(pattern, values.productName));
  }
  const active = rules.filter((rule) => rule !== unchanged);
  if (active.length === 0) return unchanged;
  return (text) => active.reduce((value, rule) => rule(value), text);
}

const unchanged: Rule = (text) => text;

function urlRule(from: string, to: string): Rule {
  if (from === to) return unchanged;
  const pattern = new RegExp(`${escapeRegExp(from)}(?![\\w.-]*[\\w-])`, "g");
  return (text) => text.replace(pattern, to);
}

function identifierRule(from: string, to: string): Rule {
  if (from === to) return unchanged;
  const pattern = new RegExp(`(?<![\\w-])${escapeRegExp(from)}(?![\\w-])`, "g");
  return (text) => text.replace(pattern, to);
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
