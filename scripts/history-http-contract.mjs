import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const binary = path.resolve(import.meta.dirname, "../dist/index.cjs");
const temporary = await mkdtemp(path.join(os.tmpdir(), "opencloud-history-contract-"));
const appId = "00000000-0000-4000-8000-000000000001";
const otherAppId = "00000000-0000-4000-8000-000000000002";
const messageId = "00000000-0000-4000-8000-000000000003";
const missingId = "00000000-0000-4000-8000-000000000004";
const userId = "00000000-0000-4000-8000-000000000005";
const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
  assert.equal(request.headers.authorization, "Bearer synthetic-history-authority");
  response.setHeader("content-type", "application/json");
  if (url.pathname.includes(otherAppId) || url.pathname.endsWith(missingId)) {
    response.statusCode = 404;
    response.end(JSON.stringify({ code: "RESOURCE_NOT_FOUND", message: "Resource not found", requestId: "history-test", retryable: false }));
    return;
  }
  let result;
  if (url.pathname.endsWith("/operations/page")) {
    result = { asOf: "2026-09-06T00:00:00Z", operations: [], nextCursor: url.searchParams.has("cursor") ? null : "next+/=" };
  } else if (url.pathname.endsWith("/operations")) {
    result = [];
  } else if (url.pathname.endsWith("/messages")) {
    result = { schemaVersion: 1, retentionDays: 30, messages: [], nextCursor: url.searchParams.has("cursor") ? null : "next+/=" };
  } else if (url.pathname.endsWith(messageId)) {
    result = { schemaVersion: 1, id: messageId, appId, deploymentId: null, userId,
      title: "Synthetic notification", body: null, path: "/", icon: "/icon.png",
      status: "no_subscribers", recipientCount: 0, acceptedCount: 0, failedCount: 0,
      deliveryAttempts: [], createdAt: "2026-09-06T00:00:00Z",
      updatedAt: "2026-09-06T00:00:00Z", completedAt: "2026-09-06T00:00:00Z" };
  } else {
    response.statusCode = 404;
    result = { code: "UNEXPECTED_ROUTE", message: "Unexpected route" };
  }
  response.end(JSON.stringify(result));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

async function run(args, expectedStatus = 0) {
  const env = { ...process.env, OPENCLOUD_TOKEN: "synthetic-history-authority" };
  for (const key of ["INIT_CWD", "OPENCLOUD_SESSION_FILE", "OPENCLOUD_WORKSPACE_FILE", "OPENCLOUD_API_URL", "OPENCLOUD_MUTATION_JOURNAL_DIR"]) delete env[key];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, "--api-url", `http://127.0.0.1:${server.address().port}`, ...args], { cwd: temporary, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
  assert.equal(result.status, expectedStatus, JSON.stringify(result));
  const content = (expectedStatus === 0 ? result.stdout : result.stderr).trim();
  assert.equal(content.split("\n").length, 1, content);
  assert.ok(!content.includes(env.OPENCLOUD_TOKEN), "credential exposed");
  return JSON.parse(content);
}

try {
  assert.deepEqual(await run(["operation", "list", appId, "--limit", "25"]), []);
  assert.deepEqual(requests.at(-1), { method: "GET", path: `/v1/apps/${appId}/operations`, query: { limit: "25" } });
  const page = await run(["operation", "list", appId, "--page", "--limit", "2", "--type", "deploy", "--state", "succeeded"]);
  assert.equal(page.nextCursor, "next+/=");
  assert.deepEqual(requests.at(-1).query, { limit: "2", type: "deploy", state: "succeeded" });
  assert.equal(requests.at(-1).path, `/v1/apps/${appId}/operations/page`);
  const next = await run(["operation", "list", appId, "--cursor", page.nextCursor, "--limit", "2", "--type", "deploy", "--state", "succeeded"]);
  assert.equal(next.nextCursor, null);
  assert.equal(requests.at(-1).query.cursor, "next+/=");
  const notifications = await run(["app", "notifications", "list", appId, "--limit", "2", "--user-id", userId, "--status", "accepted", "--from", "2026-09-01T00:00:00Z", "--to", "2026-09-06T00:00:00Z"]);
  assert.equal(notifications.retentionDays, 30);
  assert.deepEqual(requests.at(-1).query, { limit: "2", userId, status: "accepted", from: "2026-09-01T00:00:00Z", to: "2026-09-06T00:00:00Z" });
  assert.equal((await run(["app", "notifications", "list", appId, "--cursor", notifications.nextCursor])).nextCursor, null);
  assert.equal(requests.at(-1).query.cursor, "next+/=");
  assert.equal((await run(["app", "notifications", "get", appId, messageId])).id, messageId);
  assert.equal(requests.at(-1).path, `/v1/apps/${appId}/notifications/web-push/messages/${messageId}`);
  for (const args of [
    ["operation", "list", appId, "--page", "--limit", "101"],
    ["operation", "list", appId, "--state", "invented"],
    ["operation", "list", appId, "--type", "../other"],
    ["app", "notifications", "list", appId, "--limit", "201"],
    ["app", "notifications", "list", appId, "--from", "2026-09-06T00:00:00Z", "--to", "2026-09-01T00:00:00Z"],
    ["app", "notifications", "get", appId, "../other"],
  ]) {
    const before = requests.length;
    await run(args, 1);
    assert.equal(requests.length, before, "invalid input reached the API");
  }
  for (const args of [
    ["operation", "list", otherAppId, "--page"],
    ["app", "notifications", "list", otherAppId],
    ["app", "notifications", "get", otherAppId, messageId],
    ["app", "notifications", "get", appId, missingId],
  ]) {
    const before = requests.length;
    await run(args, 1);
    assert.equal(requests.length, before + 1, "denial retried with another authority");
  }
  console.log("History HTTP contract passed: pagination, filters, legacy output, input validation, and denial propagation");
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
