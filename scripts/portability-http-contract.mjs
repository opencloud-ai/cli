import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const binary = path.join(root, "dist/index.cjs");
const temporary = await mkdtemp(path.join(os.tmpdir(), "opencloud-portability-contract-"));
const appId = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const draftId = "00000000-0000-4000-8000-000000000004";
const token = "synthetic-package-account";
const zip = Buffer.alloc(128 * 1024, 0xab);
const digest = createHash("sha256").update(zip).digest("hex");
const stamp = "2026-11-09T00:00:00.000Z";
const requests = [];
let corruptDownload = false;
const requirements = { capabilities: ["data"], integrations: [], secrets: [] };
const review = { id, name: "Portable app", sha256: digest, bytes: zip.length, state: "review", tables: 1, rows: 2764058, files: 0,
  identities: [userId], installerIdentities: [], identityMappings: {}, requirements, appId: null, draftId: null, expiresAt: stamp, error: null };
const operation = { id, appId, deploymentId: null, type: "export_app", state: "queued", actorType: "user", actorId: userId,
  idempotencyKey: "package-export-001", error: null, createdAt: stamp, updatedAt: stamp };
const manifest = { schemaVersion: 1, kind: "opencloud.app-install", id: "example/app", version: "1.0.0", title: "Example",
  summary: "An example", description: "A full fictional example", publisher: { name: "Test" }, license: "MIT",
  images: [{ url: "https://example.test/image.png", alt: "Example" }], data: { kind: "demo", description: "Fictional records" }, requirements,
  archive: { url: "https://example.test/app.zip", sha256: digest, bytes: zip.length } };
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.setHeader("content-type", "application/json");
    if (request.url === "/version") return response.end(JSON.stringify({ version: "3.8.2", commit: "synthetic", builtAt: stamp, releaseId: "test", contracts: { cliMutationJournal: 1 } }));
    if (request.method === "POST" && request.url === "/v1/app-imports") {
      const hash = createHash("sha256"); let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; hash.update(chunk); }
      assert.equal(bytes, zip.length); assert.equal(hash.digest("hex"), digest);
      assert.equal(request.headers["content-length"], String(bytes));
      requests.push({ method: request.method, url: request.url, key: request.headers["idempotency-key"] });
      return response.end(JSON.stringify(review));
    }
    let text = ""; for await (const chunk of request) text += chunk;
    requests.push({ method: request.method, url: request.url, key: request.headers["idempotency-key"], body: text ? JSON.parse(text) : undefined });
    if (request.url.endsWith("/content")) {
      response.setHeader("content-type", "application/zip");
      return response.end(corruptDownload ? Buffer.alloc(zip.length) : zip);
    }
    const responses = new Map([
      [`POST /v1/apps/${appId}/exports`, operation],
      [`GET /v1/operations/${id}`, { ...operation, state: "succeeded", output: { exportId: id } }],
      [`GET /v1/apps/${appId}/exports/${id}`, { id, appId, bytes: zip.length, sha256: digest, expiresAt: stamp, downloadUrl: `https://example.test/v1/apps/${appId}/exports/${id}/content` }],
      [`DELETE /v1/apps/${appId}/exports/${id}`, { deleted: true }],
      ["POST /v1/app-imports/from-url", review],
      ["POST /v1/app-install-intents", { id, manifest, expiresAt: stamp }],
      [`POST /v1/app-install-intents/${id}/package`, review],
      [`GET /v1/app-imports/${id}`, review],
      [`POST /v1/app-imports/${id}/install`, { ...review, state: "ready", appId, draftId }],
      [`POST /v1/app-imports/${id}/publish`, operation],
      [`DELETE /v1/app-imports/${id}`, { deleted: true }],
      [`GET /v1/apps/${appId}/portability`, { importId: id, effectsHeld: true, state: "published" }],
      [`POST /v1/apps/${appId}/portability/enable`, operation],
    ]);
    const coordinate = `${request.method} ${request.url}`;
    assert.ok(responses.has(coordinate), coordinate);
    response.end(JSON.stringify(responses.get(coordinate)));
  } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ message: String(error) })); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;
async function run(args, expected = 0) {
  const env = { ...process.env, OPENCLOUD_TELEMETRY: "0", OPENCLOUD_MUTATION_JOURNAL_DIR: path.join(temporary, "journal") };
  for (const name of ["INIT_CWD", "OPENCLOUD_SESSION_FILE", "OPENCLOUD_WORKSPACE_FILE", "OPENCLOUD_TOKEN", "OPENCLOUD_API_URL"]) delete env[name];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, "--api-url", apiUrl, "--token", token, "app", ...args], { cwd: temporary, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.once("error", reject); child.once("close", status => resolve({ status, stdout, stderr }));
  });
  assert.equal(result.status, expected, JSON.stringify(result));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(token));
  return expected === 0 ? JSON.parse(result.stdout) : result;
}
try {
  for (let n = 0; n < 2; n++) assert.equal((await run(["export", "create", appId, "--idempotency-key", "package-export-001", "--interval", "0.05"])).state, "succeeded");
  assert.deepEqual(requests.filter(r => r.url.endsWith("/exports")).map(r => r.key), ["package-export-001", "package-export-001"]);
  assert.equal((await run(["export", "get", appId, id])).sha256, digest);
  const output = path.join(temporary, "app.zip");
  assert.equal((await run(["export", "download", appId, id, "--output", output])).sha256, digest);
  assert.deepEqual(await readFile(output), zip); assert.equal((await stat(output)).mode & 0o777, 0o600);
  const beforeExisting = requests.length;
  const exists = await run(["export", "download", appId, id, "--output", output], 1);
  assert.match(exists.stderr + exists.stdout, /OUTPUT_FILE_EXISTS/);
  assert.equal(requests.length, beforeExisting, "existing output must fail before starting a download");
  corruptDownload = true;
  await run(["export", "download", appId, id, "--output", output, "--force"], 1);
  assert.deepEqual(await readFile(output), zip); corruptDownload = false;
  assert.equal((await run(["import", "upload", output, "--idempotency-key", "package-upload-001"])).id, id);
  assert.equal((await run(["import", "get", id])).rows, 2764058);
  assert.equal(requests.some(r => r.url.endsWith("/install") || r.url.endsWith("/publish")), false);
  const mappings = path.join(temporary, "users.json"); await writeFile(mappings, JSON.stringify({ [userId]: userId }));
  await run(["import", "install", id, "--name", "Imported", "--mappings", mappings, "--idempotency-key", "package-install-001"]);
  assert.deepEqual(requests.at(-1).body, { name: "Imported", identityMappings: { [userId]: userId } });
  await run(["import", "publish", id, "--idempotency-key", "package-publish-001", "--no-follow"]);
  assert.equal((await run(["portability", "get", appId])).effectsHeld, true);
  await run(["portability", "enable", appId, "--idempotency-key", "package-enable-001", "--no-follow"]);
  await run(["import", "inspect", "https://example.test/install.json"]);
  await run(["import", "stage", id, "--idempotency-key", "package-stage-001"]);
  await run(["import", "from-url", manifest.archive.url, "--sha256", digest, "--bytes", "2147483648", "--idempotency-key", "package-url-001"]);
  assert.equal(requests.at(-1).body.bytes, 2147483648);
  const before = requests.length;
  for (const args of [
    ["upload", output],
    ["from-url", manifest.archive.url, "--sha256", digest, "--bytes", String(zip.length)],
    ["stage", id],
    ["install", id, "--name", "Imported"],
    ["publish", id, "--no-follow"],
  ]) {
    for (const blank of ["", "   "]) {
      const rejected = await run(["import", ...args, "--idempotency-key", blank], 1);
      assert.match(rejected.stderr + rejected.stdout, /INVALID_IDEMPOTENCY_KEY/);
    }
  }
  await run(["import", "from-url", manifest.archive.url, "--sha256", digest, "--bytes", "2147483649", "--idempotency-key", "package-url-002"], 1);
  await run(["import", "publish", id, "--no-follow"], 1);
  assert.equal(requests.length, before);
  await run(["import", "discard", id]); await run(["export", "discard", appId, id]);
  process.stdout.write("Portability CLI contract passed: full workflow, streaming, mappings, checksums, explicit activation and replay.\n");
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
