import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
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

type Answer = { status: number; body: unknown } | undefined;
type Responder = (request: Recorded) => Answer | Promise<Answer>;

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
    const answer = (await responder(recorded)) ?? { status: 404, body: { code: "NOT_FOUND", message: recorded.path } };
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

/** Simulates 60s passing after SIGKILL so proper-lockfile reclaims the crashed process's lock immediately. */
async function ageJournalLocks(roots: string[]): Promise<void> {
  const past = new Date(Date.now() - 60_000);
  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".lock")) {
          await utimes(full, past, past);
        } else {
          await visit(full);
        }
      }
    }
  };
  for (const rootDir of roots) await visit(rootDir);
}

async function run(
  args: string[],
  context: { home: string; folder: string },
  env: Record<string, string> = {},
  onChild?: (child: ReturnType<typeof spawn>) => void,
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
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
  onChild?.(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const outcome = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  return { ...outcome, stdout, stderr };
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
    // init pins SDK 2.3.0; containers added to it are told which SDK they need.
    expect(summary.warnings).toContainEqual({
      code: "CONTAINERS_NEED_SDK_2_9", path: "opencloud.yaml",
      message: "opencloud.yaml declares containers but pins runtime SDK 2.3.0; Functions can call containers only from SDK 2.9.0. Set runtime.sdk.version: 2.9.0 in opencloud.yaml.",
    });
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

  it("tells a signed-in person to connect the folder, not to sign in, for a command that needs it", async () => {
    const context = await workspace("unconnected-signed-in", { signedIn: true });
    // Container, log and metric reads need the app's own connection.
    const named = await run(["containers", "get", appId, "renderer"], context);
    expect(named.status).toBe(1);
    expect(JSON.parse(named.stderr)).toEqual({
      ok: false,
      error: {
        code: "WORKSPACE_NOT_CONNECTED",
        message: `This folder is not connected to an app. You are signed in, so run opencloud app connect ${appId} here, or run this command in a folder connected to the app. Your login reads an app, its deployments and operations from anywhere, but this command needs the app's own connection.`,
        retryable: false,
      },
    });
    const branded = await run(["containers", "get", appId, "renderer"], context, {
      OPENCLOUD_CLI_PRODUCT_NAME: "Sprout", OPENCLOUD_CLI_COMMAND: "sprout",
    });
    expect(JSON.parse(branded.stderr).error.message).toContain(`run sprout app connect ${appId} here`);
    expect(requests).toEqual([]);
  });

  it("reads an app's deployments and operations with the account login from any folder", async () => {
    const context = await workspace("unconnected-reads", { signedIn: true });
    const operation = { id: operationId, appId, deploymentId: null, type: "deploy", state: "succeeded", actorType: "user", actorId: appId,
      idempotencyKey: "server-redacted", error: null, createdAt: "2026-11-20T05:00:00.000Z", updatedAt: "2026-11-20T05:01:00.000Z" };
    responder = (request) => request.path === `/v1/apps/${appId}/deployments` ? { status: 200, body: [] }
      : request.path === `/v1/operations/${operationId}` ? { status: 200, body: operation } : undefined;
    const listed = await run(["deployment", "list", appId], context);
    expect(listed.status, listed.stderr).toBe(0);
    const followed = await run(["operation", "get", operationId, "--follow"], context);
    expect(followed.status, followed.stderr).toBe(0);
    expect(JSON.parse(followed.stdout)).toMatchObject({ id: operationId, state: "succeeded" });
    expect(requests.map((request) => request.headers.authorization)).toEqual(requests.map(() => "Bearer synthetic-guidance-access"));
  });

  it("names a directory argument that is not connected", async () => {
    const context = await workspace("unconnected-directory", { signedIn: true });
    await app(context);
    const started = await run(["app", "dev", "start", "app"], context);
    expect(started.status).toBe(1);
    expect(JSON.parse(started.stderr).error).toMatchObject({
      code: "WORKSPACE_NOT_CONNECTED",
      message: "The folder app is not connected to an app. You are signed in, so run opencloud app connect <app-id> in that folder. Your login reads an app, its deployments and operations from anywhere, but this command needs the app's own connection.",
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
    // A local test app: its own address is this machine, so plain HTTP is allowed.
    const localApp = () => ({ ...appRecord(), appUrl: apiUrl });
    responder = (request) => {
      if (request.method === "GET" && request.path === `/v1/apps/${appId}`) return { status: 200, body: localApp() };
      if (request.method === "POST" && request.path === "/render" && request.headers.host === new URL(apiUrl).host) {
        return request.headers.authorization === `Bearer ${token}`
          ? { status: 200, body: { html: `<h1>${request.body.replace(/^# /, "")}</h1>` } }
          : { status: 401, body: { code: "unauthorized" } };
      }
      return undefined;
    };
    const args = ["--token", "synthetic-control-plane", "app", "request", appId, "/render", "--method", "POST",
      "--body", "# Hello", "--content-type", "text/markdown", "--access-token-env", "ROUTE_TEST_TOKEN", "--show-body"];
    const sent = await run(args, context, { ROUTE_TEST_TOKEN: token });
    expect(sent.status, sent.stderr).toBe(0);
    expect(JSON.parse(sent.stdout)).toMatchObject({
      appId, url: `${apiUrl}/render`, method: "POST", credential: "app_access_token",
      ok: true, status: 200, body: JSON.stringify({ html: "<h1>Hello</h1>" }), bodyTruncated: false,
    });
    expect(sent.stdout + sent.stderr).not.toContain(token);
    const route = requests.find((request) => request.path === "/render");
    expect(route?.headers["content-type"]).toBe("text/markdown");
    expect(requests.filter((request) => request.path === "/render")).toHaveLength(1);
    // K12: an edge adapter would carry the token to another host, so it is refused first.
    const routed = await run(args, context, { ROUTE_TEST_TOKEN: token, OPENCLOUD_EDGE_URL: apiUrl });
    expect(JSON.parse(routed.stderr).error).toMatchObject({ code: "ACCESS_TOKEN_DESTINATION_REFUSED" });
    expect(routed.stdout + routed.stderr).not.toContain(token);
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
    // S5: a variable whose name starts with OC_ is a name, not a token.
    const unset = await run([...base, "--access-token-env", "OC_FOO"], context, { OC_FOO: "", OPENCLOUD_EDGE_URL: apiUrl });
    expect(JSON.parse(unset.stderr).error).toMatchObject({ code: "ACCESS_TOKEN_MISSING", message: expect.stringContaining("The environment variable OC_FOO is not set") });
    const named = await run([...base, "--access-token-env", "OC_FOO"], context, { OC_FOO: foreign, OPENCLOUD_EDGE_URL: apiUrl });
    expect(JSON.parse(named.stderr).error).toMatchObject({ code: "ACCESS_TOKEN_INVALID" });
    for (const given of [token, "oc_app_Synthetic0123456789abcdefWithoutHyphens", `gh${"p_"}${"A1".repeat(18)}`]) {
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
  it("takes --page on both log commands and says when each returns a page", async () => {
    const context = await workspace("log-pages");
    const production = (await run(["logs", "--help"], context)).stdout.replace(/\s+/g, " ");
    expect(production).toContain("a normalized page with --page or any page filter, otherwise the raw query answer earlier CLIs printed");
    const development = (await run(["app", "dev", "logs", "--help"], context)).stdout.replace(/\s+/g, " ");
    expect(development).toContain("always as a normalized page with cursor and source freshness");
    expect(development).toContain("--page accepted, as logs takes it: this command always returns a page");
  });

  it("names the surfaces --surface accepts in both log commands' help", async () => {
    const context = await workspace("log-surfaces");
    for (const args of [["logs", "--help"], ["app", "dev", "logs", "--help"]]) {
      const help = await run(args, context);
      expect(help.status, help.stderr).toBe(0);
      // Commander wraps option text to the terminal's width.
      expect(help.stdout.replace(/\s+/g, " ")).toContain(
        "--surface <surface> where the lines came from: function (the app's Functions), container, http (the edge), ai (the AI gateway) or platform; functions and containers also work, page, rest and storage select http, and runtime is the older name for function and the only one an older OpenCloud knows",
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
    // How to read the answer: series labels and [timestamp, value] points.
    expect(text).toContain(`"values":[[<unix seconds>,"<value>"], ...]} at most one point per step, at its start`);
    expect(text).toContain("A step is --step seconds, or longer when a long window would need too many points.");
    expect(text).toContain("A custom.<name> metric has one series per dimension set");
  });
});

describe("account commands' idempotency keys", spawning, () => {
  it("refuses a credential-shaped key before sending anything, without repeating it", async () => {
    const context = await workspace("account-key-credential");
    const zip = path.join(context.folder, "app.zip");
    await writeFile(zip, "PK synthetic");
    const importId = "40000000-0000-4000-8000-0000000000c1";
    // Built from parts, so no complete synthetic secret sits in the source.
    const key = `oc_${"cli_"}${"Synthetic0123456789".repeat(2)}`;
    for (const args of [
      ["app", "import", "upload", zip],
      ["app", "import", "from-url", "https://example.test/app.zip", "--sha256", "a".repeat(64), "--bytes", "12"],
      ["app", "import", "stage", importId],
      ["app", "import", "install", importId, "--name", "Copy"],
      ["app", "import", "publish", importId],
    ]) {
      requests = [];
      const refused = await run(["--token", "synthetic-token", ...args, "--idempotency-key", key], context);
      expect(refused.status, args.join(" ")).toBe(1);
      const error = JSON.parse(refused.stderr.trim().split("\n").at(-1)!).error as { code: string; message: string };
      expect(error.code, args.join(" ")).toBe("INVALID_IDEMPOTENCY_KEY");
      expect(error.message).toContain("an OpenCloud access token");
      expect(refused.stderr).not.toContain(key);
      expect(requests).toEqual([]);
    }
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

describe("cross-app operation get inside a connected folder", spawning, () => {
  const otherAppId = "40000000-0000-4000-8000-000000000002";
  const operationId = "40000000-0000-4000-8000-0000000000bb";

  async function connectFolder(context: { home: string; folder: string }, token = "synthetic-app-a-workspace") {
    responder = (request) =>
      request.method === "POST" && request.path === `/v1/apps/${appId}/cli-connection`
        ? {
            status: 200,
            body: {
              app: { id: appId, name: "AppA", appUrl: "https://appa.example.test" },
              credential: { token, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
            },
          }
        : undefined;
    const connected = await run(["app", "connect", appId], context);
    expect(connected.status, connected.stderr).toBe(0);
    requests = [];
  }

  function accountFile(context: { home: string }) {
    const configDirectory =
      process.platform === "darwin"
        ? path.join(context.home, "Library", "Application Support", "OpenCloud")
        : path.join(context.home, "opencloud");
    return path.join(configDirectory, "credentials", `account-${createHash("sha256").update(apiUrl).digest("hex")}.json`);
  }

  it("reads another app's operation with the account login once OpenCloud refuses the folder's credential", async () => {
    const context = await workspace("cross-app-op-get", { signedIn: true });
    await connectFolder(context);
    const op = {
      id: operationId, appId: otherAppId, deploymentId: null, type: "deploy", state: "succeeded",
      actorType: "user", actorId: appId, idempotencyKey: "server-redacted", error: null,
      createdAt: "2026-11-20T05:00:00.000Z", updatedAt: "2026-11-20T05:01:00.000Z",
    };
    responder = (request) =>
      request.path === `/v1/operations/${operationId}`
        ? (request.headers.authorization === "Bearer synthetic-guidance-access"
          ? { status: 200, body: op }
          : { status: 403, body: { code: "FORBIDDEN", message: "Credential is not authorized for this app" } })
        : undefined;
    const got = await run(["operation", "get", operationId], context);
    expect(got.status, got.stderr).toBe(0);
    expect(JSON.parse(got.stdout)).toMatchObject({ id: operationId, appId: otherAppId });
    expect(requests.map((r) => r.headers.authorization)).toEqual(["Bearer synthetic-app-a-workspace", "Bearer synthetic-guidance-access"]);
  });

  it("reads the folder's own operation with its credential while the account login has expired", async () => {
    const context = await workspace("op-get-expired-login", { signedIn: true });
    await connectFolder(context);
    const stored = JSON.parse(await readFile(accountFile(context), "utf8")) as Record<string, unknown>;
    await writeFile(accountFile(context), JSON.stringify({
      ...stored,
      accessExpiresAt: new Date(Date.now() - 900_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    }), { mode: 0o600 });
    const op = {
      id: operationId, appId, deploymentId: null, type: "deploy", state: "succeeded",
      actorType: "user", actorId: appId, idempotencyKey: "server-redacted", error: null,
      createdAt: "2026-11-20T05:00:00.000Z", updatedAt: "2026-11-20T05:01:00.000Z",
    };
    responder = (request) => request.path === `/v1/operations/${operationId}` ? { status: 200, body: op } : undefined;
    const got = await run(["operation", "get", operationId], context);
    expect(got.status, got.stderr).toBe(0);
    expect(JSON.parse(got.stdout)).toMatchObject({ id: operationId, appId });
    expect(requests.map((r) => r.headers.authorization)).toEqual(["Bearer synthetic-app-a-workspace"]);
  });

  it("uses the connected folder credential for operation get when no account login exists", async () => {
    const context = await workspace("op-get-workspace-fallback", { signedIn: true });
    await connectFolder(context, "synthetic-only-workspace");
    // Remove account login file so only workspace binding + credential remains.
    await rm(accountFile(context));
    const op = {
      id: operationId, appId, deploymentId: null, type: "deploy", state: "succeeded",
      actorType: "user", actorId: appId, idempotencyKey: "server-redacted", error: null,
      createdAt: "2026-11-20T05:00:00.000Z", updatedAt: "2026-11-20T05:01:00.000Z",
    };
    responder = (request) => request.path === `/v1/operations/${operationId}` ? { status: 200, body: op } : undefined;
    const got = await run(["operation", "get", operationId], context);
    expect(got.status, got.stderr).toBe(0);
    expect(requests.map((r) => r.headers.authorization)).toEqual(["Bearer synthetic-only-workspace"]);
  });
});

describe("live release verification, journal settlement, rejoin dead-ends, and dev start hints", spawning, () => {
  const now = "2026-11-21T12:00:00.000Z";
  const actorId = "40000000-0000-4000-8000-000000000009";
  const baseDeploymentId = "40000000-0000-4000-8000-000000000010";
  const deployedId = "40000000-0000-4000-8000-000000000011";
  const otherDeploymentId = "40000000-0000-4000-8000-000000000012";
  const draftId = "40000000-0000-4000-8000-000000000020";
  const deployOpId = "40000000-0000-4000-8000-000000000030";
  const verifyId1 = "40000000-0000-4000-8000-000000000041";
  const verifyOpId1 = "40000000-0000-4000-8000-000000000042";
  const verifyId2 = "40000000-0000-4000-8000-000000000043";
  const verifyOpId2 = "40000000-0000-4000-8000-000000000044";
  const devSessionId = "40000000-0000-4000-8000-000000000050";

  function baseVersion() {
    return {
      version: "9.9.9", commit: "test", builtAt: now, releaseId: "platform-v9.9.9",
      contracts: { cliMutationJournal: 1, releaseSource: 1, deployPreconditions: 1, platformBuilds: 1, pinnedDraftValidation: 1 },
    };
  }

  function validationPayload(id: string, dId: string, revision: number, digest: string) {
    return {
      id, draftId: dId, revision, passed: true, artifactSha256: digest,
      manifest: null, canonicalSourceManifest: "opencloud.yaml", sourceManifest: null,
      sourceFiles: [], artifactFiles: [], diagnostics: [],
      nextAction: "Deploy the validated draft.", createdAt: now,
    };
  }

  function devSessionPayload(status: string, revId: string, receiptId: string, digest: string) {
    return {
      id: devSessionId, appId, draftId, status, baseDeploymentId: null,
      previewUrl: "https://dev.example.test", browserPreviewUrl: "https://preview.example.test",
      activeRevision: { id: revId, draftRevision: 2, artifactSha256: digest, migrationDigest: "b".repeat(64) },
      verification: { receiptId, revisionId: revId, expiresAt: "2026-12-01T12:00:00.000Z" },
      capabilities: {
        frontend: true, database: true, functions: true, jobs: true, files: true,
        productionSecrets: false, cron: false, syntheticAuth: true,
        emailCapture: true, emailInboundInjection: true, notificationCapture: true,
      },
      createdAt: now, updatedAt: now, lastActivityAt: now, expiresAt: "2026-12-01T12:00:00.000Z",
    };
  }

  function makeDeployResponder(options: {
    verifyResponse: (req: Recorded) => { status: number; body: unknown };
    verificationRecord?: () => unknown;
    verifyOp?: () => unknown;
    localDigest: string;
    reports?: Recorded[];
  }): Responder {
    let draftRevision = 1;
    const files = new Map<string, { sha256: string }>();
    return (request) => {
      if (request.path === "/v1/platform-errors/reports") {
        options.reports?.push(request);
        return { status: 202, body: { accepted: true } };
      }
      if (request.path === "/version") return { status: 200, body: baseVersion() };
      if (request.path === "/v1/installation") return { status: 404, body: { code: "NOT_FOUND", message: "not found" } };
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/drafts`) {
        draftRevision = 1;
        files.clear();
        return { status: 201, body: { id: draftId, appId, baseDeploymentId: null, name: "CLI", status: "open", revision: 1, createdAt: now, updatedAt: now, deployedAt: null } };
      }
      if (request.method === "GET" && request.path === `/v1/apps/${appId}/drafts/${draftId}`) {
        return { status: 200, body: { id: draftId, appId, baseDeploymentId: null, name: "CLI", status: "open", revision: draftRevision, createdAt: now, updatedAt: now, deployedAt: null } };
      }
      if (request.method === "GET" && request.path === `/v1/apps/${appId}/drafts/${draftId}/files`) {
        return { status: 200, body: [...files].map(([p, v]) => ({ path: p, sha256: v.sha256, baseSha256: null, sizeBytes: 1, deleted: false, updatedAt: now })) };
      }
      if (request.method === "PATCH" && request.path === `/v1/apps/${appId}/drafts/${draftId}/files`) {
        const body = JSON.parse(request.body) as { changes: Array<{ path: string; contentBase64?: string; delete?: boolean }> };
        for (const c of body.changes) {
          if (c.delete) files.delete(c.path);
          else files.set(c.path, { sha256: createHash("sha256").update(Buffer.from(c.contentBase64!, "base64")).digest("hex") });
        }
        draftRevision += 1;
        return { status: 200, body: { draft: { id: draftId, appId, baseDeploymentId: null, name: "CLI", status: "open", revision: draftRevision, createdAt: now, updatedAt: now, deployedAt: null }, files: [] } };
      }
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/drafts/${draftId}/validate`) {
        return { status: 200, body: validationPayload("40000000-0000-4000-8000-000000000060", draftId, draftRevision, options.localDigest) };
      }
      if (request.method === "POST" && request.path.startsWith(`/v1/apps/${appId}/drafts/${draftId}/deploy`)) {
        return {
          status: 201,
          body: {
            draft: { id: draftId, appId, baseDeploymentId: null, name: "CLI", status: "deployed", revision: draftRevision, createdAt: now, updatedAt: now, deployedAt: now },
            deployment: { id: deployedId, appId, version: "app-20261121-1", artifactSha256: options.localDigest, sdkVersion: "2.3.0", manifest: {}, state: "active", rollbackOfDeploymentId: null, error: null, createdAt: now, activatedAt: now, source: null },
            operation: { id: deployOpId, appId, deploymentId: deployedId, type: "deploy", state: "succeeded", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now },
          },
        };
      }
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/verifications`) {
        return options.verifyResponse(request);
      }
      if (request.method === "GET" && request.path === `/v1/operations/${verifyOpId1}`) {
        return { status: 200, body: options.verifyOp?.() };
      }
      if (request.method === "GET" && request.path === `/v1/apps/${appId}/verifications/${verifyId1}`) {
        return { status: 200, body: options.verificationRecord?.() };
      }
      return undefined;
    };
  }

  it("skips verifyLiveRelease on deploy --no-follow, and skips non-fatally when credential lacks app:observe on deploy and rollback", async () => {
    const context = await workspace("deploy-verify-edge");
    const directory = await app(context);
    const localDigest = (JSON.parse((await run(["validate", directory], context)).stdout) as { artifactSha256: string }).artifactSha256;

    // 1. deploy --no-follow must NOT call verifyApp even when deploy operation is already succeeded.
    responder = makeDeployResponder({
      localDigest,
      verifyResponse: () => ({ status: 500, body: { code: "SHOULD_NOT_BE_CALLED" } }),
    });
    const noFollow = await run(["--token", "synthetic-deploy-only", "deploy", directory, "--no-follow"], context);
    expect(noFollow.status, noFollow.stderr).toBe(0);
    expect(requests.some((r) => r.path === `/v1/apps/${appId}/verifications`)).toBe(false);
    expect("verification" in JSON.parse(noFollow.stdout)).toBe(false);

    // 2. Least-privilege credential (app:deploy without app:observe -> 403): deploy succeeds with verification skipped!
    requests = [];
    responder = makeDeployResponder({
      localDigest,
      verifyResponse: () => ({ status: 403, body: { statusCode: 403, message: "Credential is not authorized for this app" } }),
    });
    const deploySkipped = await run(["--token", "synthetic-deploy-only", "deploy", directory, "--force"], context);
    expect(deploySkipped.status, deploySkipped.stderr).toBe(0);
    expect(deploySkipped.stderr).toContain("app:observe");
    expect(JSON.parse(deploySkipped.stdout)).toMatchObject({
      verification: { state: "skipped", reason: "MISSING_OBSERVE_SCOPE" },
    });

    // 3. Same for deployment rollback with app:rollback token lacking app:observe.
    requests = [];
    responder = (request) => {
      if (request.path === "/version") return { status: 200, body: baseVersion() };
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/deployments/${deployedId}/rollback`) {
        return {
          status: 201,
          body: {
            operation: { id: deployOpId, appId, deploymentId: deployedId, type: "rollback", state: "succeeded", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now },
          },
        };
      }
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/verifications`) {
        return { status: 403, body: { code: "INSUFFICIENT_SCOPE", message: "app:observe required" } };
      }
      return undefined;
    };
    const rollbackSkipped = await run(["--token", "synthetic-rollback-only", "deployment", "rollback", appId, deployedId], context);
    expect(rollbackSkipped.status, rollbackSkipped.stderr).toBe(0);
    expect(rollbackSkipped.stderr).toContain("app:observe");
    expect(JSON.parse(rollbackSkipped.stdout)).toMatchObject({
      verification: { state: "skipped", reason: "MISSING_OBSERVE_SCOPE" },
    });

    // 4. A non-scope 403 (e.g. COMPUTE_NOT_ENABLED) is NOT swallowed as missing scope.
    requests = [];
    responder = makeDeployResponder({
      localDigest,
      verifyResponse: () => ({ status: 403, body: { statusCode: 403, code: "COMPUTE_NOT_ENABLED", message: "Container compute is not enabled for this account." } }),
    });
    const nonScope403 = await run(["--token", "synthetic-deploy-only", "deploy", directory, "--force"], context);
    expect(nonScope403.status).toBe(1);
    expect(JSON.parse(nonScope403.stderr.trim().split("\n").at(-1)!).error.code).toBe("COMPUTE_NOT_ENABLED");
  });

  it("rejects mismatched verification deploymentId, handles empty terminal operation error, and reports platform faults but not app faults", async () => {
    const context = await workspace("deploy-verify-classification");
    const directory = await app(context);
    const localDigest = (JSON.parse((await run(["validate", directory], context)).stdout) as { artifactSha256: string }).artifactSha256;

    // 1. Mismatched deploymentId even when verification passed -> VERIFICATION_FAILED, the caller's
    // conflict (someone else deployed in between): not reported, and the replaced release is not the base.
    const mismatchReports: Recorded[] = [];
    responder = makeDeployResponder({
      localDigest,
      reports: mismatchReports,
      verifyResponse: () => ({
        status: 201,
        body: {
          verification: { id: verifyId1, appId, deploymentId: otherDeploymentId, operationId: verifyOpId1, state: "passed", phases: [], diagnostics: [], startedAt: now, finishedAt: now, createdAt: now },
          operation: { id: verifyOpId1, appId, deploymentId: otherDeploymentId, type: "verify_app", state: "succeeded", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now },
        },
      }),
      verificationRecord: () => ({ id: verifyId1, appId, deploymentId: otherDeploymentId, operationId: verifyOpId1, state: "passed", phases: [], diagnostics: [], startedAt: now, finishedAt: now, createdAt: now }),
    });
    const mismatch = await run(["--token", "synthetic-token", "deploy", directory, "--force"], context, { OPENCLOUD_TELEMETRY: "1" });
    expect(mismatch.status).toBe(1);
    expect(JSON.parse(mismatch.stderr.trim().split("\n").at(-1)!).error).toMatchObject({
      code: "VERIFICATION_FAILED",
      verificationCode: "ACTIVE_DEPLOYMENT_MISMATCH",
      deploymentId: deployedId,
      verifiedDeploymentId: otherDeploymentId,
    });
    expect(JSON.parse(mismatch.stderr.trim().split("\n").at(-1)!).error.hint).toContain(`opencloud deployment list ${appId}`);
    expect(mismatchReports.length).toBe(0);
    await expect(readFile(path.join(directory, ".opencloud", "base.json"), "utf8")).rejects.toThrow();

    // 2. Terminal verify_app failure with empty error: {} must still fail (not treat as passed!).
    responder = makeDeployResponder({
      localDigest,
      verifyResponse: () => ({
        status: 201,
        body: {
          verification: { id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "passed", phases: [], diagnostics: [], startedAt: now, finishedAt: now, createdAt: now },
          operation: { id: verifyOpId1, appId, deploymentId: deployedId, type: "verify_app", state: "failed", actorType: "user", actorId, idempotencyKey: "server-redacted", error: {}, createdAt: now, updatedAt: now },
        },
      }),
      verificationRecord: () => ({ id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "passed", phases: [], diagnostics: [], startedAt: now, finishedAt: now, createdAt: now }),
    });
    const emptyOpErr = await run(["--token", "synthetic-token", "deploy", directory, "--force"], context);
    expect(emptyOpErr.status).toBe(1);
    expect(JSON.parse(emptyOpErr.stderr.trim().split("\n").at(-1)!).error).toMatchObject({
      code: "VERIFICATION_FAILED",
      deploymentId: deployedId,
    });

    // 3. Platform fault (ARTIFACT_INTEGRITY_FAILED) is reported; app fault (COMPUTE_CRASH_LOOP) is NOT reported.
    const platformReports: Recorded[] = [];
    responder = makeDeployResponder({
      localDigest,
      reports: platformReports,
      verifyResponse: () => ({
        status: 201,
        body: {
          verification: { id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "failed", phases: [], diagnostics: [{ level: "error", code: "ARTIFACT_INTEGRITY_FAILED", message: "missing object" }], startedAt: now, finishedAt: now, createdAt: now },
          operation: { id: verifyOpId1, appId, deploymentId: deployedId, type: "verify_app", state: "failed", actorType: "user", actorId, idempotencyKey: "server-redacted", error: { code: "ARTIFACT_INTEGRITY_FAILED", message: "missing object" }, createdAt: now, updatedAt: now },
        },
      }),
      verificationRecord: () => ({ id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "failed", phases: [], diagnostics: [{ level: "error", code: "ARTIFACT_INTEGRITY_FAILED", message: "missing object" }], startedAt: now, finishedAt: now, createdAt: now }),
    });
    const platformFail = await run(["--token", "synthetic-token", "deploy", directory, "--force"], context, { OPENCLOUD_TELEMETRY: "1" });
    expect(platformFail.status).toBe(1);
    expect(platformReports.length).toBe(1);

    const appReports: Recorded[] = [];
    responder = makeDeployResponder({
      localDigest,
      reports: appReports,
      verifyResponse: () => ({
        status: 201,
        body: {
          verification: { id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "failed", phases: [], diagnostics: [{ level: "error", code: "COMPUTE_CRASH_LOOP", message: "worker crashed" }], startedAt: now, finishedAt: now, createdAt: now },
          operation: { id: verifyOpId1, appId, deploymentId: deployedId, type: "verify_app", state: "failed", actorType: "user", actorId, idempotencyKey: "server-redacted", error: { code: "COMPUTE_CRASH_LOOP", message: "worker crashed" }, createdAt: now, updatedAt: now },
        },
      }),
      verificationRecord: () => ({ id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "failed", phases: [], diagnostics: [{ level: "error", code: "COMPUTE_CRASH_LOOP", message: "worker crashed" }], startedAt: now, finishedAt: now, createdAt: now }),
    });
    const appFail = await run(["--token", "synthetic-token", "deploy", directory, "--force"], context, { OPENCLOUD_TELEMETRY: "1" });
    expect(appFail.status).toBe(1);
    expect(appReports.length).toBe(0);
  });

  it("reports a canonical HEAD with no answer, not the app's own HTTP status, and keeps a release no longer active out of base.json", async () => {
    const context = await workspace("deploy-verify-head-and-replaced");
    const directory = await app(context);
    const localDigest = (JSON.parse((await run(["validate", directory], context)).stdout) as { artifactSha256: string }).artifactSha256;
    const baseFile = path.join(directory, ".opencloud", "base.json");
    const failing = (code: string, message: string, reports: Recorded[]) => {
      const failed = { id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "failed", phases: [], diagnostics: [{ level: "error", code, message }], startedAt: now, finishedAt: now, createdAt: now };
      return makeDeployResponder({
        localDigest,
        reports,
        verifyResponse: () => ({
          status: 201,
          body: {
            verification: failed,
            operation: { id: verifyOpId1, appId, deploymentId: deployedId, type: "verify_app", state: "failed", actorType: "user", actorId, idempotencyKey: "server-redacted", error: { code, message }, createdAt: now, updatedAt: now },
          },
        }),
        verificationRecord: () => failed,
      });
    };
    const deploy = () => run(["--token", "synthetic-token", "deploy", directory, "--force"], context, { OPENCLOUD_TELEMETRY: "1" });

    // A public app whose container frontend answers HEAD / with 405 failed for its own reason.
    const appReports: Recorded[] = [];
    responder = failing("CANONICAL_HEAD_FAILED", "Canonical production HEAD returned HTTP 405", appReports);
    const appHead = await deploy();
    expect(appHead.status).toBe(1);
    expect(JSON.parse(appHead.stderr.trim().split("\n").at(-1)!).error).toMatchObject({ code: "VERIFICATION_FAILED", verificationCode: "CANONICAL_HEAD_FAILED" });
    expect(appReports.length).toBe(0);

    // No answer at all is the platform's.
    const platformReports: Recorded[] = [];
    responder = failing("CANONICAL_HEAD_FAILED", "fetch failed", platformReports);
    expect((await deploy()).status).toBe(1);
    expect(platformReports.length).toBe(1);
    // So are 502, 503 and 504, which the platform's own router answers when it can't reach the app.
    for (const status of [502, 503, 504]) {
      const routerReports: Recorded[] = [];
      responder = failing("CANONICAL_HEAD_FAILED", `Canonical production HEAD returned HTTP ${status}`, routerReports);
      expect((await deploy()).status).toBe(1);
      expect(routerReports.length, String(status)).toBe(1);
    }

    // The release was no longer active when verified: the caller's conflict, and not the copy's base.
    await rm(baseFile, { force: true });
    const replacedReports: Recorded[] = [];
    responder = failing("ACTIVE_DEPLOYMENT_MISMATCH", "The recorded deployment is no longer the exact active deployment", replacedReports);
    const replaced = await deploy();
    expect(replaced.status).toBe(1);
    expect(JSON.parse(replaced.stderr.trim().split("\n").at(-1)!).error).toMatchObject({
      code: "VERIFICATION_FAILED", verificationCode: "ACTIVE_DEPLOYMENT_MISMATCH", deploymentId: deployedId,
    });
    expect(replacedReports.length).toBe(0);
    await expect(readFile(baseFile, "utf8")).rejects.toThrow();
  });

  it("settles opencloud app verify journal on failure so re-running starts a fresh verification", async () => {
    const context = await workspace("app-verify-settles");
    let attempt = 0;
    const keys: string[] = [];
    responder = (request) => {
      if (request.path === "/version") return { status: 200, body: baseVersion() };
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/verifications`) {
        attempt += 1;
        keys.push(String(request.headers["idempotency-key"]));
        if (attempt === 1) {
          return {
            status: 201,
            body: {
              verification: { id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "failed", phases: [], diagnostics: [{ level: "error", code: "COMPUTE_CRASH_LOOP", message: "worker crashed" }], startedAt: now, finishedAt: now, createdAt: now },
              operation: { id: verifyOpId1, appId, deploymentId: deployedId, type: "verify_app", state: "failed", actorType: "user", actorId, idempotencyKey: "server-redacted", error: { code: "COMPUTE_CRASH_LOOP", message: "worker crashed" }, createdAt: now, updatedAt: now },
            },
          };
        }
        return {
          status: 201,
          body: {
            verification: { id: verifyId2, appId, deploymentId: deployedId, operationId: verifyOpId2, state: "passed", phases: [], diagnostics: [], startedAt: now, finishedAt: now, createdAt: now },
            operation: { id: verifyOpId2, appId, deploymentId: deployedId, type: "verify_app", state: "succeeded", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now },
          },
        };
      }
      if (request.method === "GET" && request.path === `/v1/apps/${appId}/verifications/${verifyId2}`) {
        return { status: 200, body: { id: verifyId2, appId, deploymentId: deployedId, operationId: verifyOpId2, state: "passed", phases: [], diagnostics: [], startedAt: now, finishedAt: now, createdAt: now } };
      }
      return undefined;
    };
    const first = await run(["--token", "synthetic-token", "app", "verify", appId], context);
    expect(first.status).toBe(1);
    const second = await run(["--token", "synthetic-token", "app", "verify", appId], context);
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ verification: { id: verifyId2, state: "passed" } });
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("settles app dev promote journal when promotion deployment fails so the next promote is not wedged", async () => {
    const context = await workspace("dev-promote-settles");
    const directory = await app(context);
    const localDigest = (JSON.parse((await run(["validate", directory], context)).stdout) as { artifactSha256: string }).artifactSha256;
    await mkdir(path.join(directory, ".opencloud"), { recursive: true });
    await writeFile(path.join(directory, ".opencloud", "dev.json"), JSON.stringify({
      schemaVersion: 1, appId, draftId, sessionId: devSessionId, artifactSha256: localDigest, updatedAt: now,
    }));
    const revId = "40000000-0000-4000-8000-000000000070";
    const receiptId = "40000000-0000-4000-8000-000000000071";
    const promoteOp1 = "40000000-0000-4000-8000-000000000072";
    const promoteOp2 = "40000000-0000-4000-8000-000000000073";
    let promoteAttempt = 0;
    const promoteKeys: string[] = [];
    responder = (request) => {
      if (request.path === "/version") return { status: 200, body: baseVersion() };
      if (request.method === "GET" && request.path === `/v1/apps/${appId}/dev-sessions/${devSessionId}`) {
        return {
          status: 200,
          body: devSessionPayload("running", revId, receiptId, localDigest),
        };
      }
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/dev-sessions/${devSessionId}/promote`) {
        promoteAttempt += 1;
        promoteKeys.push(String(request.headers["idempotency-key"]));
        const opId = promoteAttempt === 1 ? promoteOp1 : promoteOp2;
        return {
          status: 201,
          body: {
            draft: { id: draftId, appId, baseDeploymentId: null, name: "Dev", status: "deploying", revision: 2, createdAt: now, updatedAt: now, deployedAt: null },
            deployment: { id: deployedId, appId, version: "app-20261121-1", artifactSha256: localDigest, sdkVersion: "2.3.0", manifest: {}, state: "deploying", rollbackOfDeploymentId: null, error: null, createdAt: now, activatedAt: null, source: null },
            operation: { id: opId, appId, deploymentId: deployedId, type: "deploy", state: "queued", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now },
          },
        };
      }
      if (request.method === "GET" && request.path === `/v1/operations/${promoteOp1}`) {
        return {
          status: 200,
          body: {
            id: promoteOp1, appId, deploymentId: deployedId, type: "deploy", state: "failed", actorType: "user", actorId,
            idempotencyKey: "server-redacted", error: { code: "DEPLOYMENT_COMPENSATED", message: "compensated" }, createdAt: now, updatedAt: now,
          },
        };
      }
      if (request.method === "GET" && request.path === `/v1/apps/${appId}/deployments/${deployedId}`) {
        return {
          status: 200,
          body: { id: deployedId, appId, version: "app-20261121-1", artifactSha256: localDigest, sdkVersion: "2.3.0", manifest: {}, state: "failed", rollbackOfDeploymentId: null, error: null, createdAt: now, activatedAt: null, source: null },
        };
      }
      if (request.method === "GET" && request.path === `/v1/operations/${promoteOp2}`) {
        return {
          status: 200,
          body: {
            id: promoteOp2, appId, deploymentId: deployedId, type: "deploy", state: "succeeded", actorType: "user", actorId,
            idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now,
          },
        };
      }
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/verifications`) {
        return {
          status: 201,
          body: {
            verification: { id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "passed", phases: [], diagnostics: [], startedAt: now, finishedAt: now, createdAt: now },
            operation: { id: verifyOpId1, appId, deploymentId: deployedId, type: "verify_app", state: "succeeded", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now },
          },
        };
      }
      if (request.method === "GET" && request.path === `/v1/operations/${verifyOpId1}`) {
        return { status: 200, body: { id: verifyOpId1, appId, deploymentId: deployedId, type: "verify_app", state: "succeeded", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now } };
      }
      if (request.method === "GET" && request.path === `/v1/apps/${appId}/verifications/${verifyId1}`) {
        return { status: 200, body: { id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "passed", phases: [], diagnostics: [], startedAt: now, finishedAt: now, createdAt: now } };
      }
      if (request.method === "GET" && request.path === `/v1/apps/${appId}`) {
        return { status: 200, body: { id: appId, identityStatus: "assigned", name: "App", slug: "app", appUrl: "https://app.example.test", authUrl: "https://auth.example.test", apiUrl: "https://api.example.test", visibility: "private", aiCredentialSource: "owner", state: "active", ownerUserId: actorId, desiredDeploymentId: deployedId, activeDeploymentId: deployedId, createdAt: now, updatedAt: now } };
      }
      if (request.method === "DELETE" && request.path.startsWith(`/v1/apps/${appId}/dev-sessions/${devSessionId}`)) {
        return { status: 200, body: devSessionPayload("stopped", revId, receiptId, localDigest) };
      }
      if (request.method === "GET" && request.path === `/v1/apps/${appId}/drafts/${draftId}/files`) {
        return { status: 200, body: [] };
      }
      return undefined;
    };
    const first = await run(["--token", "synthetic-token", "app", "dev", "promote", directory, "--interval", "0.05", "--timeout", "5"], context);
    expect(first.status).toBe(1);
    const second = await run(["--token", "synthetic-token", "app", "dev", "promote", directory, "--interval", "0.05", "--timeout", "5"], context);
    expect(second.status, second.stderr).toBe(0);
    expect(promoteKeys).toHaveLength(2);
    expect(promoteKeys[0]).not.toBe(promoteKeys[1]);
  });

  it("settles F2 rejoin dead-ends when the kept draft returns 404 or becomes closed mid-sync", async () => {
    const context = await workspace("rejoin-dead-ends");
    const directory = await app(context);
    const localDigest = (JSON.parse((await run(["validate", directory], context)).stdout) as { artifactSha256: string }).artifactSha256;
    const draft1 = "40000000-0000-4000-8000-000000000081";
    const draft2 = "40000000-0000-4000-8000-000000000082";
    let createdCount = 0;
    let draft1Missing = false;
    let draft1ClosedInLoop = false;
    const draftMap = new Map<string, { revision: number; files: Map<string, string> }>();
    let firstValidateDropped = false;

    responder = (request) => {
      if (request.path === "/version") return { status: 200, body: baseVersion() };
      if (request.path === "/v1/installation") return { status: 404, body: { code: "NOT_FOUND", message: "not found" } };
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/drafts`) {
        createdCount += 1;
        const id = createdCount === 1 ? draft1 : draft2;
        draftMap.set(id, { revision: 1, files: new Map() });
        return { status: 201, body: { id, appId, baseDeploymentId: null, name: "CLI", status: "open", revision: 1, createdAt: now, updatedAt: now, deployedAt: null } };
      }
      const draftMatch = /^\/v1\/apps\/[^/]+\/drafts\/([^/]+)(\/.*)?$/.exec(request.path);
      if (draftMatch) {
        const id = draftMatch[1]!;
        const rest = draftMatch[2] ?? "";
        if (id === draft1 && draft1Missing) return { status: 404, body: { code: "NOT_FOUND", message: "draft not found" } };
        const entry = draftMap.get(id);
        if (!entry) return { status: 404, body: { code: "NOT_FOUND", message: "draft not found" } };
        if (rest === "" && request.method === "GET") {
          const status = id === draft1 && draft1ClosedInLoop ? "discarded" : "open";
          return { status: 200, body: { id, appId, baseDeploymentId: null, name: "CLI", status, revision: entry.revision, createdAt: now, updatedAt: now, deployedAt: null } };
        }
        if (rest === "/files" && request.method === "GET") {
          return { status: 200, body: [...entry.files].map(([p, sha]) => ({ path: p, sha256: sha, baseSha256: null, sizeBytes: 1, deleted: false, updatedAt: now })) };
        }
        if (rest === "/files" && request.method === "PATCH") {
          const body = JSON.parse(request.body) as { changes: Array<{ path: string; contentBase64?: string; delete?: boolean }> };
          for (const c of body.changes) {
            if (c.delete) entry.files.delete(c.path);
            else entry.files.set(c.path, createHash("sha256").update(Buffer.from(c.contentBase64!, "base64")).digest("hex"));
          }
          entry.revision += 1;
          return { status: 200, body: { draft: { id, appId, baseDeploymentId: null, name: "CLI", status: "open", revision: entry.revision, createdAt: now, updatedAt: now, deployedAt: null }, files: [] } };
        }
        if (rest === "/validate" && request.method === "POST") {
          if (!firstValidateDropped) {
            firstValidateDropped = true;
            return { status: 502, body: { code: "BAD_GATEWAY", message: "proxy lost reply" } };
          }
          return { status: 200, body: validationPayload("40000000-0000-4000-8000-000000000060", id, entry.revision, localDigest) };
        }
        if (rest.startsWith("/deploy") && request.method === "POST") {
          return {
            status: 201,
            body: {
              draft: { id, appId, baseDeploymentId: null, name: "CLI", status: "deployed", revision: entry.revision, createdAt: now, updatedAt: now, deployedAt: now },
              deployment: { id: deployedId, appId, version: "app-20261121-1", artifactSha256: localDigest, sdkVersion: "2.3.0", manifest: {}, state: "active", rollbackOfDeploymentId: null, error: null, createdAt: now, activatedAt: now, source: null },
              operation: { id: deployOpId, appId, deploymentId: deployedId, type: "deploy", state: "succeeded", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now },
            },
          };
        }
      }
      return undefined;
    };

    // First deploy gets 502 during validation -> settles as validation_waiting on draft1.
    const first = await run(["--token", "synthetic-token", "deploy", directory, "--no-verify"], context);
    expect(first.status).toBe(1);
    // Draft1 disappears (404) before rejoin -> settles refused with DRAFT_NOT_OPEN.
    draft1Missing = true;
    const rejoined404 = await run(["--token", "synthetic-token", "deploy", directory, "--no-verify"], context);
    expect(rejoined404.status).toBe(1);
    expect(JSON.parse(rejoined404.stderr.trim().split("\n").at(-1)!).error.code).toBe("DRAFT_NOT_OPEN");
    // Next deploy starts fresh on draft2 and succeeds!
    const recovered = await run(["--token", "synthetic-token", "deploy", directory, "--no-verify"], context);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(createdCount).toBe(2);

    // Also verify mid-loop closure on a fresh deploy settles as DRAFT_NOT_OPEN.
    const context2 = await workspace("mid-loop-closed");
    const directory2 = await app(context2);
    createdCount = 0;
    draft1Missing = false;
    draft1ClosedInLoop = true;
    const closedInLoop = await run(["--token", "synthetic-token", "deploy", directory2, "--no-verify"], context2);
    expect(closedInLoop.status).toBe(1);
    expect(JSON.parse(closedInLoop.stderr.trim().split("\n").at(-1)!).error.code).toBe("DRAFT_NOT_OPEN");
    draft1ClosedInLoop = false;
    firstValidateDropped = true;
    const freshAfterClose = await run(["--token", "synthetic-token", "deploy", directory2, "--no-verify"], context2);
    expect(freshAfterClose.status, freshAfterClose.stderr).toBe(0);
    expect(createdCount).toBe(2);
  });

  it("adds the stale release hint when app dev start is refused with ACTIVE_DEPLOYMENT_CHANGED", async () => {
    const context = await workspace("dev-start-stale-hint");
    const directory = await app(context);
    const localDigest = (JSON.parse((await run(["validate", directory], context)).stdout) as { artifactSha256: string }).artifactSha256;
    await mkdir(path.join(directory, ".opencloud"), { recursive: true });
    await writeFile(path.join(directory, ".opencloud", "base.json"), JSON.stringify({
      schemaVersion: 1, apiUrl, appId, deploymentId: baseDeploymentId, version: "app-20261121-1",
      artifactSha256: localDigest, sourceSha256: null, files: {}, recordedAt: now,
    }));
    let rev = 1;
    const files = new Map<string, string>();
    responder = (request) => {
      if (request.path === "/version") return { status: 200, body: baseVersion() };
      if (request.path === "/v1/installation") return { status: 404, body: { code: "NOT_FOUND", message: "not found" } };
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/drafts`) {
        return { status: 201, body: { id: draftId, appId, baseDeploymentId: null, name: "Dev", status: "open", revision: 1, createdAt: now, updatedAt: now, deployedAt: null } };
      }
      if (request.method === "GET" && request.path === `/v1/apps/${appId}/drafts/${draftId}`) {
        return { status: 200, body: { id: draftId, appId, baseDeploymentId: null, name: "Dev", status: "open", revision: rev, createdAt: now, updatedAt: now, deployedAt: null } };
      }
      if (request.method === "GET" && request.path === `/v1/apps/${appId}/drafts/${draftId}/files`) {
        return { status: 200, body: [...files].map(([p, sha]) => ({ path: p, sha256: sha, baseSha256: null, sizeBytes: 1, deleted: false, updatedAt: now })) };
      }
      if (request.method === "PATCH" && request.path === `/v1/apps/${appId}/drafts/${draftId}/files`) {
        const body = JSON.parse(request.body) as { changes: Array<{ path: string; contentBase64?: string; delete?: boolean }> };
        for (const c of body.changes) {
          if (c.delete) files.delete(c.path);
          else files.set(c.path, createHash("sha256").update(Buffer.from(c.contentBase64!, "base64")).digest("hex"));
        }
        rev += 1;
        return { status: 200, body: { draft: { id: draftId, appId, baseDeploymentId: null, name: "Dev", status: "open", revision: rev, createdAt: now, updatedAt: now, deployedAt: null }, files: [] } };
      }
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/drafts/${draftId}/validate`) {
        return { status: 200, body: validationPayload("40000000-0000-4000-8000-000000000060", draftId, rev, localDigest) };
      }
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/drafts/${draftId}/dev-sessions`) {
        return {
          status: 409,
          body: {
            statusCode: 409,
            code: "ACTIVE_DEPLOYMENT_CHANGED",
            message: "Another deployment became active",
            details: { expectedActiveDeploymentId: baseDeploymentId, latestDeploymentId: otherDeploymentId, latestVersion: "app-20261121-2" },
          },
        };
      }
      if (request.method === "GET" && request.path === `/v1/apps/${appId}/deployments/${baseDeploymentId}`) {
        return { status: 200, body: { id: baseDeploymentId, state: "superseded" } };
      }
      return undefined;
    };
    const started = await run(["--token", "synthetic-token", "app", "dev", "start", directory], context);
    expect(started.status).toBe(1);
    const error = JSON.parse(started.stderr.trim().split("\n").at(-1)!).error as { code: string; hint?: string };
    expect(error.code).toBe("ACTIVE_DEPLOYMENT_CHANGED");
    expect(error.hint).toContain(`opencloud pull ${directory}`);
    expect(error.hint).toContain(`--deployment ${otherDeploymentId} --merged`);
  });

  it("replays deployment rollback cleanly when killed mid-verify_app or after a transient verifyApp failure", async () => {
    const context = await workspace("rollback-verify-kill-replay");
    const rollbackKey = "rollback-verify-replay-k1";
    const rollbackOpId = "40000000-0000-4000-8000-000000000091";
    let verifyPostCount = 0;
    let verifyOpState: "running" | "succeeded" = "running";
    let currentChild: ReturnType<typeof spawn> | null = null;
    let killOnVerifyPoll = true;
    const rollbackKeys: string[] = [];

    responder = (request) => {
      if (request.path === "/version") return { status: 200, body: baseVersion() };
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/deployments/${deployedId}/rollback`) {
        rollbackKeys.push(String(request.headers["idempotency-key"]));
        return {
          status: 201,
          body: {
            operation: { id: rollbackOpId, appId, deploymentId: deployedId, type: "rollback", state: "succeeded", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now },
          },
        };
      }
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/verifications`) {
        verifyPostCount += 1;
        return {
          status: 201,
          body: {
            verification: { id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "queued", phases: [], diagnostics: [], startedAt: now, finishedAt: null, createdAt: now },
            operation: { id: verifyOpId1, appId, deploymentId: deployedId, type: "verify_app", state: "running", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now },
          },
        };
      }
      if (request.method === "GET" && request.path === `/v1/operations/${verifyOpId1}`) {
        if (killOnVerifyPoll) {
          killOnVerifyPoll = false;
          currentChild?.kill("SIGKILL");
        }
        return {
          status: 200,
          body: { id: verifyOpId1, appId, deploymentId: deployedId, type: "verify_app", state: verifyOpState, actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now },
        };
      }
      if (request.method === "GET" && request.path === `/v1/apps/${appId}/verifications/${verifyId1}`) {
        return {
          status: 200,
          body: { id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "passed", phases: [], diagnostics: [], startedAt: now, finishedAt: now, createdAt: now },
        };
      }
      return undefined;
    };

    // First run gets SIGKILL while polling verify_app.
    const killed = await run(
      ["--token", "synthetic-token", "deployment", "rollback", appId, deployedId, "--idempotency-key", rollbackKey, "--interval", "0.05", "--timeout", "10"],
      context,
      {},
      (child) => { currentChild = child; },
    );
    expect(killed.signal).toBe("SIGKILL");
    expect(verifyPostCount).toBe(1);
    await ageJournalLocks([context.home, context.folder]);

    // Re-running the exact same rollback command replays rollback and joins the checkpointed verify_app op cleanly.
    verifyOpState = "succeeded";
    const replayed = await run(
      ["--token", "synthetic-token", "deployment", "rollback", appId, deployedId, "--idempotency-key", rollbackKey, "--interval", "0.05", "--timeout", "10"],
      context,
    );
    expect(replayed.status, replayed.stderr).toBe(0);
    expect(rollbackKeys).toEqual([rollbackKey, rollbackKey]);
    expect(verifyPostCount).toBe(1);
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { id: rollbackOpId, state: "succeeded" },
      verification: { id: verifyId1, state: "passed" },
    });

    // Also verify replay when verifyApp failed with a transient 502 before checkpointing:
    // the second attempt sends the exact same child idempotency-key and succeeds cleanly.
    const transientKey = "rollback-verify-transient-k2";
    const transientVerifyKeys: string[] = [];
    let transientVerifyAttempts = 0;
    responder = (request) => {
      if (request.path === "/version") return { status: 200, body: baseVersion() };
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/deployments/${deployedId}/rollback`) {
        return {
          status: 201,
          body: {
            operation: { id: rollbackOpId, appId, deploymentId: deployedId, type: "rollback", state: "succeeded", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now },
          },
        };
      }
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/verifications`) {
        transientVerifyAttempts += 1;
        transientVerifyKeys.push(String(request.headers["idempotency-key"]));
        if (transientVerifyAttempts === 1) {
          return { status: 502, body: { code: "BAD_GATEWAY", message: "transient upstream error" } };
        }
        return {
          status: 201,
          body: {
            verification: { id: verifyId2, appId, deploymentId: deployedId, operationId: verifyOpId2, state: "passed", phases: [], diagnostics: [], startedAt: now, finishedAt: now, createdAt: now },
            operation: { id: verifyOpId2, appId, deploymentId: deployedId, type: "verify_app", state: "succeeded", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now },
          },
        };
      }
      if (request.method === "GET" && request.path === `/v1/apps/${appId}/verifications/${verifyId2}`) {
        return {
          status: 200,
          body: { id: verifyId2, appId, deploymentId: deployedId, operationId: verifyOpId2, state: "passed", phases: [], diagnostics: [], startedAt: now, finishedAt: now, createdAt: now },
        };
      }
      return undefined;
    };
    const transientFirst = await run(
      ["--token", "synthetic-token", "deployment", "rollback", appId, deployedId, "--idempotency-key", transientKey, "--interval", "0.05", "--timeout", "10"],
      context,
    );
    expect(transientFirst.status).toBe(1);
    const transientRetry = await run(
      ["--token", "synthetic-token", "deployment", "rollback", appId, deployedId, "--idempotency-key", transientKey, "--interval", "0.05", "--timeout", "10"],
      context,
    );
    expect(transientRetry.status, transientRetry.stderr).toBe(0);
    expect(transientVerifyKeys).toHaveLength(2);
    expect(transientVerifyKeys[0]).toBe(transientVerifyKeys[1]);
  });

  it("defers base.json and journal completion until after verify_app so SIGKILL during verify_app replays without IDEMPOTENCY_KEY_REUSED", async () => {
    const context = await workspace("deploy-verify-kill-replay");
    const directory = await app(context);
    const localDigest = (JSON.parse((await run(["validate", directory], context)).stdout) as { artifactSha256: string }).artifactSha256;
    await mkdir(path.join(directory, ".opencloud"), { recursive: true });
    const baseFile = path.join(directory, ".opencloud", "base.json");
    await writeFile(baseFile, JSON.stringify({
      schemaVersion: 1, apiUrl, appId, deploymentId: baseDeploymentId, version: "app-20261121-0",
      artifactSha256: localDigest, sourceSha256: null, files: {}, recordedAt: now,
    }));

    const deployKey = "deploy-verify-kill-k1";
    let currentChild: ReturnType<typeof spawn> | null = null;
    let killOnVerifyPoll = true;
    let verifyOpState: "running" | "succeeded" = "running";
    let draftCreateCount = 0;
    let verifyPostCount = 0;
    const deployKeys: string[] = [];

    const inner = makeDeployResponder({
      localDigest,
      verifyResponse: () => {
        verifyPostCount += 1;
        return {
          status: 201,
          body: {
            verification: { id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "queued", phases: [], diagnostics: [], startedAt: now, finishedAt: null, createdAt: now },
            operation: { id: verifyOpId1, appId, deploymentId: deployedId, type: "verify_app", state: "running", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now },
          },
        };
      },
      verifyOp: () => {
        if (killOnVerifyPoll) {
          killOnVerifyPoll = false;
          currentChild?.kill("SIGKILL");
        }
        return { id: verifyOpId1, appId, deploymentId: deployedId, type: "verify_app", state: verifyOpState, actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now };
      },
      verificationRecord: () => ({
        id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "passed", phases: [], diagnostics: [], startedAt: now, finishedAt: now, createdAt: now,
      }),
    });
    responder = (request) => {
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/drafts`) draftCreateCount += 1;
      if (request.method === "POST" && request.path.startsWith(`/v1/apps/${appId}/drafts/${draftId}/deploy`)) {
        deployKeys.push(String(request.headers["idempotency-key"]));
      }
      return inner(request);
    };

    const killed = await run(
      ["--token", "synthetic-token", "deploy", directory, "--idempotency-key", deployKey, "--interval", "0.05", "--timeout", "10"],
      context,
      {},
      (child) => { currentChild = child; },
    );
    expect(killed.signal).toBe("SIGKILL");
    // .opencloud/base.json must still name the old baseDeploymentId before verify_app finishes.
    expect((JSON.parse(await readFile(baseFile, "utf8")) as { deploymentId: string }).deploymentId).toBe(baseDeploymentId);
    await ageJournalLocks([context.home, context.folder]);

    // Re-running the exact same deploy command replays cleanly with zero IDEMPOTENCY_KEY_REUSED.
    verifyOpState = "succeeded";
    const replayed = await run(
      ["--token", "synthetic-token", "deploy", directory, "--idempotency-key", deployKey, "--interval", "0.05", "--timeout", "10"],
      context,
    );
    expect(replayed.status, replayed.stderr).toBe(0);
    expect(replayed.stderr).not.toContain("IDEMPOTENCY_KEY_REUSED");
    expect(draftCreateCount).toBe(1);
    expect(verifyPostCount).toBe(1);
    expect(deployKeys).toHaveLength(2);
    expect(deployKeys[0]).toBe(deployKeys[1]);
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      deployment: { id: deployedId },
      verification: { id: verifyId1, state: "passed" },
    });
    // Now .opencloud/base.json reflects the live deployed release.
    expect((JSON.parse(await readFile(baseFile, "utf8")) as { deploymentId: string }).deploymentId).toBe(deployedId);
  });

  it("explains that another deployment updated .opencloud/base.json instead of printing a self-contradictory IDEMPOTENCY_KEY_REUSED hint", async () => {
    const context = await workspace("deploy-base-moved-hint");
    const directory = await app(context);
    const localDigest = (JSON.parse((await run(["validate", directory], context)).stdout) as { artifactSha256: string }).artifactSha256;
    await mkdir(path.join(directory, ".opencloud"), { recursive: true });
    const baseFile = path.join(directory, ".opencloud", "base.json");
    await writeFile(baseFile, JSON.stringify({
      schemaVersion: 1, apiUrl, appId, deploymentId: baseDeploymentId, version: "app-20261121-0",
      artifactSha256: localDigest, sourceSha256: null, files: {}, recordedAt: now,
    }));

    // Terminal 1 is interrupted mid-deploy after creating the draft with baseDeploymentId.
    const inner = makeDeployResponder({
      localDigest,
      verifyResponse: () => ({
        status: 201,
        body: {
          verification: { id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "passed", phases: [], diagnostics: [], startedAt: now, finishedAt: now, createdAt: now },
          operation: { id: verifyOpId1, appId, deploymentId: deployedId, type: "verify_app", state: "succeeded", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now },
        },
      }),
      verificationRecord: () => ({
        id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "passed", phases: [], diagnostics: [], startedAt: now, finishedAt: now, createdAt: now,
      }),
    });
    let failFirstDeploy = true;
    responder = (request) => {
      if (failFirstDeploy && request.method === "POST" && request.path.startsWith(`/v1/apps/${appId}/drafts/${draftId}/deploy`)) {
        failFirstDeploy = false;
        return { status: 502, body: { code: "BAD_GATEWAY", message: "interrupted" } };
      }
      return inner(request);
    };
    const terminal1 = await run(["--token", "synthetic-token", "deploy", directory, "--idempotency-key", "deploy-t1-k1"], context);
    expect(terminal1.status).toBe(1);

    // Terminal 2 completes another deploy in the same workspace, advancing .opencloud/base.json to deployedId.
    const terminal2 = await run(["--token", "synthetic-token", "deploy", directory, "--idempotency-key", "deploy-t2-k2"], context);
    expect(terminal2.status, terminal2.stderr).toBe(0);
    expect((JSON.parse(await readFile(baseFile, "utf8")) as { deploymentId: string }).deploymentId).toBe(deployedId);

    // Re-running Terminal 1's command now gets an accurate hint (not "run it again with the input it had").
    const retryT1 = await run(["--token", "synthetic-token", "deploy", directory, "--idempotency-key", "deploy-t1-k1"], context);
    expect(retryT1.status).toBe(1);
    const error = JSON.parse(retryT1.stderr.trim().split("\n").at(-1)!).error as { code: string; hint?: string };
    expect(error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(error.hint).toContain(".opencloud/base.json");
    expect(error.hint).toContain(`opencloud deployment list ${appId}`);
    expect(error.hint).toContain(`opencloud pull ${directory}`);
    expect(error.hint).toContain("--idempotency-key");
    expect(error.hint).not.toContain("To finish that request, run it again");
  });

  /**
   * A control plane that, like OpenCloud, replays createDraft and deployDraft
   * for a key it has seen: the same draft in its current state, and the same
   * release and operation. `onDeploy` decides how the first deploy's reply
   * is lost.
   */
  function sentDeployResponder(localDigest: string, onDeploy: () => { status: number; body: unknown } | "deployed") {
    const state = {
      draftStatus: "open" as "open" | "validated" | "deploying" | "deployed",
      draftRevision: 1,
      files: new Map<string, string>(),
      draftKeys: new Set<string>(),
      operationKeys: new Set<string>(),
      deployKeys: [] as string[],
      verifyPosts: 0,
    };
    const draft = () => ({
      id: draftId, appId, baseDeploymentId: null, name: "CLI", status: state.draftStatus, revision: state.draftRevision,
      createdAt: now, updatedAt: now, deployedAt: state.draftStatus === "deployed" ? now : null,
    });
    const started = () => ({
      draft: draft(),
      deployment: { id: deployedId, appId, version: "app-20261122-1", artifactSha256: localDigest, sdkVersion: "2.3.0", manifest: {}, state: "active", rollbackOfDeploymentId: null, error: null, createdAt: now, activatedAt: now, source: null },
      operation: { id: deployOpId, appId, deploymentId: deployedId, type: "deploy", state: "succeeded", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now },
    });
    const verification = { id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "passed", phases: [], diagnostics: [], startedAt: now, finishedAt: now, createdAt: now };
    const responder: Responder = (request) => {
      if (request.path === "/version") return { status: 200, body: baseVersion() };
      if (request.path === "/v1/installation") return { status: 404, body: { code: "NOT_FOUND", message: "not found" } };
      const draftPath = `/v1/apps/${appId}/drafts/${draftId}`;
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/drafts`) {
        state.draftKeys.add(String(request.headers["idempotency-key"]));
        return { status: 201, body: draft() };
      }
      if (request.method === "GET" && request.path === draftPath) return { status: 200, body: draft() };
      if (request.method === "GET" && request.path === `${draftPath}/files`) {
        return { status: 200, body: [...state.files].map(([file, sha256]) => ({ path: file, sha256, baseSha256: null, sizeBytes: 1, deleted: false, updatedAt: now })) };
      }
      if (request.method === "PATCH" && request.path === `${draftPath}/files`) {
        if (!["open", "validated"].includes(state.draftStatus)) return { status: 409, body: { statusCode: 409, message: "Draft is not open" } };
        const body = JSON.parse(request.body) as { changes: Array<{ path: string; contentBase64?: string; delete?: boolean }> };
        for (const change of body.changes) {
          if (change.delete) state.files.delete(change.path);
          else state.files.set(change.path, createHash("sha256").update(Buffer.from(change.contentBase64!, "base64")).digest("hex"));
        }
        state.draftRevision += 1;
        state.draftStatus = "open";
        return { status: 200, body: { draft: draft(), files: [] } };
      }
      if (request.method === "POST" && request.path === `${draftPath}/validate`) {
        state.draftStatus = "validated";
        return { status: 200, body: validationPayload("40000000-0000-4000-8000-000000000060", draftId, state.draftRevision, localDigest) };
      }
      if (request.method === "POST" && request.path.startsWith(`${draftPath}/deploy`)) {
        const key = String(request.headers["idempotency-key"]);
        state.deployKeys.push(key);
        if (state.operationKeys.has(key)) {
          // OpenCloud refuses a draft while it is deploying; this one finishes meanwhile.
          if (state.draftStatus === "deploying") {
            state.draftStatus = "deployed";
            return { status: 409, body: { statusCode: 409, message: "Draft must pass authoritative validation before use", error: "Conflict" } };
          }
          return { status: 201, body: started() };
        }
        if (state.draftStatus !== "validated") return { status: 409, body: { statusCode: 409, message: "Draft must pass authoritative validation before use", error: "Conflict" } };
        state.operationKeys.add(key);
        const answer = onDeploy();
        if (answer === "deployed") {
          state.draftStatus = "deployed";
          return { status: 201, body: started() };
        }
        state.draftStatus = "deploying";
        return answer;
      }
      if (request.method === "POST" && request.path === `/v1/apps/${appId}/verifications`) {
        state.verifyPosts += 1;
        return { status: 201, body: { verification, operation: { id: verifyOpId1, appId, deploymentId: deployedId, type: "verify_app", state: "succeeded", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now } } };
      }
      if (request.method === "GET" && request.path === `/v1/apps/${appId}/verifications/${verifyId1}`) return { status: 200, body: verification };
      return undefined;
    };
    return { state, responder };
  }

  it("follows a deploy whose reply was lost, without deploying again, while its draft is deploying and then deployed", async () => {
    const context = await workspace("deploy-lost-reply");
    const directory = await app(context);
    const localDigest = (JSON.parse((await run(["validate", directory], context)).stdout) as { artifactSha256: string }).artifactSha256;
    // OpenCloud started the release, but the reply was lost on the way back.
    const mock = sentDeployResponder(localDigest, () => ({ status: 502, body: { code: "BAD_GATEWAY", message: "upstream reset" } }));
    responder = mock.responder;
    const lost = await run(["--token", "synthetic-token", "deploy", directory, "--no-verify", "--interval", "0.05"], context);
    expect(lost.status).toBe(1);
    expect(mock.state.draftStatus).toBe("deploying");

    const resumed = await run(["--token", "synthetic-token", "deploy", directory, "--no-verify", "--interval", "0.05"], context);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ operation: { id: deployOpId, state: "succeeded" }, deployment: { id: deployedId } });
    expect(mock.state.operationKeys.size).toBe(1);
    expect(mock.state.draftKeys.size).toBe(1);
    expect(new Set(mock.state.deployKeys).size).toBe(1);
    expect(mock.state.deployKeys.length).toBeGreaterThanOrEqual(2);
    expect((JSON.parse(await readFile(path.join(directory, ".opencloud", "base.json"), "utf8")) as { deploymentId: string }).deploymentId).toBe(deployedId);

    // The entry is settled: the next deploy is a new request, held behind nothing.
    requests = [];
    const next = await run(["--token", "synthetic-token", "deploy", directory, "--no-verify", "--interval", "0.05"], context);
    expect(next.stderr).not.toContain("MUTATION_IN_PROGRESS");
  });

  it("finishes a deploy killed before its operation was saved, verifying the one release it started", async () => {
    const context = await workspace("deploy-killed-after-send");
    const directory = await app(context);
    const localDigest = (JSON.parse((await run(["validate", directory], context)).stdout) as { artifactSha256: string }).artifactSha256;
    let child: ReturnType<typeof spawn> | null = null;
    const mock = sentDeployResponder(localDigest, () => {
      child?.kill("SIGKILL");
      return "deployed";
    });
    responder = mock.responder;
    const killed = await run(["--token", "synthetic-token", "deploy", directory, "--interval", "0.05"], context, {}, (spawned) => { child = spawned; });
    expect(killed.signal).toBe("SIGKILL");
    await ageJournalLocks([context.home, context.folder]);

    const resumed = await run(["--token", "synthetic-token", "deploy", directory, "--interval", "0.05"], context);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ operation: { id: deployOpId }, verification: { id: verifyId1, state: "passed" } });
    expect(mock.state.operationKeys.size).toBe(1);
    expect(mock.state.draftKeys.size).toBe(1);
    expect(new Set(mock.state.deployKeys).size).toBe(1);
    expect(mock.state.verifyPosts).toBe(1);
  });

  it("settles a resent deploy refused twice as stale while its draft never deployed", async () => {
    const context = await workspace("deploy-resend-stale");
    const directory = await app(context);
    const localDigest = (JSON.parse((await run(["validate", directory], context)).stdout) as { artifactSha256: string }).artifactSha256;
    const mock = sentDeployResponder(localDigest, () => "deployed");
    let deploySends = 0;
    responder = (request) => {
      if (request.method === "POST" && request.path.startsWith(`/v1/apps/${appId}/drafts/${draftId}/deploy`)) {
        deploySends += 1;
        // The first never arrived; then someone else's release is the latest.
        return deploySends === 1
          ? { status: 502, body: { code: "BAD_GATEWAY", message: "lost before it arrived" } }
          : { status: 409, body: { statusCode: 409, code: "ACTIVE_DEPLOYMENT_CHANGED", message: "Another release is the latest", details: { latestDeploymentId: otherDeploymentId } } };
      }
      return mock.responder(request);
    };
    const args = ["--token", "synthetic-token", "deploy", directory, "--no-verify", "--interval", "0.05"];
    expect((await run(args, context)).status).toBe(1);
    const stale = await run(args, context);
    expect(stale.status).toBe(1);
    expect(JSON.parse(stale.stderr.trim().split("\n").at(-1)!).error).toMatchObject({ code: "ACTIVE_DEPLOYMENT_CHANGED" });
    expect(deploySends).toBe(3);
    expect(mock.state.draftKeys.size).toBe(1);
    // Nothing deployed, so the entry is settled and the next deploy is a new request.
    const next = await run(args, context);
    expect(next.stderr).not.toContain("MUTATION_IN_PROGRESS");
    expect(mock.state.draftKeys.size).toBe(2);
  });

  it("ends a resent deploy whose deployed draft OpenCloud won't answer for as an unknown outcome, sent no more", async () => {
    const context = await workspace("deploy-resend-unknown");
    const directory = await app(context);
    const localDigest = (JSON.parse((await run(["validate", directory], context)).stdout) as { artifactSha256: string }).artifactSha256;
    const mock = sentDeployResponder(localDigest, () => "deployed");
    let deploySends = 0;
    responder = (request) => {
      if (request.method === "POST" && request.path.startsWith(`/v1/apps/${appId}/drafts/${draftId}/deploy`)) {
        deploySends += 1;
        // The first deployed the draft, but its reply was lost; the resend is refused.
        if (deploySends === 1) {
          mock.responder(request);
          return { status: 502, body: { code: "BAD_GATEWAY", message: "reply lost" } };
        }
        return { status: 409, body: { statusCode: 409, code: "DEPLOYMENT_REPLAY_CONFLICT", message: "Deployment version or artifact already exists for this app" } };
      }
      return mock.responder(request);
    };
    const args = ["--token", "synthetic-token", "deploy", directory, "--no-verify", "--interval", "0.05"];
    expect((await run(args, context)).status).toBe(1);
    expect(mock.state.draftStatus).toBe("deployed");
    const unknown = await run(args, context);
    expect(unknown.status).toBe(1);
    expect(JSON.parse(unknown.stderr.trim().split("\n").at(-1)!).error).toMatchObject({
      code: "DEPLOY_OUTCOME_UNKNOWN", pending: { command: "opencloud deploy", state: "unknown", draftId },
    });
    expect(deploySends).toBe(2);
    // Run again, it sends nothing and says the same.
    const again = await run(args, context);
    expect(JSON.parse(again.stderr.trim().split("\n").at(-1)!).error.code).toBe("DEPLOY_OUTCOME_UNKNOWN");
    expect(deploySends).toBe(2);
    expect(mock.state.draftKeys.size).toBe(1);
  });

  it("gives verification its own --timeout, and one still running says to run the same deploy again to finish", async () => {
    const context = await workspace("deploy-verify-own-window");
    const directory = await app(context);
    const localDigest = (JSON.parse((await run(["validate", directory], context)).stdout) as { artifactSha256: string }).artifactSha256;
    const baseFile = path.join(directory, ".opencloud", "base.json");
    let verifyOpState: "running" | "succeeded" = "running";
    let verifyPosts = 0;
    const inner = makeDeployResponder({
      localDigest,
      verifyResponse: () => {
        verifyPosts += 1;
        return {
          status: 201,
          body: {
            verification: { id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "queued", phases: [], diagnostics: [], startedAt: now, finishedAt: null, createdAt: now },
            operation: { id: verifyOpId1, appId, deploymentId: deployedId, type: "verify_app", state: "running", actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now },
          },
        };
      },
      verifyOp: () => ({ id: verifyOpId1, appId, deploymentId: deployedId, type: "verify_app", state: verifyOpState, actorType: "user", actorId, idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now }),
      verificationRecord: () => ({ id: verifyId1, appId, deploymentId: deployedId, operationId: verifyOpId1, state: "passed", phases: [], diagnostics: [], startedAt: now, finishedAt: now, createdAt: now }),
    });
    responder = async (request) => {
      // Validation alone outlasts the whole --timeout.
      if (request.method === "POST" && request.path.endsWith("/validate")) await new Promise((resolve) => setTimeout(resolve, 1_500));
      return inner(request);
    };
    const args = ["--token", "synthetic-token", "deploy", directory, "--idempotency-key", "deploy-own-window-1", "--interval", "0.05", "--timeout", "1"];
    const slow = await run(args, context);
    expect(slow.status).toBe(1);
    expect(verifyPosts).toBe(1);
    const error = JSON.parse(slow.stderr.trim().split("\n").at(-1)!).error as Record<string, unknown> & { hint: string };
    expect(error).toMatchObject({ code: "OPERATION_WAIT_TIMEOUT", retryable: true, operationId: verifyOpId1, verificationId: verifyId1, deploymentId: deployedId });
    expect(error.hint).toContain(`opencloud deploy ${directory} --idempotency-key deploy-own-window-1`);
    expect(error.hint).toContain(".opencloud/base.json");
    await expect(readFile(baseFile, "utf8")).rejects.toThrow();

    // The same command again rejoins the verification, then records the release.
    verifyOpState = "succeeded";
    const finished = await run(args, context);
    expect(finished.status, finished.stderr).toBe(0);
    expect(JSON.parse(finished.stdout)).toMatchObject({ verification: { id: verifyId1, state: "passed" } });
    expect(verifyPosts).toBe(1);
    expect((JSON.parse(await readFile(baseFile, "utf8")) as { deploymentId: string }).deploymentId).toBe(deployedId);
  });

  it("marks --idempotency-key as required in containers run --help and app dev containers run --help", async () => {
    const context = await workspace("containers-run-help");
    const prodHelp = await run(["containers", "run", "--help"], context);
    expect(prodHelp.status, prodHelp.stderr).toBe(0);
    expect(prodHelp.stdout).toMatch(/--idempotency-key <key>.*\(required\)/);

    const devHelp = await run(["app", "dev", "containers", "run", "--help"], context);
    expect(devHelp.status, devHelp.stderr).toBe(0);
    expect(devHelp.stdout).toMatch(/--idempotency-key <key>.*\(required\)/);
  });
});
