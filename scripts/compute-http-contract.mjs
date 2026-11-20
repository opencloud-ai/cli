import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cliConfigDirectory } from "./cli-config-directory.mjs";

const binary = path.resolve(import.meta.dirname, "../dist/index.cjs");
const temporary = await mkdtemp(path.join(os.tmpdir(), "compute-contracts-cli-"));
const appId = "10000000-0000-4000-8000-000000000001";
const sessionId = "10000000-0000-4000-8000-000000000002";
const executionId = "10000000-0000-4000-8000-000000000003";
const failedExecutionId = "10000000-0000-4000-8000-000000000005";
const revisionId = "10000000-0000-4000-8000-000000000004";
const now = "2026-11-14T00:00:00Z";
const requests = [];
const effects = new Map();
let dropNext = false;
let denied = false;
const usage = { quantities: { vcpuSeconds: "9007199254740993", memoryGiBSeconds: "4", scratchGiBSeconds: "2" }, currency: "usd",
  grossEstimatedCostMinor: "0.123456789012", appliedCreditMinor: "0.02", netEstimatedCostMinor: "0.103456789012",
  priceVersionIds: [revisionId], pendingEvidenceCount: 1, lastSettledAt: null, observedAt: now };
const freshness = { status: "partial", observedAt: now, lagSeconds: 16, truncated: false };
const environment = isDev => ({ environment: isDev ? "development" : "production", developmentSessionId: isDev ? sessionId : null });
const execution = isDev => ({ executionId, workloadName: "job", revisionId, ...environment(isDev), state: "queued", waitReason: "no_capacity",
  acceptedAt: now, queueDeadline: "2026-11-15T00:00:00Z", statusUrl: `/v1/apps/${appId}/container-executions/${executionId}`,
  attempt: 0, startedAt: null, finishedAt: null, executionDeadline: null, phaseDeadline: null, error: null, outputFileIds: [],
  completionDelivery: { state: "not_configured", attempts: 0, lastAttemptAt: null, nextAttemptAt: null, error: null }, usage });
// A job whose process exited 3: the error names its exit code.
const failedExecution = isDev => ({ ...execution(isDev), executionId: failedExecutionId, state: "failed", waitReason: null, attempt: 1,
  startedAt: now, finishedAt: now, error: { statusCode: 422, code: "COMPUTE_EXIT_NONZERO", message: "The container process exited unsuccessfully.",
    details: { category: "execution", origin: "app", phase: "running", retryScope: "known_failed_attempt", retryable: false, billingDisposition: "confirmed_usage", exitCode: 3 } } });
const workload = isDev => ({ name: "worker", kind: "worker", revisionId, ...environment(isDev), imageDigest: `registry.test/image@sha256:${"a".repeat(64)}`,
  resources: { cpu: 1, memoryGiB: 2, scratchGiB: 1 }, limits: { kind: "worker", startupTimeoutSeconds: 120, worker: { replicas: 1, maxReplicas: 3, restart: "always" } },
  hourlyEstimate: null, state: "running", generation: 3, paused: false, pauseReason: null, replicaOverride: null,
  counts: { desired: 1, starting: 0, ready: 0, running: 1, draining: 0, failed: 0 }, instances: [], error: null, usage, observedAt: now });
const connection = { id: revisionId, name: "Registry", registryHost: "registry.test", createdAt: now, revokedAt: null };
const price = { id: revisionId, version: 1, key: "standard", currency: "usd", taxBehavior: "exclusive", quantumSeconds: 1, minimumSeconds: 1,
  ratesMinorPerUnit: { vcpu_second: "0.00001", gib_memory_second: "0.000002", gib_scratch_second: "0.00000001" },
  effectiveFrom: now, state: "published", publishedAt: now };

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  const body = raw ? JSON.parse(raw) : null;
  const url = new URL(request.url, "http://localhost");
  const query = Object.fromEntries(url.searchParams);
  const isDev = url.pathname.includes(`/dev-sessions/${sessionId}/`);
  requests.push({ method: request.method, path: url.pathname, query, body, key: request.headers["idempotency-key"] });
  assert.equal(request.headers.authorization, url.pathname.startsWith("/v1/billing/") ? "Bearer synthetic-account-access" : "Bearer synthetic-compute-authority");
  response.setHeader("content-type", "application/json");
  let value;
  if (url.pathname === "/version") {
    value = { version: "test", commit: "test", builtAt: now, releaseId: "test", contracts: { cliMutationJournal: 1 } };
  } else if (url.pathname === "/v1/billing/compute/prices") {
    value = { prices: [price] };
  } else if (url.pathname === "/v1/billing/compute") {
    value = { payerId: revisionId, enabled: true, mode: "operator", currency: "usd", priceVersionId: revisionId, price,
      nextPriceVersionId: null, nextEffectiveAt: null, monthlyLimitMinor: "10000", dailyLimitMinor: null,
      activeInstanceLimit: 10, dailyTransferBytes: "10737418240", subscriptionState: "not_required", consentedAt: null, updatedAt: now };
  } else if (url.pathname === "/v1/billing/compute/usage") {
    value = { payerId: revisionId, from: query.from, to: query.to, production: usage, development: usage, reservedMinor: "0.02", availableCreditMinor: "10" };
  } else if (denied) {
    response.statusCode = 503;
    value = { statusCode: 503, code: "COMPUTE_STARTING_PENDING", message: "The service is still starting.", requestId: "compute-test",
      details: { category: "ingress", origin: "policy", phase: "ingress", retryScope: "request", retryable: true, billingDisposition: "confirmed_usage" } };
  } else if (url.pathname.endsWith("/logs/query")) {
    value = { status: "success", data: { resultType: "streams", result: [] } };
  } else if (url.pathname.endsWith("/logs/page")) {
    // A Function's log line keeps the fields it logged.
    value = { entries: [{ id: "f".repeat(64), timestamp: now, level: "info", surface: "runtime", message: "check summary", requestId: null,
      fields: { checked: 5, up: 4, slowest: { url: "https://example.test", ms: 647 } } }], nextCursor: "logs+/=", computeObservation: { ...freshness, gaps: [{ instanceId: null, workloadName: "job", from: now, to: now, droppedLines: "3" }], retentionSeconds: 604800 } };
  } else if (url.pathname.endsWith("/agent-feed")) {
    value = { contractVersion: query.contractVersion ?? "1", app: { id: appId, name: "Compute", slug: "compute", state: "active", activeDeployment: null },
      observedAt: now, telemetry: { status: "unavailable", latestIngestedAt: null, ingestionLagSeconds: null, stale: true },
      signals: [], alerts: [], recentBreaches: [], breachesTruncated: false, events: [], eventsTruncated: false, nextSince: now,
      ...(query.contractVersion === "2" ? { computeSources: { control: freshness, logs: freshness, resources: freshness, usage: freshness } } : {}) };
  } else if (url.pathname.endsWith("/compute/registries")) {
    value = request.method === "GET" ? { connections: [connection] } : connection;
  } else if (url.pathname.includes("/compute/registries/")) value = { revoked: true };
  else if (request.method !== "GET") {
    assert.ok(request.headers["idempotency-key"], "mutation lost its stable key");
    const identity = `${url.pathname}:${request.headers["idempotency-key"]}`;
    if (!effects.has(identity)) effects.set(identity, body);
    else assert.deepEqual(body, effects.get(identity), "server replay changed the request");
    value = url.pathname.endsWith("/executions") || url.pathname.endsWith("/cancel") ? execution(isDev)
      // A control change commits at once: the receipt names the next generation, no operation.
      : { workloadName: "worker", generation: 4, acceptedAt: now };
    if (dropNext) { dropNext = false; response.destroy(); return; }
  } else if (url.pathname.endsWith("/containers")) value = { workloads: [workload(isDev)], nextCursor: "opaque+/=", observedAt: now };
  else if (url.pathname.endsWith("/container-executions")) value = { executions: [execution(isDev)], nextCursor: null, observedAt: now };
  else if (url.pathname.endsWith(`/container-executions/${failedExecutionId}`)) value = failedExecution(isDev);
  else if (url.pathname.includes("/container-executions/")) value = execution(isDev);
  else if (url.pathname.endsWith("/events")) value = { events: [], nextCursor: null, observedAt: now };
  else value = workload(isDev);
  response.end(JSON.stringify(value));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;
const directory = path.join(temporary, "app");
await mkdir(path.join(directory, ".opencloud"), { recursive: true });
await writeFile(path.join(directory, ".opencloud/dev.json"), JSON.stringify({ schemaVersion: 1, appId, sessionId, draftId: revisionId, artifactSha256: "a".repeat(64), updatedAt: now }));
const taskHome = path.join(temporary, "home");
const taskConfig = path.join(temporary, "config");
const credentials = path.join(cliConfigDirectory({ home: taskHome, configHome: taskConfig }), "credentials");
await mkdir(taskHome);
await mkdir(credentials, { recursive: true, mode: 0o700 });
const accountName = `account-${createHash("sha256").update(apiUrl).digest("hex")}`;
await writeFile(path.join(credentials, `${accountName}.json`), JSON.stringify({ schemaVersion: 1, kind: "account", apiUrl, issuer: apiUrl,
  tokenEndpoint: `${apiUrl}/oauth/token`, revocationEndpoint: `${apiUrl}/oauth/revoke`, accessToken: "synthetic-account-access",
  accessExpiresAt: new Date(Date.now() + 900000).toISOString(), refreshToken: "synthetic-account-refresh",
  refreshExpiresAt: new Date(Date.now() + 86400000).toISOString() }), { mode: 0o600 });

async function run(args, status = 0, stdin = "", account = false) {
  const env = { ...process.env, HOME: taskHome, XDG_CONFIG_HOME: taskConfig, OPENCLOUD_TELEMETRY: "0", OPENCLOUD_MUTATION_JOURNAL_DIR: path.join(temporary, "journal") };
  for (const key of ["INIT_CWD", "OPENCLOUD_TOKEN", "OPENCLOUD_API_URL", "OPENCLOUD_SESSION_FILE", "OPENCLOUD_WORKSPACE_FILE", "DO_NOT_TRACK"]) delete env[key];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, "--api-url", apiUrl, ...(account ? [] : ["--token", "synthetic-compute-authority"]), ...args], { cwd: temporary, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
  assert.equal(result.code, status, JSON.stringify({ args, ...result }));
  const text = (status ? result.stderr : result.stdout).trim();
  assert.equal(text.split("\n").length, 1, text);
  for (const secret of ["synthetic-compute-authority", "synthetic-account-access", "synthetic-account-refresh"]) assert.ok(!text.includes(secret));
  return JSON.parse(text);
}
const business = offset => requests.slice(offset).filter(r => r.path !== "/version");

try {
  const controlOutputs = new Map();
  for (const isDev of [false, true]) {
    const prefix = isDev ? ["app", "dev", "containers"] : ["containers"];
    const scope = isDev ? directory : appId;
    const route = `/v1/apps/${appId}${isDev ? `/dev-sessions/${sessionId}` : ""}`;
    assert.equal((await run([...prefix, "list", scope, "--kind", "worker", "--limit", "2"])).workloads[0].developmentSessionId, isDev ? sessionId : null);
    assert.equal(requests.at(-1).path, `${route}/containers`);
    assert.equal((await run([...prefix, "get", scope, "worker"])).usage.quantities.vcpuSeconds, "9007199254740993");
    const key = `compute-run-${isDev}`;
    const args = [...prefix, "run", scope, "job", "--input", '{"private":"input-payload"}', "--input-file", revisionId, "--idempotency-key", key];
    const before = requests.length;
    dropNext = true;
    await run(args, 1);
    assert.equal(business(before).length, 1, "uncertain mutation was automatically repeated");
    assert.equal((await run(args)).executionId, executionId);
    assert.equal(effects.get(`${route}/containers/job/executions:${key}`).input.private, "input-payload");
    const conflictBefore = requests.length;
    const changed = args.map(value => value === '{"private":"input-payload"}' ? '{"private":"changed"}' : value);
    // J2b: a key that already named a finished submission is reused with
    // other input. That needs a new key, so it is a conflict, never retryable.
    const reused = (await run(changed, 1)).error;
    assert.equal(reused.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(reused.retryable, false);
    assert.equal(reused.pending.state, "completed");
    assert.equal(reused.hint, "Use a new --idempotency-key for this request.");
    assert.equal(business(conflictBefore).length, 0, "changed input replay reached the API");
    const waiting = await run([...prefix, "execution", scope, executionId]);
    assert.equal(waiting.completionDelivery.state, "not_configured");
    assert.equal(waiting.waitReason, "no_capacity", "a queued job's wait reason is printed");
    const failed = await run([...prefix, "execution", scope, failedExecutionId]);
    assert.deepEqual([failed.waitReason, failed.error.code, failed.error.details.exitCode], [null, "COMPUTE_EXIT_NONZERO", 3]);
    await run([...prefix, "executions", scope, "--workload", "job", "--cursor", "opaque+/="]);
    assert.equal(requests.at(-1).query.cursor, "opaque+/=");
    await run([...prefix, "cancel", scope, executionId, "--idempotency-key", `cancel-${isDev}`]);
    for (const action of ["pause", "resume", "restart", "scale"]) {
      const receipt = await run([...prefix, action, scope, "worker", "--generation", "3", "--idempotency-key", `${action}-${isDev}-key`, ...(action === "scale" ? ["--replicas", "2"] : [])]);
      controlOutputs.set(`${action}:${isDev}`, receipt);
      assert.equal(requests.at(-1).body.expectedGeneration, 3);
      assert.equal(requests.at(-1).path, `${route}/containers/worker/${action}`);
    }
    await run([...prefix, "events", scope, "worker", "--limit", "2"]);
    assert.equal(requests.at(-1).path, `${route}/containers/worker/events`);
  }
  // Production and development controls print the same full receipt (W3 saw them differ).
  for (const action of ["pause", "resume", "restart", "scale"]) {
    assert.deepEqual(controlOutputs.get(`${action}:false`), { workloadName: "worker", generation: 4, acceptedAt: now });
    assert.deepEqual(controlOutputs.get(`${action}:true`), controlOutputs.get(`${action}:false`), `${action} output differs between production and development`);
  }
  assert.equal((await run(["logs", appId])).status, "success", "legacy logs changed shape");
  const page = await run(["logs", appId, "--workload", "job", "--execution", executionId, "--from", now, "--to", "2026-11-14T01:00:00Z"]);
  const loggedFields = { checked: 5, up: 4, slowest: { url: "https://example.test", ms: 647 } };
  assert.deepEqual(page.entries[0].fields, loggedFields, "logs --page keeps a Function's logged fields");
  assert.deepEqual((await run(["logs", appId, "--page", "--from", now, "--to", "2026-11-14T01:00:00Z"])).entries[0].fields, loggedFields);
  assert.equal(page.computeObservation.gaps[0].droppedLines, "3");
  // W1b, W2b, K7: Function lines are the `function` surface. A plural and the
  // older name `runtime` are sent as typed, never mapped: OpenCloud reads each
  // alias itself, and an older release matches Function lines only as
  // `runtime`. An unknown surface is refused first.
  for (const alias of ["functions", "runtime", "Runtime"]) {
    await run(["logs", appId, "--surface", alias, "--from", now, "--to", "2026-11-14T01:00:00Z"]);
    assert.equal(requests.at(-1).body.surface, alias.toLowerCase());
  }
  const surfaceBefore = requests.length;
  const unknownSurface = (await run(["logs", appId, "--surface", "edge", "--from", now, "--to", "2026-11-14T01:00:00Z"], 1)).error;
  assert.equal(unknownSurface.code, "LOG_SURFACE_UNKNOWN");
  assert.equal(unknownSurface.message, 'Unknown log surface "edge": use function, container, http, ai or platform (runtime, the older name for function, still works)');
  assert.deepEqual(unknownSurface.details, { field: "surface", allowed: ["function", "container", "http", "ai", "platform"],
    aliases: { functions: "function", runtime: "function", containers: "container" } });
  assert.equal(requests.length, surfaceBefore, "an unknown surface reached the API");
  const devPage = await run(["app", "dev", "logs", directory, "--kind", "job", "--surface", "container", "--from", now, "--to", "2026-11-14T01:00:00Z"]);
  assert.equal(requests.at(-1).body.surface, "container");
  assert.deepEqual(devPage.entries[0].fields, loggedFields, "app dev logs keeps a Function's logged fields");
  assert.equal(requests.at(-1).path, `/v1/apps/${appId}/dev-sessions/${sessionId}/logs/page`);
  assert.equal((await run(["agent-feed", appId])).contractVersion, "1");
  assert.equal((await run(["agent-feed", appId, "--contract-version", "2"])).computeSources.usage.status, "partial");
  const registryArgs = ["containers", "registry", "create", appId, "--name", "Registry", "--host", "registry.test", "--username", "reader", "--password-stdin", "--idempotency-key", "registry-key"];
  await run(registryArgs, 0, "synthetic-registry-password\n");
  assert.equal(requests.at(-1).body.password, "synthetic-registry-password");
  // K8: the journal digests the name, host and username, never the password,
  // so the same key with another password reaches OpenCloud, which compares it.
  const passwordBefore = requests.length;
  await run(registryArgs, 0, "synthetic-other-password\n");
  assert.equal(business(passwordBefore).length, 1, "the journal refused a request it could only tell apart by its password");
  assert.equal(requests.at(-1).body.password, "synthetic-other-password");
  assert.equal((await run(["containers", "registry", "list", appId])).connections.length, 1);
  await run(["containers", "registry", "remove", appId, revisionId]);
  assert.equal((await run(["compute", "settings"], 0, "", true)).price.id, revisionId);
  assert.equal((await run(["compute", "prices"], 0, "", true)).prices[0].ratesMinorPerUnit.vcpu_second, "0.00001");
  assert.equal((await run(["compute", "usage", "--from", now, "--to", "2026-11-14T01:00:00Z"], 0, "", true)).production.quantities.vcpuSeconds, "9007199254740993");
  for (const args of [
    ["containers", "list", appId, "--limit", "101"],
    ["containers", "executions", appId, "--state", "crash_loop"],
    ["containers", "run", appId, "job", "--idempotency-key", "bad key"],
    ["containers", "scale", appId, "worker", "--generation", "0", "--replicas", "1"],
    // An unset variable is an empty option: never zero replicas or generation 0.
    ["containers", "scale", appId, "worker", "--generation", "3", "--replicas", ""],
    ["containers", "scale", appId, "worker", "--generation", "3", "--replicas", " "],
    ["containers", "scale", appId, "worker", "--generation", "3", "--replicas", "0x2"],
    ["app", "dev", "containers", "scale", directory, "worker", "--generation", "3", "--replicas", ""],
    ["containers", "pause", appId, "worker", "--generation", ""],
    ["app", "dev", "containers", "restart", directory, "worker", "--generation", "1e1"],
    ["containers", "get", appId, "../escape"],
    ["logs", appId, "--workload", ""],
    ["compute", "settings"], ["compute", "prices"], ["compute", "usage", "--from", now, "--to", "2026-11-14T01:00:00Z"],
  ]) {
    const before = requests.length;
    const refused = (await run(args, 1)).error;
    assert.equal(requests.length, before, "invalid input or app-token payer read reached the API");
    if (args.includes("--replicas") && args.at(-1) !== "1") assert.equal(refused.code, "INVALID_OPTION", JSON.stringify(refused));
  }
  denied = true;
  const before = requests.length;
  const failure = await run(["containers", "get", appId, "worker"], 1);
  assert.equal(failure.error.code, "COMPUTE_STARTING_PENDING");
  assert.equal(failure.error.details.origin, "policy");
  assert.equal(failure.error.details.retryScope, "request");
  assert.equal(business(before).length, 1, "denial triggered alternate authority or replay");
  for (const file of await readdir(path.join(temporary, "journal"), { recursive: true })) {
    if (!file.endsWith(".json")) continue;
    const content = await readFile(path.join(temporary, "journal", file), "utf8");
    for (const secret of ["synthetic-registry-password", "synthetic-other-password", "input-payload", "synthetic-compute-authority"]) assert.ok(!content.includes(secret), "journal retained private data");
  }
  console.log("Compute HTTP contract passed: production/development routes, durable replay, lost replies, validation, logs, Feed v2, registry privacy and payer authority.");
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
