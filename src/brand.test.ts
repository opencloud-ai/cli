import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLI_COMMANDS,
  OPENCLOUD_BRAND,
  brandCliError,
  brandText,
  resolveBrand,
  type Brand,
} from "./brand.js";

const sprout: Brand = { productName: "Sprout", command: "sprout" };
const env = (productName?: string, command?: string): NodeJS.ProcessEnv => ({
  ...(productName === undefined ? {} : { OPENCLOUD_CLI_PRODUCT_NAME: productName }),
  ...(command === undefined ? {} : { OPENCLOUD_CLI_COMMAND: command }),
});

describe("brand from an installer wrapper's environment", () => {
  it("is OpenCloud's without the variables", () => {
    expect(resolveBrand({})).toEqual(OPENCLOUD_BRAND);
    expect(OPENCLOUD_BRAND).toEqual({ productName: "OpenCloud", command: "opencloud" });
  });

  it("takes valid names, each on its own", () => {
    expect(resolveBrand(env("Sprout", "sprout"))).toEqual(sprout);
    expect(resolveBrand(env("Sprout.is"))).toEqual({ productName: "Sprout.is", command: "opencloud" });
    expect(resolveBrand(env(undefined, "my-cli2"))).toEqual({ productName: "OpenCloud", command: "my-cli2" });
    expect(resolveBrand(env("A".repeat(40), `s${"x".repeat(31)}`))).toEqual({
      productName: "A".repeat(40),
      command: `s${"x".repeat(31)}`,
    });
    expect(resolveBrand(env("Acme Cloud 2", "s")).productName).toBe("Acme Cloud 2");
  });

  it("ignores invalid values and keeps OpenCloud's for that name", () => {
    for (const productName of ["", " Sprout", "-Sprout", "Sprout!", "<b>Sprout</b>", "Sprout\nCLI", "A".repeat(41), "Spröut", "$(id)"]) {
      expect(resolveBrand(env(productName, "sprout")), productName).toEqual({ productName: "OpenCloud", command: "sprout" });
    }
    for (const command of ["", "Sprout", "sprout cli", "-sprout", "1sprout", "sprout_cli", "sprout;id", "sprout.is", `s${"x".repeat(32)}`]) {
      expect(resolveBrand(env("Sprout", command)), command).toEqual({ productName: "Sprout", command: "opencloud" });
    }
  });
});

describe("brand text", () => {
  it("returns OpenCloud's text unchanged without a brand", () => {
    const text = "No OpenCloud account login was found. Run opencloud login.";
    expect(brandText(text, OPENCLOUD_BRAND)).toBe(text);
    expect(brandText(text, resolveBrand(env("<invalid>", "Invalid")))).toBe(text);
  });

  it("names the brand's command in hints and the brand in messages", () => {
    const cases: Array<[string, string]> = [
      ["No OpenCloud account login was found. Run opencloud login.", "No Sprout account login was found. Run sprout login."],
      ["OpenCloud CLI login expired; run opencloud login again", "Sprout CLI login expired; run sprout login again"],
      ["Run opencloud login, then opencloud app connect <app-id> in this directory.", "Run sprout login, then sprout app connect <app-id> in this directory."],
      ["Email verification is still pending. Run opencloud onboard-complete after confirming the email.", "Email verification is still pending. Run sprout onboard-complete after confirming the email."],
      ["Re-run the same opencloud onboard command.", "Re-run the same sprout onboard command."],
      ["After edits run `opencloud app dev sync <directory>`.", "After edits run `sprout app dev sync <directory>`."],
      ["recover with opencloud operation get op-1 --follow", "recover with sprout operation get op-1 --follow"],
      ["Run opencloud pull <directory> to update this copy", "Run sprout pull <directory> to update this copy"],
      ["run `opencloud telemetry disable` or set OPENCLOUD_TELEMETRY=0.", "run `sprout telemetry disable` or set OPENCLOUD_TELEMETRY=0."],
      ["Run opencloud whoami, opencloud --help or `opencloud`.", "Run sprout whoami, sprout --help or `sprout`."],
      ["OpenCloud's zlib compressed the same files", "Sprout's zlib compressed the same files"],
      ["This directory is not connected to an OpenCloud app.", "This directory is not connected to a Sprout app."],
      ["An OpenCloud credential is required", "A Sprout credential is required"],
      ["Run local artifact validation without contacting OpenCloud.", "Run local artifact validation without contacting Sprout."],
    ];
    for (const [text, branded] of cases) expect(brandText(text, sprout)).toBe(branded);
    const orchard = { productName: "Orchard", command: "orchard" };
    expect(brandText("Not connected to an OpenCloud app.", orchard)).toBe("Not connected to an Orchard app.");
    expect(brandText("Toucan OpenCloud", sprout)).toBe("Toucan Sprout");
  });

  it("keeps names that programs read", () => {
    const unchanged = [
      "OPENCLOUD_API_URL and OPENCLOUD_TOKEN",
      "Non-secret app binding file (defaults to .opencloud/app.json)",
      "storing the canonical opencloud.json with opencloud.yaml",
      "import { opencloud } from \"/_opencloud/sdk.js\"; opencloud.app.info()",
      "@opencloud/js and @opencloud/test",
      "opencloud-cli/3.16.0 (linux x64; node 22.0.0)",
      "ai.opencloud.cli",
      "OpenCloudClient and OpenCloudError",
      "x-opencloud-request and X-OpenCloud-Trace",
      "/Users/ada/Library/Application Support/OpenCloud/credentials",
      "Cannot read OpenCloud.csv",
      "C:\\Users\\ada\\AppData\\Roaming\\OpenCloud\\credentials",
      "https://api.opencloud.ai and support@opencloud.ai",
      "node_modules/.bin/opencloud login",
      "the opencloud object, opencloud apps",
    ];
    for (const text of unchanged) expect(brandText(text, sprout), text).toBe(text);
  });

  it("changes only the name that differs", () => {
    const text = "No OpenCloud account login was found. Run opencloud login.";
    expect(brandText(text, { productName: "Sprout", command: "opencloud" })).toBe(
      "No Sprout account login was found. Run opencloud login.",
    );
    expect(brandText(text, { productName: "OpenCloud", command: "sprout" })).toBe(
      "No OpenCloud account login was found. Run sprout login.",
    );
  });

  it("knows every top-level command of the released command surface", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
    const surface = JSON.parse(
      readFileSync(path.join(root, "scripts", `public-cli-${version}-command-surface.json`), "utf8"),
    ) as { groups: string[]; commands: string[] };
    const topLevel = new Set(
      [...surface.groups, ...surface.commands].map((entry) => entry.split("|")[0]!.split(" ")[1]!),
    );
    expect([...CLI_COMMANDS].sort()).toEqual([...topLevel].sort());
  });
});

describe("branded structured errors", () => {
  const structured = {
    ok: false as const,
    error: {
      code: "ACTIVE_DEPLOYMENT_CHANGED",
      message: "OpenCloud refused the deploy.",
      status: 409,
      latestDeploymentId: "opencloud-release",
      hint: "Run opencloud pull <directory> to update this copy and reapply your change, or pass --force to replace the latest release.",
      retryable: false,
      cause: { code: "ECONNREFUSED", message: "OpenCloud said opencloud login" },
      requestId: "cli-1",
    },
  };

  it("brands only the message and hint, keeping every other field and their order", () => {
    const branded = brandCliError(structured, sprout);
    expect(branded).toEqual({
      ...structured,
      error: {
        ...structured.error,
        message: "Sprout refused the deploy.",
        hint: "Run sprout pull <directory> to update this copy and reapply your change, or pass --force to replace the latest release.",
      },
    });
    expect(Object.keys(branded.error)).toEqual(Object.keys(structured.error));
    expect(JSON.stringify(brandCliError(structured, OPENCLOUD_BRAND))).toBe(JSON.stringify(structured));
  });
});
