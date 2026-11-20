import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Builds the CLI from source, as `npm run build` does, and runs it against a
// fake control plane to check what it tells people and agents.
const root = fileURLToPath(new URL("..", import.meta.url));
const appId = "40000000-0000-4000-8000-000000000001";

interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

type Responder = (request: Recorded) => { status: number; body: unknown } | undefined;

let temporary: string;
let binary: string;
let server: Server;
let apiUrl: string;
let requests: Recorded[] = [];
let responder: Responder = () => undefined;

beforeAll(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "opencloud-cli-guidance-"));
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
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const recorded = {
      method: request.method ?? "GET",
      path: request.url ?? "/",
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    requests.push(recorded);
    const answer = responder(recorded) ?? { status: 404, body: { code: "NOT_FOUND", message: recorded.path } };
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  responder = () => undefined;
});

/** A fresh home and working folder; with a stored account login when asked. */
async function workspace(name: string, options: { signedIn?: boolean } = {}) {
  const home = path.join(temporary, name, "home");
  const folder = path.join(temporary, name, "work");
  await mkdir(home, { recursive: true });
  await mkdir(folder, { recursive: true });
  if (options.signedIn) {
    const configDirectory =
      process.platform === "darwin"
        ? path.join(home, "Library", "Application Support", "OpenCloud")
        : path.join(home, "opencloud");
    const credentials = path.join(configDirectory, "credentials");
    await mkdir(credentials, { recursive: true, mode: 0o700 });
    const account = `account-${createHash("sha256").update(apiUrl).digest("hex")}`;
    await writeFile(
      path.join(credentials, `${account}.json`),
      JSON.stringify({
        schemaVersion: 1, kind: "account", apiUrl, issuer: apiUrl,
        tokenEndpoint: `${apiUrl}/oauth/token`, revocationEndpoint: `${apiUrl}/oauth/revoke`,
        accessToken: "synthetic-guidance-access", accessExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        refreshToken: "synthetic-guidance-refresh", refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
      { mode: 0o600 },
    );
  }
  return { home, folder };
}

async function run(
  args: string[],
  context: { home: string; folder: string },
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("OPENCLOUD_") && !["INIT_CWD", "DO_NOT_TRACK"].includes(name)) {
      environment[name] = value;
    }
  }
  Object.assign(environment, {
    HOME: context.home, XDG_CONFIG_HOME: context.home, APPDATA: context.home, OPENCLOUD_TELEMETRY: "0",
  }, env);
  const child = spawn(process.execPath, [binary, "--api-url", apiUrl, ...args], {
    cwd: context.folder,
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

/**
 * Each test starts the built CLI several times; beside the rest of the suite
 * on a busy host that can outlast Vitest's 5-second default.
 */
const spawning = { timeout: 30_000 };

const image = `registry.example.test/team/renderer@sha256:${"a".repeat(64)}`;

/** A schema-3 app with an optional manifest tail, scaffolded by `init`. */
async function app(context: { home: string; folder: string }, manifestTail = "") {
  const directory = path.join(context.folder, "app");
  const initialized = await run(["init", directory, "--app-id", appId], context);
  expect(initialized.status, initialized.stderr).toBe(0);
  if (manifestTail) {
    const manifest = path.join(directory, "opencloud.yaml");
    await writeFile(manifest, `${await readFile(manifest, "utf8")}${manifestTail}`);
  }
  return directory;
}

describe("validate", spawning, () => {
  it("names the containers and routes it read", async () => {
    const context = await workspace("validate-summary");
    const directory = await app(context, [
      "containers:",
      "  - name: renderer",
      "    kind: service",
      `    image: ${image}`,
      "    service:",
      "      startupProbe: { path: /ready }",
      "      readinessProbe: { path: /ready }",
      "  - name: thumbnails",
      "    kind: job",
      `    image: ${image}`,
      "    job: {}",
      "routes:",
      "  - id: render",
      "    path: /render",
      "    container: renderer",
      "    methods: [POST]",
      "",
    ].join("\n"));
    const validated = await run(["validate", directory], context);
    expect(validated.status, validated.stderr).toBe(0);
    const summary = JSON.parse(validated.stdout) as Record<string, unknown>;
    expect(summary.containers).toEqual([
      { name: "renderer", kind: "service", image },
      { name: "thumbnails", kind: "job", image },
    ]);
    expect(summary.routes).toEqual([
      { id: "render", path: "/render", container: "renderer", access: "inherit", methods: ["POST"] },
    ]);
  });

  it("prints one readable line per manifest problem instead of Zod's issue tree", async () => {
    const context = await workspace("validate-invalid");
    const directory = await app(context, [
      "containers:",
      "  - name: renderer",
      "    kind: service",
      `    image: ${image}`,
      "    resources: { cpu: 3 }",
      "    service:",
      "      startupProbe: { path: /ready }",
      "      readinessProbe: { path: /ready }",
      "  - name: thumbnails",
      "    kind: job",
      `    image: ${image}`,
      "    resources: { scratchGiB: 5 }",
      "    job:",
      "      outputs: { directory: /work/output, maxFiles: 2, maxTotalGiB: 0.5 }",
      "",
    ].join("\n"));
    const validated = await run(["validate", directory], context);
    expect(validated.status).toBe(1);
    expect(validated.stderr).not.toContain("invalid_union");
    expect(JSON.parse(validated.stderr)).toEqual({
      ok: false,
      error: {
        code: "INVALID_MANIFEST",
        message: "opencloud.yaml has 2 problems: containers[0].resources.cpu: must be one of 1, 2, 4, 8; containers[1].job.outputs.maxTotalGiB: must be a whole number",
        retryable: false,
        issues: [
          { path: "containers[0].resources.cpu", message: "must be one of 1, 2, 4, 8" },
          { path: "containers[1].job.outputs.maxTotalGiB", message: "must be a whole number" },
        ],
      },
    });
  });

  it("reports none for an app without containers or routes", async () => {
    const context = await workspace("validate-empty");
    const validated = await run(["validate", await app(context)], context);
    expect(validated.status, validated.stderr).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({ containers: [], routes: [] });
  });
});

describe("an app command in a folder that is not connected", spawning, () => {
  const operationId = "40000000-0000-4000-8000-0000000000aa";

  it("tells a signed-in person to connect the folder, not to sign in", async () => {
    const context = await workspace("unconnected-signed-in", { signedIn: true });
    const followed = await run(["operation", "get", operationId, "--follow"], context);
    expect(followed.status).toBe(1);
    expect(JSON.parse(followed.stderr)).toEqual({
      ok: false,
      error: {
        code: "WORKSPACE_NOT_CONNECTED",
        message: "This folder is not connected to an app. You are signed in, so run opencloud app connect <app-id> here, or run this command in a folder connected to the app.",
        retryable: false,
      },
    });
    const named = await run(["containers", "get", appId, "renderer"], context);
    expect(JSON.parse(named.stderr).error.message).toContain(`run opencloud app connect ${appId} here`);
    const branded = await run(["containers", "get", appId, "renderer"], context, {
      OPENCLOUD_CLI_PRODUCT_NAME: "Sprout", OPENCLOUD_CLI_COMMAND: "sprout",
    });
    expect(JSON.parse(branded.stderr).error.message).toContain(`run sprout app connect ${appId} here`);
    expect(requests).toEqual([]);
  });

  it("names a directory argument that is not connected", async () => {
    const context = await workspace("unconnected-directory", { signedIn: true });
    await app(context);
    const started = await run(["app", "dev", "start", "app"], context);
    expect(started.status).toBe(1);
    expect(JSON.parse(started.stderr).error).toMatchObject({
      code: "WORKSPACE_NOT_CONNECTED",
      message: "The folder app is not connected to an app. You are signed in, so run opencloud app connect <app-id> in that folder.",
    });
  });

  it("asks for a login first when there is none", async () => {
    const context = await workspace("unconnected-signed-out");
    const followed = await run(["operation", "get", operationId], context);
    expect(JSON.parse(followed.stderr).error).toMatchObject({
      code: "WORKSPACE_NOT_CONNECTED",
      message: "You are not signed in, and this folder is not connected to an app. Run opencloud login, then opencloud app connect <app-id> here.",
    });
  });
});

describe("app request with an app access token", spawning, () => {
  const token = "oc_app_synthetic-guidance-route-token-0123456789";
  const appRecord = () => ({
    id: appId, visibility: "private", state: "active", activeDeploymentId: "40000000-0000-4000-8000-0000000000dd",
    appUrl: "https://guidance.example.test", authUrl: "https://auth.example.test",
  });

  it("tests a private route as the owner with the token named by an environment variable, never printing it", async () => {
    const context = await workspace("request-token");
    responder = (request) => {
      if (request.method === "GET" && request.path === `/v1/apps/${appId}`) return { status: 200, body: appRecord() };
      if (request.method === "POST" && request.path === "/render" && request.headers.host === "guidance.example.test") {
        return request.headers.authorization === `Bearer ${token}`
          ? { status: 200, body: { html: `<h1>${request.body.replace(/^# /, "")}</h1>` } }
          : { status: 401, body: { code: "unauthorized" } };
      }
      return undefined;
    };
    const args = ["--token", "synthetic-control-plane", "app", "request", appId, "/render", "--method", "POST",
      "--body", "# Hello", "--content-type", "text/markdown", "--access-token-env", "ROUTE_TEST_TOKEN", "--show-body"];
    const sent = await run(args, context, { ROUTE_TEST_TOKEN: token, OPENCLOUD_EDGE_URL: apiUrl });
    expect(sent.status, sent.stderr).toBe(0);
    expect(JSON.parse(sent.stdout)).toMatchObject({
      appId, url: "https://guidance.example.test/render", method: "POST", credential: "app_access_token",
      ok: true, status: 200, body: JSON.stringify({ html: "<h1>Hello</h1>" }), bodyTruncated: false,
    });
    expect(sent.stdout + sent.stderr).not.toContain(token);
    const route = requests.find((request) => request.path === "/render");
    expect(route?.headers["content-type"]).toBe("text/markdown");
    expect(requests.filter((request) => request.path === "/render")).toHaveLength(1);
  });

  it("refuses a missing or foreign token, and a body on GET, before sending anything", async () => {
    const context = await workspace("request-token-refused");
    responder = (request) => request.path === `/v1/apps/${appId}` ? { status: 200, body: appRecord() } : undefined;
    const base = ["--token", "synthetic-control-plane", "app", "request", appId, "/render"];
    const missing = await run([...base, "--access-token-env", "ROUTE_TEST_TOKEN"], context, { OPENCLOUD_EDGE_URL: apiUrl });
    expect(JSON.parse(missing.stderr).error).toMatchObject({ code: "ACCESS_TOKEN_MISSING" });
    const foreign = "oc_owner_synthetic-control-plane-credential";
    const wrong = await run([...base, "--access-token-env", "ROUTE_TEST_TOKEN"], context, { ROUTE_TEST_TOKEN: foreign, OPENCLOUD_EDGE_URL: apiUrl });
    expect(JSON.parse(wrong.stderr).error).toMatchObject({ code: "ACCESS_TOKEN_INVALID" });
    expect(wrong.stderr).not.toContain("synthetic-control-plane-credential");
    for (const given of [token, "oc_app_Synthetic0123456789abcdefWithoutHyphens"]) {
      const valueGiven = await run([...base, "--access-token-env", given], context, { OPENCLOUD_EDGE_URL: apiUrl });
      expect(JSON.parse(valueGiven.stderr).error).toMatchObject({ code: "INVALID_OPTION" });
      expect(valueGiven.stderr).not.toContain(given);
    }
    const getBody = await run([...base, "--body", "{}"], context, { OPENCLOUD_EDGE_URL: apiUrl });
    expect(JSON.parse(getBody.stderr).error).toMatchObject({ code: "INVALID_OPTION", message: "A GET request has no body; choose another --method" });
    expect(requests).toEqual([]);
  });
});

describe("log surfaces", spawning, () => {
  it("names the surfaces --surface accepts in both log commands' help", async () => {
    const context = await workspace("log-surfaces");
    for (const args of [["logs", "--help"], ["app", "dev", "logs", "--help"]]) {
      const help = await run(args, context);
      expect(help.status, help.stderr).toBe(0);
      // Commander wraps option text to the terminal's width.
      expect(help.stdout.replace(/\s+/g, " ")).toContain(
        "--surface <surface> where the lines came from: function (the app's Functions), container, http (the edge), ai (the AI gateway) or platform; functions and containers also work, as does runtime, the older name for function and the only one an older OpenCloud knows",
      );
    }
  });
});

describe("metrics names", spawning, () => {
  it("says a metric the app records is read as custom.<name>", async () => {
    const context = await workspace("metrics-names");
    const help = await run(["metrics", "--help"], context);
    expect(help.status, help.stderr).toBe(0);
    const text = help.stdout.replace(/\s+/g, " ");
    expect(text).toContain("--metric <name> a platform series, or custom.<name> for a metric the app records (a container's recordMetric or the browser SDK)");
    expect(text).toContain("rate (per second: a counter's increments, a gauge's change between steps)");
  });
});

describe("app connect", spawning, () => {
  it("says what the folder can do now without naming one kind of agent", async () => {
    const context = await workspace("connect", { signedIn: true });
    responder = (request) =>
      request.method === "POST" && request.path === `/v1/apps/${appId}/cli-connection`
        ? {
            status: 200,
            body: {
              app: { id: appId, name: "Guidance", appUrl: "https://guidance.example.test" },
              credential: { token: "synthetic-guidance-workspace", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
            },
          }
        : undefined;
    const connected = await run(["app", "connect", appId], context);
    expect(connected.status, connected.stderr).toBe(0);
    const result = JSON.parse(connected.stdout) as { state: string; next: string };
    expect(result.state).toBe("connected");
    expect(result.next).toBe(
      "This folder is connected. OpenCloud CLI commands run here can now build, validate, preview, and deploy this app.",
    );
    expect(connected.stdout).not.toContain("synthetic-guidance-workspace");
    expect(JSON.parse(await readFile(path.join(context.folder, ".opencloud", "app.json"), "utf8"))).toMatchObject({ appId });
  });
});
