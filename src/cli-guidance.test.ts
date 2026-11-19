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

describe("app connect", () => {
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
