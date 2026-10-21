import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadBrandPack } from "./brand-pack.js";
import {
  brandMcpToolNames,
  brandSkillName,
  brandTextValues,
  CANONICAL_BRAND_TEXT,
  renderBrandText,
} from "./brand-text.js";

const repository = new URL("../../../", import.meta.url);
const skill = readFileSync(new URL("SKILL.md", repository), "utf8");

const sprout = brandTextValues(loadBrandPack("sprout"), {
  homeUrl: "https://sprout.is/",
  docsUrl: "https://docs.sprout.is",
});

/**
 * Internal protocol and tooling names that keep "opencloud" on every brand:
 * the manifest, SDK packages, paths and singleton, type names, environment
 * variables, the CLI's executable storage and keyring, and its source.
 */
const internalNames = [
  /OPEN_?CLOUD_[A-Z_]+/g,
  /\b(?:is)?OpenCloud[A-Z][A-Za-z]*/g,
  /@opencloud\/[a-z-]+/g,
  /\/_opencloud\/[\w./?=<>-]*/g,
  /\.opencloud\/[\w.-]+/g,
  /\bopencloud\.(?:yaml|e2e\.js|cron|email|[a-z]+(?:\.[a-zA-Z]+)*(?:\(\))?)/g,
  /\bopencloud:ai-consent/g,
  /\bopencloud_app_access/g,
  /\bopencloud-browser\b/g,
  /\bopencloud-build-v3\b/g,
  /\bimport \{ opencloud\b|^\s+opencloud,$/gm,
  /\bai\.opencloud\.cli\b/g,
  /(?:\$XDG_CONFIG_HOME|~\/\.config)\/opencloud\/credentials/g,
  /Application Support\/OpenCloud\/credentials/g,
  /%APPDATA%\\OpenCloud\\credentials/g,
  /https:\/\/github\.com\/opencloud-ai\/cli[\w./-]*/g,
  /opencloud-cli-[\d.]+\.tgz/g,
];

function withoutInternalNames(text: string): string {
  return internalNames.reduce(
    (value, pattern) => value.replace(pattern, "<internal>"),
    text,
  );
}

function docsMarkdown(directory = new URL("docs/site/", repository)): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name === "public") return [];
    const location = new URL(
      entry.isDirectory() ? `${entry.name}/` : entry.name,
      directory,
    );
    if (entry.isDirectory()) return docsMarkdown(location);
    return entry.name.endsWith(".md") ? [readFileSync(location, "utf8")] : [];
  });
}

describe("brand text", () => {
  it("renders every canonical source unchanged with the default values", () => {
    const sources = [
      skill,
      readFileSync(new URL("docs/site/public/llms.txt", repository), "utf8"),
      readFileSync(new URL("docs/site/public/install.sh", repository), "utf8"),
      ...docsMarkdown(),
    ];
    for (const source of sources) {
      expect(renderBrandText(source, CANONICAL_BRAND_TEXT)).toBe(source);
    }
    const defaultValues = brandTextValues(loadBrandPack("opencloud"), {
      homeUrl: "https://opencloud.ai",
      docsUrl: "https://docs.opencloud.ai/",
    });
    expect(defaultValues).toEqual(CANONICAL_BRAND_TEXT);
    expect(renderBrandText(skill, defaultValues)).toBe(skill);
  });

  it("keeps the default skill byte-identical on a preview installation", () => {
    const preview = brandTextValues(loadBrandPack("opencloud"), {
      homeUrl: "https://feature.ocd.dev",
      docsUrl: "https://docs.opencloud.ai",
    });
    expect(renderBrandText(skill, preview)).toBe(skill);
  });

  it("names Sprout in the skill and keeps internal protocol names", () => {
    const rendered = renderBrandText(skill, sprout);
    expect(rendered).toMatch(/^---\nname: sprout-build-apps\n/);
    expect(rendered).toContain("# Build apps on Sprout");
    expect(rendered).toContain("1. Call `get_sprout_session`.");
    expect(rendered).toContain("call `connect_sprout` for a returning user");
    expect(rendered).toContain("`sprout-skill` is a supplemental MCP");
    expect(rendered).toContain(
      'curl -fsSL https://sprout.is/install.sh | bash\ntest "$(sprout --cli-version)" = "3.13.1"',
    );
    expect(rendered).toContain("installs the `sprout` command");
    expect(rendered).toContain("sprout app connect \"$APP_ID\"");
    expect(rendered).toContain("<https://docs.sprout.is/guides/routing>");
    expect(rendered).toContain("`opencloud.yaml`");
    expect(rendered).toContain('} from "/_opencloud/sdk.js";');
    expect(rendered).toContain("if (error instanceof OpenCloudError) {");
    expect(rendered).toContain("~/Library/Application Support/OpenCloud/credentials");
    expect(rendered).toContain("`ai.opencloud.cli`");
    expect(withoutInternalNames(rendered)).not.toMatch(/open\s*cloud/i);
  });

  it("leaves no OpenCloud product name or host in the docs sources", () => {
    const docs = [
      ...docsMarkdown(),
      readFileSync(new URL("docs/site/public/llms.txt", repository), "utf8"),
    ].join("\n");
    const rendered = renderBrandText(docs, sprout);
    expect(rendered).not.toMatch(/(?<![\w/\\.-])OpenCloud(?![\w/\\]| Solutions Limited)/);
    expect(
      rendered.match(/[\w.-]*opencloud\.ai\b/g) ?? [],
    ).toEqual([]);
    expect(rendered).toContain("https://mcp.sprout.is");
    expect(rendered).toContain("curl -fsSL https://sprout.is/install.sh | bash");
  });

  it("swaps only standalone names, hosts and CLI invocations", () => {
    const render = (text: string) => renderBrandText(text, sprout);
    expect(render("OpenCloud's built-in signals and OpenCloud-funded usage."))
      .toBe("Sprout's built-in signals and Sprout-funded usage.");
    expect(render("OpenCloudError isOpenCloudError OPEN_CLOUD_SDK_VERSION"))
      .toBe("OpenCloudError isOpenCloudError OPEN_CLOUD_SDK_VERSION");
    expect(render("X-OpenCloud-Auth-Method and x-opencloud-route"))
      .toBe("X-OpenCloud-Auth-Method and x-opencloud-route");
    expect(render("Operated by OpenCloud Solutions Limited."))
      .toBe("Operated by OpenCloud Solutions Limited.");
    expect(render("the text file contains `opencloud deterministic verification`"))
      .toBe("the text file contains `opencloud deterministic verification`");
    expect(render("docker compose --project-name opencloud --env-file .env"))
      .toBe("docker compose --project-name opencloud --env-file .env");
    expect(render('import { opencloud } from "/_opencloud/sdk.js";'))
      .toBe('import { opencloud } from "/_opencloud/sdk.js";');
    expect(render("Run `opencloud doctor` or opencloud app list."))
      .toBe("Run `sprout doctor` or sprout app list.");
    expect(render("See https://opencloud.ai/connect and https://opencloud.airline."))
      .toBe("See https://sprout.is/connect and https://opencloud.airline.");
    expect(render("Use https://mcp.opencloud.ai, api.opencloud.ai and support@opencloud.ai."))
      .toBe("Use https://mcp.sprout.is, api.sprout.is and support@sprout.is.");
    expect(render("<title>-<six random characters>.opencloud.ai"))
      .toBe("<title>-<six random characters>.sprout.is");
    expect(render("Read https://docs.opencloud.ai/guides/custom-domains."))
      .toBe("Read https://docs.sprout.is/guides/custom-domains.");
    expect(render("TXT _opencloud-challenge.example.org"))
      .toBe("TXT _sprout-challenge.example.org");
  });

  it("derives MCP names, the skill name and the installer location", () => {
    expect(brandMcpToolNames("opencloud")).toEqual({
      session: "get_opencloud_session",
      connect: "connect_opencloud",
    });
    expect(brandMcpToolNames("sprout")).toEqual({
      session: "get_sprout_session",
      connect: "connect_sprout",
    });
    expect(brandSkillName("sprout")).toBe("sprout-build-apps");
    // A brand command is a wrapper bound to the installation, so it comes
    // from the installation's own installer.
    expect(sprout.installerUrl).toBe("https://sprout.is/install.sh");
    expect(sprout.homeUrl).toBe("https://sprout.is");
    expect(CANONICAL_BRAND_TEXT.installerUrl).toBe(
      "https://docs.opencloud.ai/install.sh",
    );
  });
});
