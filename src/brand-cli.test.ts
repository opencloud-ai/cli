import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Builds the CLI from source, as `npm run build` does, and runs it as an
// installer wrapper would: with the brand's variables, without them, and with
// values the CLI must ignore.
const root = fileURLToPath(new URL("..", import.meta.url));
const sprout = { OPENCLOUD_CLI_PRODUCT_NAME: "Sprout", OPENCLOUD_CLI_COMMAND: "sprout" };
const invalid = { OPENCLOUD_CLI_PRODUCT_NAME: "<b>Sprout</b>", OPENCLOUD_CLI_COMMAND: "Sprout CLI" };
const appId = "30000000-0000-4000-8000-000000000001";
const deploymentId = "30000000-0000-4000-8000-000000000002";
// API data that happens to contain the words the brand replaces in messages.
const apps = [
  {
    id: appId,
    name: "OpenCloud planner",
    description: "Run opencloud login, then opencloud app connect in an OpenCloud app",
    appUrl: "https://planner.opencloud.ai",
  },
];

let temporary: string;
let binary: string;
let server: Server;
let apiUrl: string;

beforeAll(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "opencloud-brand-cli-"));
  binary = path.join(temporary, "index.cjs");
  await build({
    entryPoints: [path.join(root, "src", "index.ts")],
    outfile: binary,
    tsconfig: path.join(root, "tsconfig.json"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "silent",
    // Unresolvable from the temporary directory, so no run touches the OS keyring.
    external: ["@napi-rs/keyring"],
  });
  server = createServer((request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/v1/apps") return send(200, apps);
    if (request.url === `/v1/apps/${appId}`) {
      return send(409, {
        code: "ACTIVE_DEPLOYMENT_CHANGED",
        message: "The app's latest release is now planner-2, not the one OpenCloud recorded for this copy.",
        details: { latestDeploymentId: deploymentId, latestVersion: "planner-2" },
        requestId: "request-1",
      });
    }
    send(404, { code: "NOT_FOUND", message: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await mkdir(path.join(temporary, "home"));
  await mkdir(path.join(temporary, "empty"));
  const app = path.join(temporary, "app");
  await mkdir(path.join(app, "frontend", "src"), { recursive: true });
  await writeFile(
    path.join(app, "opencloud.yaml"),
    `schemaVersion: 3\nappId: ${appId}\nfrontend:\n  directory: frontend/dist\n  spa: true\n  build:\n    script: build\nruntime:\n  sdk:\n    version: 2.3.0\n`,
  );
  await writeFile(path.join(app, "package.json"), "{\"name\":\"planner\",\"scripts\":{\"build\":\"vite build\"}}\n");
  await writeFile(path.join(app, "frontend", "src", "main.ts"), "console.log('planner');\n");
}, 60_000);

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

async function run(
  args: string[],
  brand: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("OPENCLOUD_") && !["INIT_CWD", "DO_NOT_TRACK"].includes(name)) {
      environment[name] = value;
    }
  }
  const home = path.join(temporary, "home");
  Object.assign(environment, { HOME: home, XDG_CONFIG_HOME: home, APPDATA: home, OPENCLOUD_TELEMETRY: "0" }, brand);
  const child = spawn(process.execPath, [binary, ...args], {
    cwd: temporary,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { status, stdout, stderr };
}

describe("an installer wrapper's brand in the built CLI", () => {
  it("names the brand's command and product in help", async () => {
    const [help, nested] = await Promise.all([
      run(["--help"], sprout),
      run(["app", "dev", "start", "--help"], sprout),
    ]);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^Usage: sprout \[options\] \[command\]$/m);
    expect(help.stdout).toContain("Agent- and human-facing client for the Sprout control plane");
    expect(help.stdout).toMatch(/app {2,}Manage Sprout apps/);
    expect(help.stdout).not.toContain("OpenCloud");
    // Names programs read keep their spelling.
    expect(help.stdout).toContain("OPENCLOUD_API_URL");
    expect(help.stdout).toContain(".opencloud/app.json");
    expect(nested.stdout).toMatch(/^Usage: sprout app dev start \[options\] <directory>$/m);
  });

  it("keeps OpenCloud's help without the variables and ignores invalid values", async () => {
    const [help, ignored, nested, nestedIgnored] = await Promise.all([
      run(["--help"]),
      run(["--help"], invalid),
      run(["app", "dev", "start", "--help"]),
      run(["app", "dev", "start", "--help"], invalid),
    ]);
    expect(help.stdout).toMatch(/^Usage: opencloud \[options\] \[command\]$/m);
    expect(help.stdout).toContain("Agent- and human-facing client for the OpenCloud control plane");
    expect(help.stdout).toMatch(/app {2,}Manage OpenCloud apps/);
    expect(ignored.stdout).toBe(help.stdout);
    expect(nested.stdout).toMatch(/^Usage: opencloud app dev start \[options\] <directory>$/m);
    expect(nestedIgnored.stdout).toBe(nested.stdout);
  });

  it("names the brand's command in error hints and keeps the structured error", async () => {
    const sync = ["app", "dev", "sync", "empty"];
    const refused = ["--api-url", apiUrl, "--token", "synthetic-brand", "app", "get", appId];
    const [canonical, branded, ignored, api, brandedApi] = await Promise.all([
      run(sync),
      run(sync, sprout),
      run(sync, invalid),
      run(refused),
      run(refused, sprout),
    ]);
    expect(canonical.status).toBe(1);
    expect(JSON.parse(canonical.stderr)).toEqual({
      ok: false,
      error: {
        code: "CLI_ERROR",
        message: "No local development session was found. Run opencloud app dev start <directory> first.",
        retryable: false,
      },
    });
    expect(branded.status).toBe(1);
    expect(branded.stderr).toBe(
      canonical.stderr.replace("Run opencloud app dev start", "Run sprout app dev start"),
    );
    expect(ignored.stderr).toBe(canonical.stderr);

    // An API error's hint and message follow the brand; its code and fields do not.
    const error = (JSON.parse(api.stderr) as { error: Record<string, unknown> }).error;
    expect(error).toMatchObject({
      code: "ACTIVE_DEPLOYMENT_CHANGED",
      status: 409,
      latestDeploymentId: deploymentId,
      hint: expect.stringMatching(/^Run opencloud pull <directory> /),
      requestId: "request-1",
    });
    const brandedError = (JSON.parse(brandedApi.stderr) as { error: Record<string, unknown> }).error;
    expect(brandedError).toEqual({
      ...error,
      message: "The app's latest release is now planner-2, not the one Sprout recorded for this copy.",
      hint: String(error.hint).replace("Run opencloud pull", "Run sprout pull"),
    });
    expect(Object.keys(brandedError)).toEqual(Object.keys(error));
  });

  it("leaves JSON results and API data unchanged", async () => {
    const list = ["--api-url", apiUrl, "--token", "synthetic-brand", "app", "list"];
    const [canonical, branded, validated, brandedValidated] = await Promise.all([
      run(list),
      run(list, sprout),
      run(["validate", "app"]),
      run(["validate", "app"], sprout),
    ]);
    expect(canonical.status).toBe(0);
    expect(JSON.parse(canonical.stdout)).toEqual(apps);
    expect(branded.stdout).toBe(canonical.stdout);
    // A local result whose bundle warning names OpenCloud.
    expect(validated.status).toBe(0);
    expect(validated.stdout).toContain("OpenCloud builds frontend/dist");
    expect(brandedValidated.stdout).toBe(validated.stdout);
  });
});
