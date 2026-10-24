import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import * as tar from "tar";

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
  const draft = state.drafts.get(session.draftId);
  return {
    id: session.id, appId, draftId: session.draftId, status: session.status,
    previewUrl: "https://preview.example.test", browserPreviewUrl: "https://review.example.test",
    baseDeploymentId: null,
    activeRevision: {
      id: session.revisionId, draftRevision: draft.validatedRevision,
      artifactSha256: draft.validatedDigest, migrationDigest: "b".repeat(64),
    },
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
      const built = await serverBuild(draft);
      draft.status = "validated";
      draft.validatedDigest = built.sha256;
      draft.validatedRevision = draft.revision;
      return send(response, 200, {
        id: randomUUID(), draftId: draft.id, revision: draft.revision, passed: true,
        artifactSha256: built.sha256, manifest: built.manifest, canonicalSourceManifest: "opencloud.yaml",
        sourceManifest: draft.files.has("opencloud.yaml") ? "opencloud.yaml" : "opencloud.json",
        sourceFiles: [...draft.files.keys()].sort(), artifactFiles: built.files, diagnostics: [],
        nextAction: "Start or apply a development session for this exact validated revision.", createdAt: now,
      });
    }
    if (parts[5] === "dev-sessions" && request.method === "POST") {
      const session = { id: randomUUID(), draftId: draft.id, status: "active", revisionId: randomUUID() };
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
      session.revisionId = randomUUID();
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

async function runCli(argumentsList, { status = 0, remote = true } = {}) {
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
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(exit, status, `${argumentsList.join(" ")}\n${stderr}`);
  return { stdout, stderr };
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
  assert.deepEqual(
    { artifactSha256: (await devState()).artifactSha256, serverArtifactSha256: (await devState()).serverArtifactSha256 },
    { artifactSha256: local, serverArtifactSha256: serverDigest },
  );

  // 2. dev sync follows a local change with OpenCloud's new digest.
  await write("frontend/index.html", "<!doctype html><title>Counter v2</title>\n");
  await runCli(["app", "dev", "sync", app]);
  const synced = lastDraft().validatedDigest;
  assert.notEqual(synced, serverDigest);
  assert.equal((await devState()).serverArtifactSha256, synced);

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

  // 5. A manifest OpenCloud resolves differently is retried with the canonical
  //    opencloud.json, and the message names the key.
  state.resolveYamlDifferently = true;
  await write("frontend/index.html", "<!doctype html><title>Counter v4</title>\n");
  const retried = await runCli(["deploy", app]);
  assert.match(retried.stderr, /resolved opencloud\.yaml differently from this CLI \(runtime\)/);
  assert.ok(lastDraft().files.has("opencloud.json"));
  state.resolveYamlDifferently = false;

  // 6. A real difference in OpenCloud's artifact still fails, and says which.
  state.extraArtifactFile = true;
  await write("frontend/index.html", "<!doctype html><title>Counter v5</title>\n");
  const refused = await runCli(["deploy", app], { status: 1 });
  const error = JSON.parse(refused.stderr.trim().split("\n").at(-1)).error;
  assert.equal(error.code, "ARTIFACT_MISMATCH");
  assert.match(error.message, /Only OpenCloud's artifact has: frontend\/extra\.js\./);
  state.extraArtifactFile = false;

  process.stdout.write(
    "Artifact compression contract passed: dev start, sync, verify, promote and deploy adopt OpenCloud's digest for identical content, the manifest retry names its keys, and real differences are refused.\n",
  );
} finally {
  server.close();
  await rm(temporary, { recursive: true, force: true });
}
