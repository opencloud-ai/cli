import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const binary = path.resolve(import.meta.dirname, "../dist/index.cjs");
const temporary = await mkdtemp(path.join(os.tmpdir(), "opencloud-domain-contract-"));
const appId = "00000000-0000-4000-8000-000000000001";
const settings = { available: true, unavailableReason: null, binding: null, cleanupPending: false };
const flagToken = "synthetic-domain-authority";
const accountAccess = "synthetic-account-access";
const accountRefresh = "synthetic-account-refresh";
const workspaceToken = "synthetic-workspace-app-credential";
const later = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
const requests = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const record = {
    method: request.method, url: request.url, key: request.headers["idempotency-key"], body,
    authorization: request.headers.authorization,
  };
  response.setHeader("content-type", "application/json");
  if (request.url === "/version") {
    response.end(JSON.stringify({ version: "3.8.2", commit: "synthetic", builtAt: "2026-09-07T00:00:00Z", releaseId: "synthetic", contracts: { cliMutationJournal: 1 } }));
    return;
  }
  requests.push(record);
  assert.ok(request.url.startsWith(`/v1/apps/${appId}/domains`));
  response.end(JSON.stringify(settings));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;

// A connected app directory with its own app credential, plus the person's
// account login, each in a throwaway config directory.
const home = path.join(temporary, "home");
const configHome = path.join(temporary, "config");
const credentials = path.join(configHome, "opencloud", "credentials");
const appRoot = path.join(temporary, "app");
await mkdir(credentials, { recursive: true, mode: 0o700 });
await mkdir(home, { recursive: true });
await mkdir(path.join(appRoot, ".opencloud"), { recursive: true });
await writeFile(path.join(appRoot, ".opencloud", "app.json"), JSON.stringify({
  schemaVersion: 1, apiUrl, appId, appName: "Jobs", appUrl: "https://jobs.example.test",
  connectedAt: new Date().toISOString(), credentialExpiresAt: later,
}));
const digest = (...parts) => createHash("sha256").update(parts.join("\0")).digest("hex");
await writeFile(path.join(credentials, `workspace-${digest(apiUrl, appId)}.json`),
  `${JSON.stringify({ schemaVersion: 1, kind: "workspace", apiUrl, appId, token: workspaceToken, expiresAt: later })}\n`, { mode: 0o600 });
const accountFile = path.join(credentials, `account-${digest(apiUrl)}.json`);
async function signIn() {
  await writeFile(accountFile, `${JSON.stringify({
    schemaVersion: 1, kind: "account", apiUrl, issuer: apiUrl,
    tokenEndpoint: `${apiUrl}/oauth/token`, revocationEndpoint: `${apiUrl}/oauth/revoke`,
    accessToken: accountAccess, accessExpiresAt: later,
    refreshToken: accountRefresh, refreshExpiresAt: later,
  })}\n`, { mode: 0o600 });
}

async function run(args, { cwd = temporary, token, journal } = {}) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome };
  for (const key of ["INIT_CWD", "OPENCLOUD_TOKEN", "OPENCLOUD_MUTATION_JOURNAL_DIR", "OPENCLOUD_SESSION_FILE", "OPENCLOUD_WORKSPACE_FILE", "OPENCLOUD_API_URL"]) delete env[key];
  if (token) env.OPENCLOUD_TOKEN = token;
  if (journal) env.OPENCLOUD_MUTATION_JOURNAL_DIR = journal;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, "--api-url", apiUrl, "app", "domain", ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.stdout), settings);
  for (const secret of [flagToken, accountAccess, accountRefresh, workspaceToken]) {
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), "credential exposed");
  }
}
const mutations = [
  ["add", "POST", "", { hostname: "example.test" }],
  ["check", "POST", "/check", undefined],
  ["remove", "DELETE", "", undefined],
];
async function exercise(authorization, options) {
  const before = requests.length;
  await run(["get", appId], options);
  assert.deepEqual(requests.at(-1), { method: "GET", url: `/v1/apps/${appId}/domains`, key: undefined, body: "", authorization });
  for (const [command, method, suffix, body] of mutations) {
    await run([command, appId, ...(command === "add" ? ["example.test"] : []), "--idempotency-key", `domain-${command}-retry`], options);
    assert.deepEqual(requests.at(-1), {
      method, url: `/v1/apps/${appId}/domains${suffix}`, key: `domain-${command}-retry`,
      body: body ? JSON.stringify(body) : "", authorization,
    });
  }
  assert.equal(requests.length - before, 1 + mutations.length);
}
const journalEntries = async (directory) => {
  try {
    return (await readdir(path.join(directory, digest(apiUrl, appId), "entries"))).length;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
};
try {
  // An explicit token keeps precedence over the account login.
  await signIn();
  await exercise(`Bearer ${flagToken}`, { token: flagToken, journal: path.join(temporary, "journal") });

  // Domains need the app owner; a connected directory's app credential can't
  // change them, so the owner's own login is used and journals with the account.
  await exercise(`Bearer ${accountAccess}`, { cwd: appRoot });
  assert.equal(await journalEntries(path.join(configHome, "opencloud", "mutation-journals")), mutations.length);
  assert.equal(await journalEntries(path.join(appRoot, ".opencloud", "agent-mutations")), 0);

  // Without a login, the directory's credential is still sent, as before.
  await rm(accountFile);
  await exercise(`Bearer ${workspaceToken}`, { cwd: appRoot });
  process.stdout.write("Custom domain owner command HTTP, credential and idempotency contract passed.\n");
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
