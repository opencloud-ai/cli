import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

// Drives the built CLI against a fake control plane: full-source uploads and
// the files they carry beyond the app, the stale-release precondition and
// --force, the canonical-manifest fallback, older APIs, base recording, pull,
// and frontends OpenCloud builds.
const root = path.resolve(import.meta.dirname, "..");
const binary = path.join(root, "dist", "index.cjs");
const temporary = await mkdtemp(path.join(os.tmpdir(), "opencloud-release-source-contract-"));
const appId = "20000000-0000-4000-8000-000000000001";
const actorId = "20000000-0000-4000-8000-000000000002";
const now = "2026-10-14T12:00:00.000Z";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const state = {
  contracts: { cliMutationJournal: 1, releaseSource: 1, deployPreconditions: 1, platformBuilds: 1, pinnedDraftValidation: 1 },
  drafts: new Map(),
  deployments: new Map(),
  activeDeploymentId: null,
  /** Digest the fake validator reports; null reports the CLI's own digest. */
  validationDigests: [],
  localDigest: null,
  /** Validations to answer with explicit bounded progress first. */
  validationBusy: 0,
  /** Diagnostics for a failed validation, as a failed platform build reports. */
  validationFailure: null,
  /** What GET /v1/installation answers; null answers 404, as servers before it did. */
  installation: null,
  /** A 2.35.x server: how long it holds the next frontend-build validation. */
  legacyHoldMs: 0,
  /** A 2.35.x server: frontend-build validations to answer FRONTEND_BUILD_BUSY first. */
  legacyBuildBusy: 0,
  requests: [],
};

function deploymentRecord(release) {
  return {
    id: release.id,
    appId,
    version: release.version,
    artifactSha256: release.artifactSha256,
    sdkVersion: "2.3.0",
    manifest: {},
    state: release.rolledBack ? "rolled_back" : state.activeDeploymentId === release.id ? "active" : "superseded",
    rollbackOfDeploymentId: null,
    error: null,
    createdAt: now,
    activatedAt: now,
    source: release.source
      ? { sha256: release.source.sha256, sizeBytes: release.source.bytes.length, fileCount: release.source.fileCount }
      : null,
  };
}

function draftRecord(draft) {
  return {
    id: draft.id,
    appId,
    baseDeploymentId: null,
    name: draft.name,
    status: draft.status,
    revision: draft.revision,
    createdAt: now,
    updatedAt: now,
    deployedAt: draft.status === "deployed" ? now : null,
  };
}

function fileRecord(filePath, value) {
  return {
    path: filePath,
    sha256: value.sha256,
    baseSha256: null,
    sizeBytes: value.content.length,
    deleted: false,
    updatedAt: now,
  };
}

function operation(id, deploymentId) {
  return {
    id,
    appId,
    deploymentId,
    type: "deploy",
    state: "succeeded",
    actorType: "user",
    actorId,
    idempotencyKey: "server-redacted",
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function archive(files) {
  const directory = await mkdtemp(path.join(temporary, "archive-"));
  const names = [...files.keys()].sort();
  for (const name of names) {
    await mkdir(path.dirname(path.join(directory, "tree", name)), { recursive: true });
    await writeFile(path.join(directory, "tree", name), files.get(name).content);
  }
  await tar.create({ file: path.join(directory, "out.tgz"), cwd: path.join(directory, "tree"), gzip: true, portable: true, noMtime: true }, names);
  return readFile(path.join(directory, "out.tgz"));
}

/** Records a release made outside the CLI, as another person would. */
async function externalRelease(files, { withSource = true } = {}) {
  const id = randomUUID();
  const fileMap = new Map(Object.entries(files).map(([name, content]) => {
    const bytes = Buffer.from(content);
    return [name, { content: bytes, sha256: sha256(bytes) }];
  }));
  const artifact = await archive(fileMap);
  const sourceBytes = withSource ? await archive(fileMap) : null;
  state.deployments.set(id, {
    id,
    version: `planner-20261014-${state.deployments.size + 1}`,
    artifactSha256: sha256(artifact),
    artifact,
    source: sourceBytes ? { bytes: sourceBytes, sha256: sha256(sourceBytes), fileCount: fileMap.size } : null,
  });
  state.activeDeploymentId = id;
  return id;
}

function send(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (request, response) => {
  const body = await bodyOf(request);
  // Error reports from failing commands have their own contract.
  if (request.url === "/v1/platform-errors/reports") return response.writeHead(202).end();
  const url = new URL(request.url, "http://contract.test");
  state.requests.push({ method: request.method, path: url.pathname, query: url.search, body });
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/version") {
    return send(response, 200, { version: "9.9.9", commit: "contract", builtAt: now, releaseId: "platform-v9.9.9", contracts: state.contracts });
  }
  if (url.pathname === "/v1/installation") {
    return state.installation ? send(response, 200, state.installation) : send(response, 404, { code: "NOT_FOUND", message: "not found" });
  }
  if (parts[0] === "v1" && parts[1] === "operations") {
    const release = [...state.deployments.values()].find((value) => value.operationId === parts[2]);
    return send(response, 200, operation(parts[2], release?.id ?? null));
  }
  if (parts[0] !== "v1" || parts[1] !== "apps" || parts[2] !== appId) return send(response, 404, { code: "NOT_FOUND", message: "not found" });
  if (parts.length === 3 && request.method === "GET") {
    return send(response, 200, {
      id: appId, identityStatus: "assigned", name: "Planner", slug: "planner",
      appUrl: "https://planner.example.test", authUrl: "https://auth.example.test", apiUrl: "https://api.example.test",
      visibility: "private", aiCredentialSource: "owner", state: "active", ownerUserId: actorId,
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
      return send(response, 200, [...draft.files].map(([name, value]) => fileRecord(name, value)));
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
      if (state.contracts.pinnedDraftValidation === 1) assert.equal(JSON.parse(body).expectedRevision, draft.revision);
      else {
        // A server before pinned validation (2.35.x) was never sent a revision.
        assert.equal("expectedRevision" in JSON.parse(body), false, "an older server was sent a pinned revision");
        if (state.legacyHoldMs) {
          const hold = state.legacyHoldMs;
          state.legacyHoldMs = 0;
          await new Promise((resolve) => setTimeout(resolve, hold));
        }
        if (state.legacyBuildBusy > 0) {
          state.legacyBuildBusy -= 1;
          return send(response, 429, { statusCode: 429, code: "FRONTEND_BUILD_BUSY", retryable: true,
            message: "OpenCloud is still building this frontend; validate the same revision again to wait for it" });
        }
      }
      if (state.validationBusy > 0) {
        state.validationBusy -= 1;
        response.setHeader("Retry-After", "2");
        return send(response, 429, { statusCode: 429, code: "DRAFT_VALIDATION_IN_PROGRESS", retryable: true,
          message: "Validation is pending; validate this exact revision again",
          details: { appId, draftId: draft.id, revision: draft.revision, retryAfterSeconds: 2 } });
      }
      if (state.validationFailure) {
        draft.status = "validation_failed";
        return send(response, 200, {
          id: randomUUID(), draftId: draft.id, revision: draft.revision, passed: false,
          artifactSha256: null, manifest: null, canonicalSourceManifest: "opencloud.yaml",
          sourceManifest: null, sourceFiles: [], artifactFiles: [], diagnostics: state.validationFailure,
          nextAction: "Fix the diagnostics and validate again.", createdAt: now,
        });
      }
      draft.status = "validated";
      const reported = state.validationDigests.length ? state.validationDigests.shift() : state.localDigest;
      draft.validatedDigest = reported;
      return send(response, 200, {
        id: randomUUID(), draftId: draft.id, revision: draft.revision, passed: true,
        artifactSha256: reported, manifest: null, canonicalSourceManifest: "opencloud.yaml",
        sourceManifest: null, sourceFiles: [], artifactFiles: [], diagnostics: [],
        nextAction: "Deploy the validated draft.", createdAt: now,
      });
    }
    if (parts[5] === "deploy") {
      const expected = url.searchParams.get("expectedActiveDeploymentId");
      if (expected && expected !== state.activeDeploymentId) {
        const latest = state.deployments.get(state.activeDeploymentId);
        return send(response, 409, {
          statusCode: 409, code: "ACTIVE_DEPLOYMENT_CHANGED",
          message: `The app's latest release is now release ${latest.version}, not the release this copy is based on.`,
          details: { expectedActiveDeploymentId: expected, actualActiveDeploymentId: latest.id, latestDeploymentId: latest.id, latestVersion: latest.version },
        });
      }
      const artifact = await archive(new Map([["opencloud.json", { content: Buffer.from("{}") }]]));
      const sourceBytes = state.contracts.releaseSource ? await archive(draft.files) : null;
      const id = randomUUID();
      const operationId = randomUUID();
      const release = {
        id, operationId, version: `planner-20261014-${state.deployments.size + 1}`,
        artifactSha256: draft.validatedDigest ?? state.localDigest, artifact,
        source: sourceBytes ? { bytes: sourceBytes, sha256: sha256(sourceBytes), fileCount: draft.files.size } : null,
      };
      state.deployments.set(id, release);
      state.activeDeploymentId = id;
      draft.status = "deployed";
      return send(response, 202, { draft: draftRecord(draft), deployment: deploymentRecord(release), operation: operation(operationId, id) });
    }
  }
  if (parts[3] === "deployments" && parts[4]) {
    const release = state.deployments.get(parts[4]);
    if (!release) return send(response, 404, { code: "NOT_FOUND", message: "Deployment not found" });
    if (parts.length === 5) return send(response, 200, deploymentRecord(release));
    if (parts[5] === "source" && !release.source) {
      return send(response, 404, { statusCode: 404, code: "RELEASE_SOURCE_UNAVAILABLE", message: "This release has no recorded source; download its artifact instead" });
    }
    const bytes = parts[5] === "source" ? release.source.bytes : release.artifact;
    response.writeHead(200, { "content-type": "application/gzip", "content-length": String(bytes.length) });
    return response.end(bytes);
  }
  return send(response, 404, { code: "NOT_FOUND", message: `unhandled ${request.method} ${url.pathname}` });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

async function runCli(argumentsList, { cwd = temporary, status = 0 } = {}) {
  const environment = { ...process.env };
  for (const key of ["INIT_CWD", "OPENCLOUD_API_URL", "OPENCLOUD_TOKEN", "OPENCLOUD_SESSION_FILE", "OPENCLOUD_WORKSPACE_FILE", "OPENCLOUD_TELEMETRY", "DO_NOT_TRACK"]) {
    delete environment[key];
  }
  environment.OPENCLOUD_MUTATION_JOURNAL_DIR = path.join(temporary, "journal");
  const child = spawn(binary, ["--api-url", `http://127.0.0.1:${server.address().port}`, "--token", "synthetic-release-source", ...argumentsList], {
    cwd, env: environment, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(exit, status, `${argumentsList.join(" ")}\n${stderr}`);
  return { stdout, stderr };
}

async function writeTree(directory, files) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), content);
  }
}

const manifest = `schemaVersion: 3\nappId: ${appId}\nfrontend:\n  directory: frontend/dist\n  spa: true\nruntime:\n  sdk:\n    version: 2.3.0\n`;
const app = path.join(temporary, "app");
await writeTree(app, {
  "opencloud.yaml": manifest,
  ".gitignore": "frontend/dist/\n",
  "package.json": "{\"name\":\"planner\"}\n",
  "frontend/src/main.ts": "console.log('planner');\n",
  "frontend/dist/index.html": "<!doctype html><title>Planner</title>\n",
  "sales-2026.csv": "client,amount\nsynthetic,1\n",
  ".env": "SECRET=never-uploaded\n",
  "node_modules/left-pad/index.js": "module.exports = 1;\n",
});
const lastDraft = () => [...state.drafts.values()].at(-1);
const deployRequest = () => state.requests.filter((value) => value.path.endsWith("/deploy")).at(-1);

try {
  const validated = JSON.parse((await runCli(["validate", app])).stdout);
  state.localDigest = validated.artifactSha256;
  assert.match(state.localDigest, /^[a-f0-9]{64}$/);

  // 1. A first deploy uploads the whole working tree, sends no base, and records one.
  //    It names the files that travel only with the source, which admins can download.
  await externalRelease({ "opencloud.json": "{}" });
  const first = await runCli(["deploy", app]);
  assert.deepEqual([...lastDraft().files.keys()].sort(), [
    ".gitignore", "frontend/dist/index.html", "frontend/src/main.ts", "opencloud.yaml", "package.json", "sales-2026.csv",
  ]);
  assert.match(first.stderr, /^Also kept with the app's source, which its admins can download \(not part of the app\): \.gitignore, package\.json, sales-2026\.csv, frontend\/src\/main\.ts\. Add files you want to keep private to \.gitignore\.$/m);
  const deployed = JSON.parse(first.stdout);
  assert.equal(deployed.operation.state, "succeeded");
  assert.deepEqual(
    { files: deployed.sourceOnlyFiles, count: deployed.sourceOnlyFileCount },
    { files: [".gitignore", "package.json", "sales-2026.csv", "frontend/src/main.ts"], count: 4 },
  );
  assert.equal(deployRequest().query, "");
  const base = JSON.parse(await readFile(path.join(app, ".opencloud", "base.json"), "utf8"));
  assert.equal(base.deploymentId, state.activeDeploymentId);
  assert.equal(base.files["frontend/src/main.ts"], sha256(Buffer.from("console.log('planner');\n")));
  assert.equal((await stat(path.join(app, ".opencloud", "base.json"))).mode & 0o777, 0o600);

  // 2. The next deploy names that base, and succeeds while it is still the latest.
  await writeFile(path.join(app, "frontend/src/main.ts"), "console.log('planner v2');\n");
  await runCli(["deploy", app]);
  assert.equal(deployRequest().query, `?expectedActiveDeploymentId=${base.deploymentId}`);

  // 3. Someone else releases: a stale deploy is refused with the newer release named.
  const newer = await externalRelease({ "opencloud.json": "{}", "frontend/src/main.ts": "console.log('theirs');\n" });
  await writeFile(path.join(app, "frontend/src/main.ts"), "console.log('planner v3');\n");
  const refused = await runCli(["deploy", app], { status: 1 });
  const error = JSON.parse(refused.stderr.trim().split("\n").at(-1)).error;
  assert.equal(error.code, "ACTIVE_DEPLOYMENT_CHANGED");
  assert.equal(error.latestDeploymentId, newer);
  const newerVersion = state.deployments.get(newer).version;
  assert.equal(error.hint, `Release ${newerVersion} (${newer}) replaced the one this copy is based on. Run \`opencloud pull ${app}\` to bring it in (if your edits would be overwritten, merge them by hand and run \`opencloud pull ${app} --deployment ${newer} --merged\`), then deploy again; or deploy with --force to replace it.`);
  assert.equal(state.activeDeploymentId, newer);

  // 4. --force replaces the newer release deliberately.
  await runCli(["deploy", app, "--force"]);
  assert.equal(deployRequest().query, "");
  assert.notEqual(state.activeDeploymentId, newer);

  // 4b. After a rollback, the release this copy is based on is rolled_back:
  //     the hint names the exact command that records the live one as its
  //     base, and following it lets the copy deploy again.
  const forced = state.activeDeploymentId;
  state.deployments.get(forced).rolledBack = true;
  state.activeDeploymentId = newer;
  await writeFile(path.join(app, "frontend/src/main.ts"), "console.log('planner v3b');\n");
  const afterRollback = JSON.parse((await runCli(["deploy", app], { status: 1 })).stderr.trim().split("\n").at(-1)).error;
  assert.equal(afterRollback.code, "ACTIVE_DEPLOYMENT_CHANGED");
  assert.equal(afterRollback.hint, `The release this copy is based on was rolled back, and release ${newerVersion} (${newer}) is live. To deploy this copy over it, run \`opencloud pull ${app} --deployment ${newer} --merged\` (it records that release as this copy's base and changes no files), then deploy again; or deploy with --force.`);
  await runCli(["pull", app, "--deployment", newer, "--merged"]);
  await runCli(["deploy", app]);
  assert.equal(deployRequest().query, `?expectedActiveDeploymentId=${newer}`);
  assert.notEqual(state.activeDeploymentId, newer);

  // 5. When the server resolves the author manifest differently, the CLI keeps
  //    the source but sends the canonical manifest instead.
  state.validationDigests = ["f".repeat(64)];
  await writeFile(path.join(app, "frontend/src/main.ts"), "console.log('planner v4');\n");
  const fallback = await runCli(["deploy", app]);
  assert.match(fallback.stderr, /storing the canonical opencloud\.json/);
  assert.ok(lastDraft().files.has("opencloud.json"));
  assert.ok(!lastDraft().files.has("opencloud.yaml"));
  assert.ok(lastDraft().files.has("frontend/src/main.ts"));

  // 6. An API without release source receives only the bundle, with no base.
  state.contracts = { cliMutationJournal: 1 };
  await writeFile(path.join(app, "frontend/src/main.ts"), "console.log('planner v5');\n");
  const bundleOnly = await runCli(["deploy", app]);
  assert.deepEqual([...lastDraft().files.keys()].sort(), ["frontend/dist/index.html", "opencloud.json"]);
  assert.equal(deployRequest().query, "");
  assert.doesNotMatch(bundleOnly.stderr, /Also kept with the app's source/);
  assert.equal("sourceOnlyFiles" in JSON.parse(bundleOnly.stdout), false);
  state.contracts = { cliMutationJournal: 1, releaseSource: 1, deployPreconditions: 1, platformBuilds: 1, pinnedDraftValidation: 1 };

  // 7. pull writes a release into an empty directory and records its base.
  const live = await externalRelease({ "opencloud.yaml": manifest, "frontend/src/main.ts": "console.log('live');\n" });
  const copy = path.join(temporary, "copy");
  const pulled = JSON.parse((await runCli(["pull", copy, "--app", appId])).stdout);
  assert.deepEqual({ kind: pulled.kind, deploymentId: pulled.deploymentId, written: pulled.written }, { kind: "source", deploymentId: live, written: 2 });
  assert.equal(await readFile(path.join(copy, "frontend/src/main.ts"), "utf8"), "console.log('live');\n");
  assert.equal(JSON.parse(await readFile(path.join(copy, ".opencloud", "base.json"), "utf8")).deploymentId, live);

  // 8. An untouched copy fast-forwards, removing what the release dropped.
  await externalRelease({ "opencloud.yaml": manifest, "frontend/src/app.ts": "export {};\n" });
  const forwarded = JSON.parse((await runCli(["pull", copy])).stdout);
  assert.equal(forwarded.removed, 1);
  await assert.rejects(stat(path.join(copy, "frontend/src/main.ts")));

  // 9. A local edit the next release would overwrite is refused.
  await writeFile(path.join(copy, "frontend/src/app.ts"), "export const mine = 1;\n");
  await externalRelease({ "opencloud.yaml": manifest, "frontend/src/app.ts": "export const theirs = 1;\n" });
  const conflict = await runCli(["pull", copy], { status: 1 });
  assert.equal(JSON.parse(conflict.stderr.trim().split("\n").at(-1)).error.code, "LOCAL_CHANGES");
  assert.equal(await readFile(path.join(copy, "frontend/src/app.ts"), "utf8"), "export const mine = 1;\n");

  // 9b. After merging that release by hand, --merged records it as the base
  //     and keeps every file; it needs the exact release.
  const merged = "export const mine = 1;\nexport const theirs = 1;\n";
  await writeFile(path.join(copy, "frontend/src/app.ts"), merged);
  const unnamed = await runCli(["pull", copy, "--merged"], { status: 1 });
  assert.equal(JSON.parse(unnamed.stderr.trim().split("\n").at(-1)).error.code, "DEPLOYMENT_REQUIRED");
  const recorded = JSON.parse((await runCli(["pull", copy, "--deployment", state.activeDeploymentId, "--merged"])).stdout);
  assert.deepEqual({ merged: recorded.merged, written: recorded.written, removed: recorded.removed, differing: recorded.differing },
    { merged: true, written: 0, removed: 0, differing: 1 });
  assert.equal(await readFile(path.join(copy, "frontend/src/app.ts"), "utf8"), merged);
  assert.equal(JSON.parse(await readFile(path.join(copy, ".opencloud", "base.json"), "utf8")).deploymentId, state.activeDeploymentId);

  // 10. A release without source falls back to its artifact, with a warning.
  await externalRelease({ "opencloud.json": "{\"canonical\":true}" }, { withSource: false });
  const artifactCopy = path.join(temporary, "artifact-copy");
  const artifact = JSON.parse((await runCli(["pull", artifactCopy, "--app", appId])).stdout);
  assert.equal(artifact.kind, "artifact");
  assert.match(artifact.warning, /no recorded source/);
  assert.equal(await readFile(path.join(artifactCopy, "opencloud.json"), "utf8"), "{\"canonical\":true}");

  // 11. A frontend OpenCloud builds: local validation needs no build output,
  //     the upload leaves any local build out, and the server's artifact is the release.
  const built = path.join(temporary, "built");
  await writeTree(built, {
    "opencloud.yaml": manifest.replace("  spa: true\n", "  spa: true\n  build:\n    script: build\n"),
    "package.json": "{\"name\":\"planner\",\"scripts\":{\"build\":\"vite build\"}}\n",
    "package-lock.json": "{\"lockfileVersion\":3}\n",
    "frontend/src/main.ts": "console.log('built');\n",
  });
  const local = JSON.parse((await runCli(["validate", built])).stdout);
  assert.ok(local.warnings.some((warning) => warning.code === "FRONTEND_BUILT_BY_PLATFORM"));
  assert.ok(!local.files.some((name) => name.startsWith("frontend/dist/")));
  await writeTree(built, { "frontend/dist/index.html": "<!doctype html><title>stale local build</title>\n" });
  state.localDigest = local.artifactSha256;
  const serverBuilt = "b".repeat(64);
  state.validationDigests = [serverBuilt];
  const builtDeploy = await runCli(["deploy", built]);
  assert.deepEqual([...lastDraft().files.keys()].sort(), [
    "frontend/src/main.ts", "opencloud.yaml", "package-lock.json", "package.json",
  ]);
  assert.doesNotMatch(builtDeploy.stderr, /canonical opencloud\.json/);
  // The build can read any uploaded file, so the note does not call them unused.
  assert.match(builtDeploy.stderr, /\(not part of the app unless its frontend build uses them\): package-lock\.json, package\.json, frontend\/src\/main\.ts\./);
  assert.equal(state.deployments.get(state.activeDeploymentId).artifactSha256, serverBuilt);
  const builtBase = JSON.parse(await readFile(path.join(built, ".opencloud", "base.json"), "utf8"));
  assert.equal(builtBase.deploymentId, state.activeDeploymentId);
  assert.equal(builtBase.artifactSha256, serverBuilt);

  // 12. While another build for the app runs, the CLI waits and validates again.
  state.validationBusy = 1;
  state.validationDigests = ["c".repeat(64)];
  await writeFile(path.join(built, "frontend/src/main.ts"), "console.log('built v2');\n");
  const waited = await runCli(["deploy", built]);
  assert.match(waited.stderr, /Validation is still running for draft .* revision \d+; waiting for its result/);
  assert.equal(state.deployments.get(state.activeDeploymentId).artifactSha256, "c".repeat(64));

  // 13. A failed build prints its diagnostics and deploys nothing.
  const before = state.activeDeploymentId;
  state.validationFailure = [{ level: "error", code: "FRONTEND_BUILD_FAILED", path: "package.json", message: "The frontend build failed. npm ERR! Missing script: \"build\"" }];
  await writeFile(path.join(built, "frontend/src/main.ts"), "console.log('built v3');\n");
  const failedBuild = await runCli(["deploy", built], { status: 1 });
  assert.match(failedBuild.stderr, /\[FRONTEND_BUILD_FAILED\] package\.json: The frontend build failed/);
  assert.equal(JSON.parse(failedBuild.stderr.trim().split("\n").at(-1)).error.code, "DRAFT_VALIDATION_FAILED");
  assert.equal(state.activeDeploymentId, before);
  state.validationFailure = null;
  // The fixed source deploys straight away; the failed attempt does not block it.
  await writeFile(path.join(built, "frontend/src/main.ts"), "console.log('built v4');\n");
  state.validationDigests = ["d".repeat(64)];
  await runCli(["deploy", built]);
  assert.equal(state.deployments.get(state.activeDeploymentId).artifactSha256, "d".repeat(64));

  // 14. A server from before pinned validation (2.35.x) gets 3.20's requests:
  //     no revision, a frontend build's request held past 30 seconds instead
  //     of being abandoned, and FRONTEND_BUILD_BUSY validated again on the same
  //     revision.
  state.contracts = { cliMutationJournal: 1, releaseSource: 1, deployPreconditions: 1, platformBuilds: 1 };
  state.legacyHoldMs = 31_000;
  state.legacyBuildBusy = 1;
  state.validationDigests = ["e".repeat(64)];
  await writeFile(path.join(built, "frontend/src/main.ts"), "console.log('built on 2.35');\n");
  const legacyAt = state.requests.length;
  const legacy = await runCli(["deploy", built]);
  assert.equal(state.requests.slice(legacyAt).filter((request) => request.path.endsWith("/validate")).length, 2);
  assert.match(legacy.stderr, /OpenCloud is still building this app's frontend .*validating the same revision again/);
  assert.equal(state.deployments.get(state.activeDeploymentId).artifactSha256, "e".repeat(64));

  // 15. A manifest with containers, on an installation that doesn't run them,
  //     is refused plainly before any draft; one that runs them, or a server
  //     too old to say, gets the manifest as before.
  const containerApp = path.join(temporary, "container-app");
  await writeTree(containerApp, {
    "opencloud.yaml": `schemaVersion: 3\nappId: ${appId}\nfrontend:\n  container: web\ncontainers:\n  - name: web\n    kind: service\n    image: registry.example/web:1\n    service:\n      startupProbe: { path: /ready }\n      readinessProbe: { path: /ready }\n`,
  });
  state.contracts = { cliMutationJournal: 1, releaseSource: 1, deployPreconditions: 1, platformBuilds: 1, pinnedDraftValidation: 1 };
  const draftsBeforeContainers = state.drafts.size;
  for (const installation of [
    { schemaVersion: 1, capabilities: { organisations: true } },
    { schemaVersion: 1, capabilities: { compute: { jobs: true, services: false, workers: true, containerFrontend: false } } },
  ]) {
    state.installation = installation;
    const refusedContainers = JSON.parse((await runCli(["deploy", containerApp], { status: 1 })).stderr.trim().split("\n").at(-1)).error;
    assert.equal(refusedContainers.code, "COMPUTE_NOT_OFFERED");
    assert.equal(refusedContainers.message, installation.capabilities.compute
      ? "This installation doesn't run container services or a container frontend. Remove them from opencloud.yaml to use this app here."
      : "This installation doesn't run containers. Remove the containers, and a container frontend, from opencloud.yaml to use this app here.");
  }
  assert.equal(state.drafts.size, draftsBeforeContainers, "a draft was created for a manifest the installation can't run");
  state.installation = { schemaVersion: 1, capabilities: { compute: { jobs: true, services: true, workers: true, containerFrontend: true } } };
  state.localDigest = JSON.parse((await runCli(["validate", containerApp])).stdout).artifactSha256;
  state.validationDigests = [];
  await runCli(["deploy", containerApp]);
  assert.equal(state.drafts.size, draftsBeforeContainers + 1);
  state.installation = null;

  // 16. An API that cannot build frontends refuses before creating a draft.
  state.contracts = { cliMutationJournal: 1, releaseSource: 1, deployPreconditions: 1 };
  const drafts = state.drafts.size;
  const unsupported = await runCli(["deploy", built], { status: 1 });
  assert.equal(JSON.parse(unsupported.stderr.trim().split("\n").at(-1)).error.code, "PLATFORM_BUILD_UNSUPPORTED");
  assert.equal(state.drafts.size, drafts);

  process.stdout.write("Release source HTTP contract passed: full-source upload and its source-only files, stale-release precondition and --force, canonical fallback, older APIs, base recording, pull and --merged, platform-built frontends, and 3.20's validation for a server without pinned validation.\n");
} finally {
  server.close();
  await rm(temporary, { recursive: true, force: true });
}
