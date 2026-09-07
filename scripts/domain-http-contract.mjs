import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const binary = path.resolve(import.meta.dirname, "../dist/index.cjs");
const temporary = await mkdtemp(path.join(os.tmpdir(), "opencloud-domain-contract-"));
const appId = "00000000-0000-4000-8000-000000000001";
const settings = { available: true, unavailableReason: null, binding: null, cleanupPending: false };
const requests = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const record = { method: request.method, url: request.url, key: request.headers["idempotency-key"], body };
  requests.push(record);
  response.setHeader("content-type", "application/json");
  if (request.url === "/version") {
    response.end(JSON.stringify({ version: "3.8.2", commit: "synthetic", builtAt: "2026-09-07T00:00:00Z", releaseId: "synthetic", contracts: { cliMutationJournal: 1 } }));
    return;
  }
  assert.equal(request.headers.authorization, "Bearer synthetic-domain-authority");
  assert.ok(request.url.startsWith(`/v1/apps/${appId}/domains`));
  response.end(JSON.stringify(settings));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
async function run(args) {
  const env = { ...process.env, OPENCLOUD_TOKEN: "synthetic-domain-authority", OPENCLOUD_MUTATION_JOURNAL_DIR: path.join(temporary, "journal") };
  for (const key of ["INIT_CWD", "OPENCLOUD_SESSION_FILE", "OPENCLOUD_WORKSPACE_FILE", "OPENCLOUD_API_URL"]) delete env[key];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, "--api-url", `http://127.0.0.1:${server.address().port}`, "app", "domain", ...args], { cwd: temporary, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.stdout), settings);
  assert.ok(!result.stdout.includes(env.OPENCLOUD_TOKEN));
}
try {
  await run(["get", appId]);
  assert.deepEqual(requests, [{ method: "GET", url: `/v1/apps/${appId}/domains`, key: undefined, body: "" }]);
  for (const [command, method, suffix, body] of [
    ["add", "POST", "", { hostname: "example.test" }],
    ["check", "POST", "/check", undefined],
    ["remove", "DELETE", "", undefined],
  ]) {
    await run([command, appId, ...(command === "add" ? ["example.test"] : []), "--idempotency-key", `domain-${command}-retry`]);
    const actual = requests.at(-1);
    assert.equal(actual.method, method);
    assert.equal(actual.url, `/v1/apps/${appId}/domains${suffix}`);
    assert.equal(actual.key, `domain-${command}-retry`);
    assert.equal(actual.body, body ? JSON.stringify(body) : "");
  }
  process.stdout.write("Custom domain owner command HTTP and idempotency contract passed.\n");
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
