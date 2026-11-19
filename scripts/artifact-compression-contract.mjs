import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import * as tar from "tar";
import YAML from "yaml";

// Drives the built CLI through dev start, sync, verify, promote and deploy
// against a fake control plane that bundles each uploaded draft for real and
// then compresses it with another zlib setting. Official Node builds, Node
// built against a system zlib, Bun and Deno compress the same tar
// differently, so OpenCloud's digest can differ while every file and the
// manifest match. The CLI must then adopt OpenCloud's digest, and refuse
// only real differences.
const root = path.resolve(import.meta.dirname, "..");
const binary = path.join(root, "dist", "index.cjs");
const temporary = await mkdtemp(path.join(os.tmpdir(), "opencloud-artifact-compression-contract-"));
const appId = "30000000-0000-4000-8000-000000000001";
const actorId = "30000000-0000-4000-8000-000000000002";
const now = "2026-10-24T12:00:00.000Z";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const state = {
  drafts: new Map(),
  sessions: new Map(),
  deployments: new Map(),
  operations: new Map(),
  verifications: new Map(),
  activeDeploymentId: null,
  /** Resolves the manifest of a draft differently until it uploads opencloud.json. */
  resolveYamlDifferently: false,
  /** Adds a file to OpenCloud's artifact that the CLI never bundled. */
  extraArtifactFile: false,
  dropApplyReply: false,
  /** Refuses the next apply as a full compute host would, applying nothing. */
  refuseApply: false,
  interruptValidation: null,
  busyBeforeInterruption: false,
  busyValidation: false,
  validationHttpFailure: null,
  canonicalReceiptKey: null,
  requests: [],
};

function send(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function draftRecord(draft) {
  return {
    id: draft.id, appId, baseDeploymentId: null, name: draft.name, status: draft.status,
    revision: draft.revision, createdAt: now, updatedAt: now,
    deployedAt: draft.status === "deployed" ? now : null,
  };
}

function sessionRecord(session) {
  return {
    id: session.id, appId, draftId: session.draftId, status: session.status,
    previewUrl: "https://preview.example.test", browserPreviewUrl: "https://review.example.test",
    baseDeploymentId: session.baseDeploymentId ?? null,
    activeRevision: session.applied ?? null,
    verification: null,
    capabilities: {
      frontend: true, database: true, functions: true, jobs: true, files: true,
      productionSecrets: false, cron: false, syntheticAuth: true, emailCapture: true,
      emailInboundInjection: true, notificationCapture: true,
    },
    createdAt: now, updatedAt: now, lastActivityAt: now, expiresAt: "2026-10-25T12:00:00.000Z",
  };
}

function deploymentRecord(release) {
  return {
    id: release.id, appId, version: "candidate", artifactSha256: release.artifactSha256,
    sdkVersion: "2.3.0", manifest: {},
    state: state.activeDeploymentId === release.id ? "active" : "superseded",
    rollbackOfDeploymentId: null, error: null, createdAt: now, activatedAt: now,
  };
}

function operationRecord(id, type, deploymentId) {
  return {
    id, appId, deploymentId, type, state: "succeeded", actorType: "user", actorId,
    idempotencyKey: "server-redacted", error: null, createdAt: now, updatedAt: now,
  };
}

function verificationRecord(id, deploymentId, operationId) {
  return {
    id, appId, deploymentId, operationId, state: "passed", phases: [], diagnostics: [],
    startedAt: now, finishedAt: now, createdAt: now,
  };
}

/** Builds a draft as OpenCloud does: the real bundler over its stored files. */
async function serverBuild(draft) {
  const directory = await mkdtemp(path.join(temporary, "server-build-"));
  try {
    for (const [file, value] of draft.files) {
      await mkdir(path.dirname(path.join(directory, "tree", file)), { recursive: true });
      await writeFile(path.join(directory, "tree", file), value.content, { mode: 0o600 });
    }
    const archivePath = path.join(directory, "artifact.tgz");
    await runCli(["validate", path.join(directory, "tree"), "--write-archive", archivePath], {
      remote: false,
    });
    // Same tar, another zlib setting: what a differently linked runtime returns.
    const archive = gzipSync(gunzipSync(await readFile(archivePath)), { level: 9 });
    const files = [];
    let manifest = null;
    await tar.t({
      file: archivePath,
      onReadEntry: (entry) => {
        if (entry.type !== "File") return entry.resume();
        files.push(entry.path);
        if (entry.path !== "opencloud.json") return entry.resume();
        const chunks = [];
        entry.on("data", (chunk) => chunks.push(chunk));
        entry.on("end", () => {
          // The archive omits empty queues and integrations; OpenCloud's
          // validation returns the parsed manifest, which has them.
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          manifest = { queues: [], integrations: {}, ...parsed };
        });
      },
    });
    if (state.resolveYamlDifferently && !draft.files.has("opencloud.json")) {
      manifest = { ...manifest, runtime: { sdk: { version: "2.7.0" } } };
    }
    if (state.extraArtifactFile) files.push("frontend/extra.js");
    return { sha256: sha256(archive), manifest, files: files.sort() };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const server = createServer(async (request, response) => {
  const body = await bodyOf(request);
  // Error reports from failing commands have their own contract.
  if (request.url === "/v1/platform-errors/reports") return response.writeHead(202).end();
  const url = new URL(request.url, "http://contract.test");
  state.requests.push({ method: request.method, path: url.pathname });
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/version") {
    return send(response, 200, {
      version: "9.9.9", commit: "contract", builtAt: now, releaseId: "platform-v9.9.9",
      contracts: { cliMutationJournal: 1, releaseSource: 1, deployPreconditions: 1, platformBuilds: 1 },
    });
  }
  if (parts[0] === "v1" && parts[1] === "operations") {
    return send(response, 200, state.operations.get(parts[2]));
  }
  if (parts[0] !== "v1" || parts[1] !== "apps" || parts[2] !== appId) {
    return send(response, 404, { code: "NOT_FOUND", message: url.pathname });
  }
  if (parts.length === 3) {
    return send(response, 200, {
      id: appId, identityStatus: "assigned", name: "Counter", slug: "counter",
      appUrl: "https://counter.example.test", authUrl: "https://auth.example.test",
      apiUrl: "https://api.example.test", visibility: "private", state: "active", ownerUserId: actorId,
      desiredDeploymentId: state.activeDeploymentId, activeDeploymentId: state.activeDeploymentId,
      createdAt: now, updatedAt: now,
    });
  }
  if (parts[3] === "drafts" && parts.length === 4 && request.method === "POST") {
    const draft = { id: randomUUID(), name: JSON.parse(body).name, status: "open", revision: 1, files: new Map() };
    state.drafts.set(draft.id, draft);
    return send(response, 201, draftRecord(draft));
  }
  if (parts[3] === "drafts") {
    const draft = state.drafts.get(parts[4]);
    if (!draft) return send(response, 404, { code: "NOT_FOUND", message: "draft" });
    if (parts.length === 5) return send(response, 200, draftRecord(draft));
    if (parts[5] === "files" && request.method === "GET") {
      return send(response, 200, [...draft.files].map(([file, value]) => ({
        path: file, sha256: value.sha256, baseSha256: null, sizeBytes: value.content.length,
        deleted: false, updatedAt: now,
      })));
    }
    if (parts[5] === "files" && request.method === "PATCH") {
      const input = JSON.parse(body);
      assert.equal(input.expectedRevision, draft.revision);
      if (state.canonicalReceiptKey && input.changes.some(change => change.path === "opencloud.json")) {
        const receipt = (await validationEntry(state.canonicalReceiptKey)).checkpoint.validation;
        assert.equal(receipt.state, "result", "Canonical writes require a durable authoritative validation result");
        assert.equal(receipt.draftId, draft.id);
        assert.equal(receipt.revision, draft.revision);
        assert.equal(receipt.validationId, draft.validation.id);
        assert.equal(receipt.artifactSha256, draft.validation.artifactSha256);
        assert.equal(receipt.passed, true);
      }
      for (const change of input.changes) {
        if (change.delete) draft.files.delete(change.path);
        else {
          const content = Buffer.from(change.contentBase64, "base64");
          draft.files.set(change.path, { content, sha256: sha256(content) });
        }
      }
      draft.revision += 1;
      draft.status = "open";
      return send(response, 200, { draft: draftRecord(draft), files: [] });
    }
    if (parts[5] === "validate") {
      assert.equal(JSON.parse(body).expectedRevision, draft.revision);
      if (state.busyValidation) {
        state.busyValidation = false;
        response.setHeader("Retry-After", "2");
        return send(response, 429, { code: "DRAFT_VALIDATION_IN_PROGRESS", retryable: true,
          details: { appId, draftId: draft.id, revision: draft.revision, retryAfterSeconds: 2 } });
      }
      if (state.interruptValidation) {
        if (state.busyBeforeInterruption) {
          state.busyBeforeInterruption = false;
          response.setHeader("Retry-After", "1");
          return send(response, 429, { code: "DRAFT_VALIDATION_IN_PROGRESS", retryable: true,
            details: { appId, draftId: draft.id, revision: draft.revision, retryAfterSeconds: 1 } });
        }
        const interrupt = state.interruptValidation;
        state.interruptValidation = null;
        interrupt();
        request.socket.destroy();
        return;
      }
      const built = await serverBuild(draft);
      draft.status = "validated";
      draft.validatedDigest = built.sha256;
      draft.validatedRevision = draft.revision;
      draft.validation = {
        id: randomUUID(), draftId: draft.id, revision: draft.revision, passed: true,
        artifactSha256: built.sha256, manifest: built.manifest, canonicalSourceManifest: "opencloud.yaml",
        sourceManifest: draft.files.has("opencloud.yaml") ? "opencloud.yaml" : "opencloud.json",
        sourceFiles: [...draft.files.keys()].sort(), artifactFiles: built.files, diagnostics: [],
        nextAction: "Start or apply a development session for this exact validated revision.", createdAt: now,
      };
      if (state.validationHttpFailure) {
        const status = state.validationHttpFailure;
        state.validationHttpFailure = null;
        // The upstream accepted and completed the validation before a proxy
        // substituted an error. The next POST would succeed if blindly sent.
        return send(response, status, { code: "internal_error", message: "Synthetic proxy failure" });
      }
      return send(response, 200, draft.validation);
    }
    if (parts[5] === "dev-sessions" && request.method === "POST") {
      assert.equal(JSON.parse(body).apply, false, "Create and retain the session before applying a revision");
      // OpenCloud returns the draft's live session; a new one starts from the live release.
      const live = [...state.sessions.values()].find((value) => value.draftId === draft.id && value.status === "active");
      if (live) return send(response, 201, sessionRecord(live));
      const session = { id: randomUUID(), draftId: draft.id, status: "active", revisionId: randomUUID(), baseDeploymentId: state.activeDeploymentId };
      state.sessions.set(session.id, session);
      return send(response, 201, sessionRecord(session));
    }
    if (parts[5] === "deploy") {
      return send(response, 202, release(draft, "deploy_draft"));
    }
  }
  if (parts[3] === "dev-receipts") {
    return send(response, 200, [...state.sessions.values()].filter((session) => session.receipt).map((session) => session.receipt));
  }
  if (parts[3] === "dev-sessions") {
    const session = state.sessions.get(parts[4]);
    if (!session) return send(response, 404, { code: "NOT_FOUND", message: "session" });
    if (parts.length === 5 && request.method === "GET") return send(response, 200, sessionRecord(session));
    if (parts.length === 5 && request.method === "DELETE") {
      session.status = "stopped";
      return send(response, 200, sessionRecord(session));
    }
    if (parts[5] === "apply") {
      if (!session.applied && !session.refused) {
        await assert.rejects(readFile(path.join(app, ".opencloud", "dev.json")), { code: "ENOENT" });
      }
      if (state.refuseApply) {
        state.refuseApply = false;
        session.refused = true;
        return send(response, 503, { statusCode: 503, code: "COMPUTE_NO_CAPACITY", message: "Every available compute host is full right now. Retry shortly.",
          details: { category: "capacity", origin: "platform", phase: "admission", retryScope: "unstarted_preparation", retryable: true, billingDisposition: "none" } });
      }
      session.revisionId = randomUUID();
      const draft = state.drafts.get(session.draftId);
      session.applied = { id: session.revisionId, draftRevision: draft.validatedRevision,
        artifactSha256: draft.validatedDigest, migrationDigest: "b".repeat(64) };
      if (state.dropApplyReply) {
        state.dropApplyReply = false;
        request.socket.destroy();
        return;
      }
      return send(response, 200, sessionRecord(session));
    }
    if (parts[5] === "verify") {
      const draft = state.drafts.get(session.draftId);
      session.status = "verified";
      session.receipt = {
        id: randomUUID(), sessionId: session.id, revisionId: session.revisionId,
        artifactSha256: draft.validatedDigest, engineVersion: "contract-1", summary: { passed: true },
        createdAt: now, expiresAt: "2026-10-25T12:00:00.000Z",
      };
      const { sessionId: _sessionId, engineVersion: _engineVersion, createdAt: _createdAt, ...receipt } = session.receipt;
      return send(response, 200, { session: sessionRecord(session), receipt });
    }
    if (parts[5] === "promote") {
      return send(response, 200, release(state.drafts.get(session.draftId), "promote_dev_revision"));
    }
  }
  if (parts[3] === "verifications" && request.method === "POST") {
    const operationId = randomUUID();
    const verification = verificationRecord(randomUUID(), state.activeDeploymentId, operationId);
    state.verifications.set(verification.id, verification);
    state.operations.set(operationId, operationRecord(operationId, "verify_app", state.activeDeploymentId));
    return send(response, 200, { verification: { ...verification, state: "queued", finishedAt: null }, operation: state.operations.get(operationId) });
  }
  if (parts[3] === "verifications" && parts[4]) {
    return send(response, 200, state.verifications.get(parts[4]));
  }
  return send(response, 404, { code: "NOT_FOUND", message: `unhandled ${request.method} ${url.pathname}` });
});

/** Releases a validated draft with OpenCloud's own artifact digest. */
function release(draft, type) {
  const deployment = { id: randomUUID(), artifactSha256: draft.validatedDigest };
  state.deployments.set(deployment.id, deployment);
  state.activeDeploymentId = deployment.id;
  draft.status = "deployed";
  const operationId = randomUUID();
  state.operations.set(operationId, operationRecord(operationId, type, deployment.id));
  return { draft: draftRecord(draft), deployment: deploymentRecord(deployment), operation: state.operations.get(operationId) };
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

async function runCli(argumentsList, { status = 0, remote = true, interruptValidation = false, busyBeforeInterruption = false,
  interruptAfterProgress = false } = {}) {
  const environment = { ...process.env };
  for (const key of ["INIT_CWD", "OPENCLOUD_API_URL", "OPENCLOUD_TOKEN", "OPENCLOUD_SESSION_FILE", "OPENCLOUD_WORKSPACE_FILE", "OPENCLOUD_TELEMETRY", "DO_NOT_TRACK"]) {
    delete environment[key];
  }
  environment.OPENCLOUD_MUTATION_JOURNAL_DIR = path.join(temporary, "journal");
  // Without the fake API, an error report would go to the default installation.
  if (!remote) environment.OPENCLOUD_TELEMETRY = "0";
  const prefix = remote
    ? ["--api-url", `http://127.0.0.1:${server.address().port}`, "--token", "synthetic-compression"]
    : [];
  const child = spawn(process.execPath, [binary, ...prefix, ...argumentsList], {
    env: environment, stdio: ["ignore", "pipe", "pipe"],
  });
  if (interruptValidation) {
    state.interruptValidation = () => child.kill("SIGKILL");
    state.busyBeforeInterruption = busyBeforeInterruption;
  }
  if (interruptAfterProgress) state.busyValidation = true;
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
    // Progress is printed only after the matching receipt is durably saved.
    if (interruptAfterProgress && stderr.includes("Validation is still running for draft")) child.kill("SIGKILL");
  });
  const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(exit, status, `${argumentsList.join(" ")}\n${stderr}`);
  return { stdout, stderr };
}

async function ageInterruptedLocks(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const nested = path.join(directory, item.name);
    if (item.name.endsWith(".lock")) {
      // Only this disposable fixture's locks, after its child has exited.
      const stale = new Date(Date.now() - 120_000);
      await utimes(nested, stale, stale);
    } else await ageInterruptedLocks(nested);
  }
}

async function assertValidationInterruption(argumentsList, key, busyBeforeInterruption = false) {
  const args = [...argumentsList, "--idempotency-key", key];
  const before = state.requests.length;
  await runCli(args, { status: null, interruptValidation: true, busyBeforeInterruption });
  const entry = await validationEntry(key);
  assert.equal(entry.checkpoint.validation.state, "dispatched", "Dispatch must be durable before the server sees the POST");
  const expectedPosts = busyBeforeInterruption ? 2 : 1;
  assert.equal(state.requests.slice(before).filter(request => request.path.endsWith("/validate")).length, expectedPosts);
  await ageInterruptedLocks(temporary);
  const reentryAt = state.requests.length;
  const reopened = await runCli(args, { status: 1 });
  assert.equal(JSON.parse(reopened.stderr.trim().split("\n").at(-1)).error.code, "DRAFT_VALIDATION_OUTCOME_UNKNOWN");
  assert.ok(state.requests.slice(reentryAt).every(request => request.method === "GET"), "Unacknowledged validation recovery must not overwrite files or replay any POST");
  assert.equal(state.requests.slice(before).filter(request => request.path.endsWith("/validate")).length, expectedPosts);
}

async function validationEntry(key) {
  const entries = await Promise.all((await readdir(path.join(temporary, "journal", "entries"))).map(async name =>
    JSON.parse(await readFile(path.join(temporary, "journal", "entries", name), "utf8"))));
  const entry = entries.find(value => value.idempotencyKey === key);
  assert.ok(entry, `Missing validation journal for ${key}`);
  return entry;
}

async function assertValidationHttpFailure(argumentsList, key, status) {
  const args = [...argumentsList, "--idempotency-key", key];
  const before = state.requests.length;
  state.validationHttpFailure = status;
  const failed = await runCli(args, { status: 1 });
  assert.equal(JSON.parse(failed.stderr.trim().split("\n").at(-1)).error.code, "DRAFT_VALIDATION_OUTCOME_UNKNOWN");
  const entry = await validationEntry(key);
  assert.equal(entry.state, "unknown");
  assert.equal(entry.checkpoint.validation.state, "dispatched");
  assert.equal(state.drafts.get(entry.checkpoint.validation.draftId).validation.passed, true, "The upstream accepted this validation");
  const reentryAt = state.requests.length;
  const reopened = await runCli(args, { status: 1 });
  assert.equal(JSON.parse(reopened.stderr.trim().split("\n").at(-1)).error.code, "DRAFT_VALIDATION_OUTCOME_UNKNOWN");
  assert.ok(state.requests.slice(reentryAt).every(request => request.method === "GET"));
  assert.equal(state.requests.slice(before).filter(request => request.path.endsWith("/validate")).length, 1,
    `HTTP ${status} must not authorize another validation POST on reopen`);
}

async function interruptAcknowledgedProgress(args, key) {
  await runCli([...args, "--idempotency-key", key], { status: null, interruptAfterProgress: true });
  const receipt = (await validationEntry(key)).checkpoint.validation;
  assert.equal(receipt.state, "progress");
  await ageInterruptedLocks(temporary);
  return receipt;
}

const app = path.join(temporary, "app");
const write = async (file, content) => {
  await mkdir(path.dirname(path.join(app, file)), { recursive: true });
  await writeFile(path.join(app, file), content);
};
const devState = async () => JSON.parse(await readFile(path.join(app, ".opencloud", "dev.json"), "utf8"));
const lastDraft = () => [...state.drafts.values()].at(-1);

try {
  await runCli(["init", app, "--app-id", appId], { remote: false });
  await write("frontend/index.html", "<!doctype html><title>Counter</title>\n");
  const local = JSON.parse((await runCli(["validate", app], { remote: false })).stdout).artifactSha256;

  // 1. dev start adopts OpenCloud's digest for the same content instead of
  //    failing, and keeps the author manifest: no canonical retry happens.
  const started = await runCli(["app", "dev", "start", app]);
  assert.match(started.stderr, /compressed the same files differently/);
  assert.doesNotMatch(started.stderr, /resolved .* differently/);
  const serverDigest = lastDraft().validatedDigest;
  assert.notEqual(serverDigest, local);
  assert.ok(lastDraft().files.has("opencloud.yaml"));
  assert.ok(!lastDraft().files.has("opencloud.json"));
  assert.equal(JSON.parse(started.stdout).session.activeRevision.artifactSha256, serverDigest);
  // Every uploaded file is part of this app, so the source carries nothing more.
  assert.deepEqual(
    { files: JSON.parse(started.stdout).sourceOnlyFiles, count: JSON.parse(started.stdout).sourceOnlyFileCount },
    { files: [], count: 0 },
  );
  assert.doesNotMatch(started.stderr, /Also kept with the app's source/);
  assert.deepEqual(
    { artifactSha256: (await devState()).artifactSha256, serverArtifactSha256: (await devState()).serverArtifactSha256 },
    { artifactSha256: local, serverArtifactSha256: serverDigest },
  );

  // Kill actual CLI children after POST admission, with no response or busy
  // acknowledgement. Every normal consumer must reopen without another write.
  await assertValidationInterruption(["draft", "validate", appId, lastDraft().id], "kill-direct-validation");
  await assertValidationInterruption(["draft", "validate", appId, lastDraft().id], "kill-after-acknowledged-progress", true);
  await assertValidationInterruption(["app", "dev", "sync", app], "kill-dev-sync-validation");
  await assertValidationInterruption(["app", "dev", "start", app], "kill-dev-start-validation");
  await assertValidationInterruption(["deploy", app], "kill-deploy-validation");

  for (const status of [408, 500, 502, 503, 504]) {
    await assertValidationHttpFailure(["draft", "validate", appId, lastDraft().id], `http-${status}-direct-validation`, status);
  }
  await assertValidationHttpFailure(["app", "dev", "sync", app], "http-504-dev-sync-validation", 504);
  await assertValidationHttpFailure(["app", "dev", "start", app], "http-504-dev-start-validation", 504);
  await assertValidationHttpFailure(["deploy", app], "http-504-deploy-validation", 504);

  // 2. dev sync follows a local change with OpenCloud's new digest.
  await write("frontend/index.html", "<!doctype html><title>Counter v2</title>\n");
  state.dropApplyReply = true;
  const beforeSync = state.requests.length;
  const sync = JSON.parse((await runCli(["app", "dev", "sync", app])).stdout);
  assert.deepEqual({ files: sync.sourceOnlyFiles, count: sync.sourceOnlyFileCount }, { files: [], count: 0 });
  const synced = state.drafts.get((await devState()).draftId).validatedDigest;
  assert.notEqual(synced, serverDigest);
  assert.equal((await devState()).serverArtifactSha256, synced);
  const syncRequests = state.requests.slice(beforeSync);
  assert.equal(syncRequests.filter(request => request.path.endsWith("/apply")).length, 1, "A lost apply reply must never repeat the POST");
  const appliedAt = syncRequests.findIndex(request => request.path.endsWith("/apply"));
  assert.ok(syncRequests.slice(appliedAt + 1).every(request => request.method === "GET"), "Lost reply reconciliation only reads");

  // 3. dev verify and promote accept the receipt and release OpenCloud built.
  await runCli(["app", "dev", "verify", app]);
  const promoted = JSON.parse((await runCli(["app", "dev", "promote", app])).stdout);
  assert.deepEqual(
    { completed: promoted.completed, devStopped: promoted.devStopped, localStateRemoved: promoted.localStateRemoved },
    { completed: true, devStopped: true, localStateRemoved: true },
  );
  await assert.rejects(readFile(path.join(app, ".opencloud", "dev.json")), { code: "ENOENT" });
  assert.equal(state.deployments.get(state.activeDeploymentId).artifactSha256, synced);

  // 4. A plain deploy releases the same content under OpenCloud's digest.
  await write("frontend/index.html", "<!doctype html><title>Counter v3</title>\n");
  await runCli(["deploy", app]);
  assert.equal(lastDraft().status, "deployed");
  assert.equal(state.deployments.get(state.activeDeploymentId).artifactSha256, lastDraft().validatedDigest);

  // 5. Reopen acknowledged validation progress before normalizing a manifest
  //    OpenCloud resolves differently. One container supplies the documented
  //    waiting budget; this fake API bundles it without contacting a registry.
  state.resolveYamlDifferently = true;
  const manifest = YAML.parse(await readFile(path.join(app, "opencloud.yaml"), "utf8"));
  manifest.containers = [{ name: "validation-fixture", kind: "job", image: "registry.example/fixture:1", job: {} }];
  await write("opencloud.yaml", YAML.stringify(manifest));
  await write("frontend/index.html", "<!doctype html><title>Counter v4</title>\n");
  const normalizationKey = "resume-progress-canonical-manifest";
  const progress = await interruptAcknowledgedProgress(["deploy", app], normalizationKey);
  state.canonicalReceiptKey = normalizationKey;
  const resumedAt = state.requests.length;
  const retried = await runCli(["deploy", app, "--idempotency-key", normalizationKey]);
  assert.match(retried.stderr, /resolved opencloud\.yaml differently from this CLI \(runtime\)/);
  assert.ok(lastDraft().files.has("opencloud.json"));
  assert.equal(lastDraft().id, progress.draftId, "Resume must retain the exact source draft");
  const resumedWrites = state.requests.slice(resumedAt).filter(request => request.method !== "GET");
  assert.deepEqual(resumedWrites.map(request => [request.method, request.path.split("/").at(-1)]), [
    ["POST", "validate"], ["PATCH", "files"], ["POST", "validate"], ["POST", "deploy"],
  ]);
  assert.equal((await validationEntry(normalizationKey)).state, "completed");
  state.canonicalReceiptKey = null;
  state.resolveYamlDifferently = false;

  // Initial revision and file drift still refuse every write before a resumed
  // progress receipt has obtained its exact authoritative result.
  for (const drift of ["revision", "files"]) {
    const key = `resume-progress-${drift}-drift`;
    const pending = await interruptAcknowledgedProgress(["deploy", app], key);
    const draft = state.drafts.get(pending.draftId);
    if (drift === "revision") draft.revision += 1;
    else {
      const content = Buffer.from("concurrent source edit");
      draft.files.set("frontend/index.html", { content, sha256: sha256(content) });
    }
    const before = state.requests.length;
    const refused = await runCli(["deploy", app, "--idempotency-key", key], { status: 1 });
    assert.equal(JSON.parse(refused.stderr.trim().split("\n").at(-1)).error.code, "MUTATION_REPLAY_MISMATCH");
    assert.ok(state.requests.slice(before).every(request => request.method === "GET"), "Initial progress drift must not be overwritten");
    assert.deepEqual((await validationEntry(key)).checkpoint.validation, pending);
  }

  // 6. A real difference in OpenCloud's artifact still fails, and says which.
  state.extraArtifactFile = true;
  await write("frontend/index.html", "<!doctype html><title>Counter v5</title>\n");
  const refused = await runCli(["deploy", app], { status: 1 });
  const error = JSON.parse(refused.stderr.trim().split("\n").at(-1)).error;
  assert.equal(error.code, "ARTIFACT_MISMATCH");
  assert.match(error.message, /Only OpenCloud's artifact has: frontend\/extra\.js\./);
  state.extraArtifactFile = false;

  // 7. A development start whose apply OpenCloud refused (S1: no capacity)
  //    keeps its session, and running it again with edited files retries
  //    that session and draft instead of leaving them behind.
  const errorOf = (result) => JSON.parse(result.stderr.trim().split("\n").at(-1)).error;
  const appliesIn = (from) => state.requests.slice(from).filter((request) => request.path.endsWith("/apply")).length;
  await write("frontend/index.html", "<!doctype html><title>Counter v7</title>\n");
  const draftsBefore = state.drafts.size;
  const sessionsBefore = state.sessions.size;
  state.refuseApply = true;
  const refusal = errorOf(await runCli(["app", "dev", "start", app], { status: 1 }));
  assert.equal(refusal.code, "COMPUTE_NO_CAPACITY");
  assert.equal(refusal.details.retryScope, "unstarted_preparation");
  assert.equal(refusal.hint, `Nothing was applied, and the development session is kept: run \`opencloud app dev start ${app}\` again to retry with it, or \`opencloud app dev stop ${app}\` to end it.`);
  const kept = await devState();
  assert.equal(state.sessions.get(kept.sessionId).applied, undefined, "The refused session has no applied revision");
  assert.equal(JSON.parse((await runCli(["app", "dev", "status", app])).stdout).id, kept.sessionId);
  const verifyEarly = errorOf(await runCli(["app", "dev", "verify", app], { status: 1 }));
  assert.equal(verifyEarly.code, "DEV_REVISION_NOT_APPLIED");
  await write("frontend/index.html", "<!doctype html><title>Counter v8</title>\n");
  const retryAt = state.requests.length;
  const devRetry = JSON.parse((await runCli(["app", "dev", "start", app])).stdout);
  assert.equal(devRetry.session.id, kept.sessionId, "The retry reuses the refused session");
  assert.equal(state.drafts.size, draftsBefore + 1, "The retry reuses the refused draft");
  assert.equal(state.sessions.size, sessionsBefore + 1);
  assert.equal(appliesIn(retryAt), 1, "The retry sends one new apply instead of waiting out the refused one");
  assert.equal((await devState()).draftId, kept.draftId);

  // 8. An interrupted start holds its target: a changed request names its
  //    key and the exact resume command, and that key resumes it, alone.
  const interruptedAt = state.requests.length;
  await runCli(["app", "dev", "start", app], { status: null, interruptValidation: true });
  await ageInterruptedLocks(temporary);
  await write("frontend/index.html", "<!doctype html><title>Counter v9</title>\n");
  const held = errorOf(await runCli(["app", "dev", "start", app], { status: 1 }));
  assert.equal(held.code, "MUTATION_IN_PROGRESS");
  assert.equal(held.pending.command, "opencloud app dev start");
  assert.equal(held.pending.state, "attempted");
  assert.match(held.pending.idempotencyKey, /^ocj1:/);
  assert.ok(held.hint.includes(`\`opencloud app dev start ${app} --idempotency-key ${held.pending.idempotencyKey}\``), held.hint);
  assert.ok(held.hint.includes(`\`opencloud app dev status ${app}\``), held.hint);
  await write("frontend/index.html", "<!doctype html><title>Counter v8</title>\n");
  const entriesBefore = (await readdir(path.join(temporary, "journal", "entries"))).length;
  const heldResumeAt = state.requests.length;
  const resumed = errorOf(await runCli(["app", "dev", "start", app, "--idempotency-key", held.pending.idempotencyKey], { status: 1 }));
  assert.equal(resumed.code, "DRAFT_VALIDATION_OUTCOME_UNKNOWN", "Its own key resumes the interrupted entry");
  assert.equal(resumed.pending.idempotencyKey, held.pending.idempotencyKey);
  assert.match(resumed.hint, /^The validation may still be running and was not repeated\. Check with `opencloud draft get /);
  assert.equal((await readdir(path.join(temporary, "journal", "entries"))).length, entriesBefore, "No second entry under that key");
  assert.ok(state.requests.slice(heldResumeAt).every((request) => request.method === "GET"), "Resuming repeats no request");
  assert.equal(state.requests.slice(interruptedAt).filter((request) => request.path.endsWith("/validate")).length, 1);

  // 9. A sync after a direct production deploy (J2, J3) says production
  //    changed, names both releases and the commands, and sends no apply.
  await write("frontend/index.html", "<!doctype html><title>Counter v10</title>\n");
  // Section 6's refused deploy still holds the unkeyed deploy target.
  await runCli(["deploy", app, "--idempotency-key", "overtaking-production-deploy"]);
  const syncAt = state.requests.length;
  const overtaken = errorOf(await runCli(["app", "dev", "sync", app], { status: 1 }));
  assert.equal(overtaken.code, "ACTIVE_DEPLOYMENT_CHANGED");
  assert.equal(overtaken.expectedActiveDeploymentId, state.sessions.get(kept.sessionId).baseDeploymentId);
  assert.equal(overtaken.actualActiveDeploymentId, state.activeDeploymentId);
  assert.notEqual(overtaken.expectedActiveDeploymentId, overtaken.actualActiveDeploymentId);
  assert.equal(overtaken.hint, `Run \`opencloud app dev stop ${app}\`, then \`opencloud app dev start ${app}\`.`);
  assert.equal(appliesIn(syncAt), 0, "No apply is sent to a session production overtook");

  process.stdout.write(
    "Artifact compression and recovery contract passed: authoritative digests, dev readiness with lost replies, five killed validation dispatches and eight HTTP failures with no replay, resumed canonical manifest normalization, initial drift refusal, real mismatch refusal, a refused development apply retried with its kept session, an interrupted start resumed by its own key, and a sync production overtook refused before any apply.\n",
  );
} finally {
  server.close();
  await rm(temporary, { recursive: true, force: true });
}
