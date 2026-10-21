import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const binary = path.resolve(import.meta.dirname, "../dist/index.cjs");
const temporary = await mkdtemp(path.join(os.tmpdir(), "opencloud-identity-contract-"));
const accountAccess = "synthetic-account-access";
const accountRefresh = "synthetic-account-refresh";
const appToken = "synthetic-app-authority";
const appId = "00000000-0000-4000-8000-000000000001";
const later = new Date(Date.now() + 15 * 60 * 1_000).toISOString();
const user = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "ada@example.test",
  displayName: "Ada Lovelace",
};
const identities = {
  [accountAccess]: { user, credential: { kind: "account_login", appId: null, expiresAt: later } },
  [appToken]: { user, credential: { kind: "app_credential", appId, expiresAt: later } },
};
// Installations released before identities answer the route with 404.
let legacy = false;
const server = createServer((request, response) => {
  const send = (status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const token = request.headers.authorization?.replace(/^Bearer /, "");
  if (request.method === "GET" && request.url === "/v1/auth/identity" && !legacy) {
    const identity = identities[token];
    return identity ? send(200, identity) : send(401, { message: "Invalid API credential" });
  }
  send(404, { message: `Cannot ${request.method} ${request.url}` });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;

// A protected-file account login in a throwaway config directory; reading a
// fresh login never writes to the OS keyring.
const home = path.join(temporary, "home");
const configHome = path.join(temporary, "config");
const credentials = path.join(configHome, "opencloud", "credentials");
await mkdir(credentials, { recursive: true, mode: 0o700 });
await mkdir(home, { recursive: true });
const accountName = `account-${createHash("sha256").update(apiUrl).digest("hex")}`;
await writeFile(path.join(credentials, `${accountName}.json`), `${JSON.stringify({
  schemaVersion: 1, kind: "account", apiUrl, issuer: apiUrl,
  tokenEndpoint: `${apiUrl}/oauth/token`, revocationEndpoint: `${apiUrl}/oauth/revoke`,
  accessToken: accountAccess, accessExpiresAt: later,
  refreshToken: accountRefresh, refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
})}\n`, { mode: 0o600 });

async function run(args, { status = 0, token } = {}) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome };
  for (const key of ["INIT_CWD", "OPENCLOUD_API_URL", "OPENCLOUD_TOKEN", "OPENCLOUD_SESSION_FILE", "OPENCLOUD_WORKSPACE_FILE"]) delete env[key];
  if (token) env.OPENCLOUD_TOKEN = token;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, "--api-url", apiUrl, ...args], { cwd: temporary, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, status, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  for (const secret of [accountAccess, accountRefresh, appToken]) {
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), "credential exposed");
  }
  return JSON.parse((status === 0 ? result.stdout : result.stderr).trim());
}

try {
  assert.deepEqual(await run(["whoami"]), {
    apiUrl,
    user,
    credential: { kind: "account_login", appId: null, expiresAt: later, source: "account-login" },
  });
  assert.deepEqual(await run(["whoami"], { token: appToken }), {
    apiUrl,
    user,
    credential: { kind: "app_credential", appId, expiresAt: later, source: "environment-or-flag" },
  });
  const status = await run(["auth", "status"]);
  assert.equal(status.authenticated, true);
  assert.deepEqual(status.user, user);
  const login = await run(["login"]);
  assert.equal(login.state, "authenticated");
  assert.deepEqual(login.user, user);

  legacy = true;
  const unsupported = await run(["whoami"], { status: 1 });
  assert.match(JSON.stringify(unsupported), /does not report the signed-in user yet/);
  const legacyStatus = await run(["auth", "status"]);
  assert.equal(legacyStatus.authenticated, true);
  assert.equal(legacyStatus.user, null);
  assert.match(legacyStatus.userUnavailable, /does not report the signed-in user yet/);

  process.stdout.write("Signed-in identity HTTP contract passed.\n");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
