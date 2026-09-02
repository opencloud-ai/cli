import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const binary = path.join(root, "dist", "index.cjs");
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "opencloud-mutation-recovery-contract-"),
);
const appId = "10000000-0000-4000-8000-000000000001";
const draftId = "10000000-0000-4000-8000-000000000002";
const sessionId = "10000000-0000-4000-8000-000000000003";
const revisionId = "10000000-0000-4000-8000-000000000004";
const nextRevisionId = "10000000-0000-4000-8000-00000000000b";
const deploymentId = "10000000-0000-4000-8000-000000000005";
const otherDeploymentId = "10000000-0000-4000-8000-00000000000c";
const promotionOperationId = "10000000-0000-4000-8000-000000000006";
const verificationId = "10000000-0000-4000-8000-000000000007";
const verificationOperationId = "10000000-0000-4000-8000-000000000008";
const actorId = "10000000-0000-4000-8000-000000000009";
const applyDraftId = "10000000-0000-4000-8000-00000000000a";
const devReceiptId = "10000000-0000-4000-8000-00000000000d";
const createdAppId = "10000000-0000-4000-8000-00000000000e";
const createOperationId = "10000000-0000-4000-8000-00000000000f";
const replacementSessionId = "30000000-0000-4000-8000-000000000001";
const replacementDraftId = "30000000-0000-4000-8000-000000000002";
const now = "2026-09-02T12:00:00.000Z";
const requests = [];
const replayBodies = new Map();
let advertiseJournal = true;
let failConfigureResponse = false;
let failAccessResponse = false;
let failDraftApplyResponse = false;
let failVerificationResponse = false;
let failPromotionResponse = false;
let failPlainStopResponse = false;
let artifactSha256 = "a".repeat(64);
let applyRevision = 3;
let appliedFileSha256 = null;
let activeDeploymentId = deploymentId;
let finalVerificationDeploymentId = deploymentId;
let changeActiveAfterAppRead = false;
let swapDevStateOnStop = null;
let swapDevStateOnPlainStop = null;
let corruptDevStateOnStop = null;
let swapDevStateOnVersion = null;
let failAlertDeleteResponse = false;
let alertRulePresent = true;
let alertDeleteEffects = 0;
let failCreateResponse = false;
let appCreateEffects = 0;
const appCreateReplays = new Map();
let activeDevRevisionId = revisionId;
let activeDevSessionStatus = "active";
let devVerificationBehavior = "pass";
let devVerificationReceipts = [];

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function operation(id, type, deployment = null) {
  return {
    id,
    appId,
    deploymentId: deployment,
    type,
    state: "succeeded",
    actorType: "agent_app_owner",
    actorId,
    idempotencyKey: "server-redacted",
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

function deployment() {
  return {
    id: deploymentId,
    appId,
    version: "candidate",
    artifactSha256,
    sdkVersion: "2.2.0",
    manifest: {},
    state: "active",
    rollbackOfDeploymentId: null,
    error: null,
    createdAt: now,
    activatedAt: now,
  };
}

function draft() {
  return {
    id: draftId,
    appId,
    baseDeploymentId: null,
    name: "Dev candidate",
    status: "deployed",
    revision: 2,
    createdAt: now,
    updatedAt: now,
    deployedAt: now,
  };
}

function verification(
  state = "passed",
  verificationDeploymentId = finalVerificationDeploymentId,
) {
  return {
    id: verificationId,
    appId,
    deploymentId: verificationDeploymentId,
    operationId: verificationOperationId,
    state,
    phases: [],
    diagnostics: [],
    startedAt: now,
    finishedAt: state === "passed" ? now : null,
    createdAt: now,
  };
}

function devSession(status = "stopped") {
  return {
    id: sessionId,
    appId,
    draftId,
    status,
    previewUrl: "https://preview.example.test",
    browserPreviewUrl: "https://review.example.test",
    baseDeploymentId: null,
    activeRevision: {
      id: activeDevRevisionId,
      draftRevision: 2,
      artifactSha256,
      migrationDigest: "b".repeat(64),
    },
    verification: null,
    capabilities: {
      frontend: true,
      database: true,
      functions: true,
      jobs: true,
      files: true,
      productionSecrets: false,
      cron: false,
      syntheticAuth: true,
      emailCapture: true,
      emailInboundInjection: true,
      notificationCapture: true,
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    expiresAt: "2026-09-03T12:00:00.000Z",
  };
}

function devReceipt(passed, id = devReceiptId) {
  return {
    id,
    sessionId,
    revisionId: activeDevRevisionId,
    artifactSha256,
    engineVersion: "contract-1",
    summary: { passed },
    createdAt: now,
    expiresAt: "2026-09-03T12:00:00.000Z",
  };
}

function createdApp() {
  return {
    id: createdAppId,
    name: "Created once",
    slug: "created-once",
    appUrl: "https://created-once.example.test",
    authUrl: "https://auth.example.test",
    apiUrl: "https://api.example.test",
    visibility: "private",
    state: "active",
    ownerUserId: actorId,
    desiredDeploymentId: null,
    activeDeploymentId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function send(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const server = createServer(async (request, response) => {
  const body = await bodyOf(request);
  const record = {
    method: request.method,
    url: request.url,
    key: request.headers["idempotency-key"],
    body: body.toString("utf8"),
  };
  requests.push(record);
  if (request.url === "/version") {
    if (swapDevStateOnVersion) {
      await writeFile(
        swapDevStateOnVersion.file,
        `${JSON.stringify(swapDevStateOnVersion.state, null, 2)}\n`,
        { mode: 0o600 },
      );
      swapDevStateOnVersion = null;
    }
    const version = {
      version: "3.7.0",
      commit: "contract-test",
      builtAt: now,
      releaseId: "platform-v3.7.0-contract-test",
    };
    send(
      response,
      200,
      advertiseJournal
        ? { ...version, contracts: { cliMutationJournal: 1 } }
        : { ...version, contracts: {} },
    );
    return;
  }
  if (request.method === "POST" && request.url === "/v1/apps") {
    const retained = appCreateReplays.get(record.key);
    if (retained && retained.body !== record.body) {
      send(response, 409, { message: "idempotency request mismatch" });
      return;
    }
    const payload =
      retained?.payload ??
      {
        app: createdApp(),
        operation: operation(createOperationId, "create_app"),
      };
    if (!retained) {
      appCreateEffects += 1;
      appCreateReplays.set(record.key, { body: record.body, payload });
    }
    if (failCreateResponse) {
      failCreateResponse = false;
      request.socket.destroy();
      return;
    }
    send(response, 200, payload);
    return;
  }
  if (request.method === "PATCH" && request.url === `/v1/apps/${appId}`) {
    const coordinate = `${request.url}\0${record.key}`;
    const retained = replayBodies.get(coordinate);
    if (retained !== undefined && retained !== record.body) {
      send(response, 409, { message: "idempotency request mismatch" });
      return;
    }
    replayBodies.set(coordinate, record.body);
    if (failConfigureResponse) {
      failConfigureResponse = false;
      request.socket.destroy();
      return;
    }
    send(response, 200, {
      app: { id: appId },
      operation: operation(promotionOperationId, "configure"),
    });
    return;
  }
  if (request.method === "POST" && request.url === `/v1/apps/${appId}/access`) {
    const coordinate = `${request.url}\0${record.key}`;
    const retained = replayBodies.get(coordinate);
    if (retained !== undefined && retained !== record.body) {
      send(response, 409, { message: "idempotency request mismatch" });
      return;
    }
    replayBodies.set(coordinate, record.body);
    if (failAccessResponse) {
      failAccessResponse = false;
      request.socket.destroy();
      return;
    }
    send(response, 200, {
      operation: operation(promotionOperationId, "add_app_member"),
    });
    return;
  }
  if (
    request.method === "PATCH" &&
    request.url === `/v1/apps/${appId}/drafts/${applyDraftId}/files`
  ) {
    const parsed = JSON.parse(record.body);
    const content = Buffer.from(parsed.changes[0].content, "utf8");
    appliedFileSha256 = createHash("sha256").update(content).digest("hex");
    applyRevision = 4;
    if (failDraftApplyResponse) {
      failDraftApplyResponse = false;
      request.socket.destroy();
      return;
    }
    send(response, 200, {
      draft: { ...draft(), id: applyDraftId, status: "open", revision: 4 },
      files: [],
    });
    return;
  }
  if (
    request.method === "GET" &&
    request.url === `/v1/apps/${appId}/drafts/${applyDraftId}`
  ) {
    send(response, 200, {
      ...draft(),
      id: applyDraftId,
      status: "open",
      revision: applyRevision,
      deployedAt: null,
    });
    return;
  }
  if (
    request.method === "GET" &&
    request.url === `/v1/apps/${appId}/drafts/${applyDraftId}/files`
  ) {
    send(
      response,
      200,
      appliedFileSha256
        ? [
            {
              path: "frontend/index.html",
              sha256: appliedFileSha256,
              baseSha256: null,
              sizeBytes: 9,
              deleted: false,
              updatedAt: now,
            },
          ]
        : [],
    );
    return;
  }
  if (
    request.method === "POST" &&
    request.url === `/v1/apps/${appId}/dev-sessions/${sessionId}/promote`
  ) {
    if (failPromotionResponse) {
      failPromotionResponse = false;
      request.socket.destroy();
      return;
    }
    send(response, 200, {
      draft: draft(),
      deployment: deployment(),
      operation: operation(
        promotionOperationId,
        "promote_dev_revision",
        deploymentId,
      ),
    });
    return;
  }
  if (
    request.method === "POST" &&
    request.url === `/v1/apps/${appId}/verifications`
  ) {
    const payload = {
      verification: verification("queued", deploymentId),
      operation: operation(
        verificationOperationId,
        "verify_app",
        deploymentId,
      ),
    };
    if (failVerificationResponse) {
      failVerificationResponse = false;
      request.socket.destroy();
      return;
    }
    send(response, 200, payload);
    return;
  }
  if (request.url === `/v1/operations/${promotionOperationId}`) {
    send(
      response,
      200,
      operation(promotionOperationId, "promote_dev_revision", deploymentId),
    );
    return;
  }
  if (request.url === `/v1/operations/${verificationOperationId}`) {
    send(
      response,
      200,
      operation(verificationOperationId, "verify_app", deploymentId),
    );
    return;
  }
  if (
    request.method === "GET" &&
    request.url === `/v1/apps/${appId}/verifications/${verificationId}`
  ) {
    send(response, 200, verification());
    return;
  }
  if (request.method === "GET" && request.url === `/v1/apps/${appId}`) {
    const reportedActiveDeploymentId = activeDeploymentId;
    send(response, 200, {
      id: appId,
      name: "Recovery app",
      slug: "recovery-app",
      appUrl: "https://recovery-app.example.test",
      authUrl: "https://auth.example.test",
      apiUrl: "https://api.example.test",
      visibility: "private",
      state: "active",
      ownerUserId: actorId,
      desiredDeploymentId: deploymentId,
      activeDeploymentId: reportedActiveDeploymentId,
      createdAt: now,
      updatedAt: now,
    });
    if (changeActiveAfterAppRead) {
      activeDeploymentId = otherDeploymentId;
      changeActiveAfterAppRead = false;
    }
    return;
  }
  if (
    request.method === "GET" &&
    request.url === `/v1/apps/${appId}/dev-receipts?limit=200`
  ) {
    send(response, 200, devVerificationReceipts);
    return;
  }
  if (
    request.method === "POST" &&
    request.url === `/v1/apps/${appId}/dev-sessions/${sessionId}/verify`
  ) {
    const passed = !devVerificationBehavior.includes("fail");
    const receipt = devReceipt(passed);
    if (devVerificationBehavior.startsWith("lost")) {
      devVerificationReceipts = [receipt];
      request.socket.destroy();
      return;
    }
    send(response, 200, {
      session: devSession(passed ? "verified" : "active"),
      receipt: {
        id: receipt.id,
        revisionId: receipt.revisionId,
        artifactSha256: receipt.artifactSha256,
        expiresAt: receipt.expiresAt,
        summary: receipt.summary,
      },
    });
    return;
  }
  if (
    request.method === "DELETE" &&
    (request.url === `/v1/apps/${appId}/dev-sessions/${sessionId}` ||
      request.url ===
        `/v1/apps/${appId}/dev-sessions/${replacementSessionId}`)
  ) {
    const stoppedSessionId = request.url.endsWith(replacementSessionId)
      ? replacementSessionId
      : sessionId;
    if (swapDevStateOnPlainStop) {
      await writeFile(
        swapDevStateOnPlainStop.file,
        `${JSON.stringify(swapDevStateOnPlainStop.state, null, 2)}\n`,
        { mode: 0o600 },
      );
      swapDevStateOnPlainStop = null;
    }
    if (stoppedSessionId === sessionId) activeDevSessionStatus = "stopped";
    if (failPlainStopResponse) {
      failPlainStopResponse = false;
      request.socket.destroy();
      return;
    }
    send(response, 200, {
      ...devSession(),
      id: stoppedSessionId,
      status: "stopped",
    });
    return;
  }
  if (
    request.method === "DELETE" &&
    request.url?.startsWith(`/v1/apps/${appId}/dev-sessions/${sessionId}?`)
  ) {
    const parsedUrl = new URL(request.url, "http://localhost");
    const expected = parsedUrl.searchParams.get("expectedActiveDeploymentId");
    if (expected !== activeDeploymentId) {
      send(response, 409, {
        code: "ACTIVE_DEPLOYMENT_CHANGED",
        message:
          "Production changed after verification; the development session was retained",
        details: {
          expectedActiveDeploymentId: expected,
          actualActiveDeploymentId: activeDeploymentId,
        },
      });
      return;
    }
    if (corruptDevStateOnStop) {
      await writeFile(corruptDevStateOnStop, "{\n", { mode: 0o600 });
      corruptDevStateOnStop = null;
    } else if (swapDevStateOnStop) {
      await writeFile(
        swapDevStateOnStop.file,
        `${JSON.stringify(swapDevStateOnStop.state, null, 2)}\n`,
        { mode: 0o600 },
      );
      swapDevStateOnStop = null;
    }
    send(response, 200, devSession());
    return;
  }
  if (
    request.method === "GET" &&
    request.url === `/v1/apps/${appId}/dev-sessions/${sessionId}`
  ) {
    send(response, 200, devSession(activeDevSessionStatus));
    return;
  }
  if (
    request.method === "GET" &&
    request.url === `/v1/apps/${appId}/dev-sessions/${replacementSessionId}`
  ) {
    send(response, 200, {
      ...devSession("active"),
      id: replacementSessionId,
      draftId: replacementDraftId,
    });
    return;
  }
  if (
    request.method === "DELETE" &&
    request.url === `/v1/apps/${appId}/alert-rules/contract-rule`
  ) {
    if (alertRulePresent) {
      alertRulePresent = false;
      alertDeleteEffects += 1;
      if (failAlertDeleteResponse) {
        failAlertDeleteResponse = false;
        request.socket.destroy();
        return;
      }
      send(response, 200, { id: "contract-rule", deleted: true });
      return;
    }
    send(response, 404, {
      code: "ALERT_RULE_NOT_FOUND",
      message: "Alert rule does not exist",
    });
    return;
  }
  send(response, 404, { message: `Unhandled ${request.method} ${request.url}` });
});

async function runCli(arguments_, options = {}) {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const environment = { ...process.env };
  for (const key of [
    "INIT_CWD",
    "OPENCLOUD_API_URL",
    "OPENCLOUD_TOKEN",
    "OPENCLOUD_SESSION_FILE",
    "OPENCLOUD_WORKSPACE_FILE",
    "OPENCLOUD_MUTATION_JOURNAL_DIR",
  ]) {
    delete environment[key];
  }
  environment.OPENCLOUD_MUTATION_JOURNAL_DIR =
    options.journal ?? path.join(temporary, "journal-default");
  if (options.sessionFile) {
    environment.OPENCLOUD_SESSION_FILE = options.sessionFile;
  }
  const authorityArguments =
    options.withToken === false
      ? []
      : ["--token", options.token ?? "synthetic-authority"];
  const child = spawn(
    binary,
    [
      "--api-url",
      `http://127.0.0.1:${address.port}`,
      ...authorityArguments,
      ...arguments_,
    ],
    {
      cwd: options.cwd ?? temporary,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (options.status !== undefined) {
    assert.equal(status, options.status, `${arguments_.join(" ")}\n${stderr}`);
  } else {
    assert.equal(status, 0, `${arguments_.join(" ")}\n${stderr}`);
  }
  return { stdout, stderr };
}

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

async function writeDevState(sourceRoot, overrides = {}) {
  await mkdir(path.join(sourceRoot, ".opencloud"), { recursive: true });
  await writeFile(
    path.join(sourceRoot, ".opencloud", "dev.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        appId,
        draftId,
        sessionId,
        artifactSha256,
        updatedAt: now,
        ...overrides,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

async function prepareDevSource(name, journal) {
  const sourceRoot = path.join(temporary, name);
  await runCli(["init", sourceRoot, "--app-id", appId], { journal });
  const validated = await runCli(["validate", sourceRoot], { journal });
  artifactSha256 = JSON.parse(validated.stdout).artifactSha256;
  await writeDevState(sourceRoot);
  return sourceRoot;
}

try {
  advertiseJournal = false;
  const beforeCompatibility = requests.length;
  const unsupported = await runCli(
    [
      "app",
      "restart",
      appId,
      "--no-follow",
      "--idempotency-key",
      "compatibility-check-key",
    ],
    {
      journal: path.join(temporary, "journal-compatibility"),
      status: 1,
    },
  );
  const unsupportedError = JSON.parse(unsupported.stderr);
  assert.equal(
    unsupportedError.error.code,
    "CLI_MUTATION_JOURNAL_UNSUPPORTED",
  );
  assert.deepEqual(
    requests.slice(beforeCompatibility).map((request) => request.url),
    ["/version"],
  );

  advertiseJournal = true;
  await runCli(
    [
      "app",
      "configure",
      appId,
      "--name",
      "Marker enabled",
      "--no-follow",
      "--idempotency-key",
      "marker-enabled-key",
    ],
    { journal: path.join(temporary, "journal-marker-enabled") },
  );
  advertiseJournal = false;
  const effectsBeforeWithdrawal = requests.filter(
    (request) => request.method === "PATCH" && request.url === `/v1/apps/${appId}`,
  ).length;
  const requestsBeforeWithdrawal = requests.length;
  const withdrawn = await runCli(
    [
      "app",
      "configure",
      appId,
      "--name",
      "Marker withdrawn",
      "--no-follow",
      "--idempotency-key",
      "marker-withdrawn-key",
    ],
    {
      journal: path.join(temporary, "journal-marker-withdrawn"),
      status: 1,
    },
  );
  assert.equal(
    JSON.parse(withdrawn.stderr).error.code,
    "CLI_MUTATION_JOURNAL_UNSUPPORTED",
  );
  assert.deepEqual(
    requests.slice(requestsBeforeWithdrawal).map((request) => request.url),
    ["/version"],
  );
  assert.equal(
    requests.filter(
      (request) =>
        request.method === "PATCH" && request.url === `/v1/apps/${appId}`,
    ).length,
    effectsBeforeWithdrawal,
  );
  advertiseJournal = true;

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const ownerSessionFile = path.join(temporary, "owner-session.json");
  await writeFile(
    ownerSessionFile,
    `${JSON.stringify({
      schemaVersion: 2,
      state: "ready",
      apiUrl: `http://127.0.0.1:${address.port}`,
      appId,
      token: "owner-session-authority",
      credentialExpiresAt: "2026-09-03T12:00:00.000Z",
      authorityMode: "app_owner_v1",
      rootRunId: "20000000-0000-4000-8000-000000000001",
      familyId: "20000000-0000-4000-8000-000000000002",
    })}\n`,
    { mode: 0o600 },
  );
  const beforeAuthorityConflict = requests.length;
  const authorityConflict = await runCli(
    [
      "app",
      "restart",
      appId,
      "--no-follow",
      "--idempotency-key",
      "authority-conflict-key",
    ],
    {
      journal: path.join(temporary, "journal-authority-conflict"),
      sessionFile: ownerSessionFile,
      token: "competing-explicit-authority",
      status: 1,
    },
  );
  assert.equal(
    JSON.parse(authorityConflict.stderr).error.code,
    "MUTATION_AUTHORITY_SOURCE_CONFLICT",
  );
  assert.equal(requests.length, beforeAuthorityConflict);

  const alternateOwnerJournal = path.join(
    temporary,
    "alternate-app-owner-journal",
  );
  const beforeOwnerPathMismatch = requests.length;
  const ownerPathMismatch = await runCli(
    [
      "app",
      "restart",
      appId,
      "--no-follow",
      "--idempotency-key",
      "owner-path-mismatch-key",
    ],
    {
      journal: alternateOwnerJournal,
      sessionFile: ownerSessionFile,
      withToken: false,
      status: 1,
    },
  );
  assert.equal(
    JSON.parse(ownerPathMismatch.stderr).error.code,
    "INVALID_APP_OWNER_MUTATION_JOURNAL_DIRECTORY",
  );
  assert.equal(requests.length, beforeOwnerPathMismatch);
  await assert.rejects(readFile(path.join(alternateOwnerJournal, "binding.json")), {
    code: "ENOENT",
  });

  const beforeMissingCreateKey = requests.length;
  await runCli(["app", "create", "--name", "No key"], { status: 1 });
  assert.equal(requests.length, beforeMissingCreateKey);
  failCreateResponse = true;
  const createArguments = [
    "app",
    "create",
    "--name",
    "Created once",
    "--idempotency-key",
    "create-recovery-key",
  ];
  await runCli(createArguments, { status: 1 });
  const created = await runCli(createArguments);
  assert.equal(JSON.parse(created.stdout).app.id, createdAppId);
  const createRequests = requests.filter(
    (request) => request.method === "POST" && request.url === "/v1/apps",
  );
  assert.equal(createRequests.length, 2);
  assert.equal(createRequests[0].key, createRequests[1].key);
  assert.equal(appCreateEffects, 1);

  failConfigureResponse = true;
  const configureJournal = path.join(temporary, "journal-configure");
  await runCli(
    [
      "app",
      "configure",
      appId,
      "--name",
      "First intent",
      "--no-follow",
      "--idempotency-key",
      "configure-recovery-key",
    ],
    { journal: configureJournal, status: 1 },
  );
  const changed = await runCli(
    [
      "app",
      "configure",
      appId,
      "--name",
      "Changed intent",
      "--no-follow",
      "--idempotency-key",
      "configure-recovery-key",
    ],
    { journal: configureJournal, status: 1 },
  );
  assert.match(changed.stderr, /idempotency request mismatch/);
  const configureRequests = requests.filter(
    (request) =>
      request.method === "PATCH" &&
      request.url === `/v1/apps/${appId}` &&
      request.key === "configure-recovery-key",
  );
  assert.equal(configureRequests.length, 2);
  assert.equal(configureRequests[0].key, configureRequests[1].key);

  failAccessResponse = true;
  const accessJournal = path.join(temporary, "journal-access");
  await runCli(
    [
      "app",
      "access",
      "add",
      appId,
      "--email",
      "first@example.test",
      "--role",
      "builder",
      "--no-follow",
      "--idempotency-key",
      "access-recovery-key",
    ],
    { journal: accessJournal, status: 1 },
  );
  const changedAccess = await runCli(
    [
      "app",
      "access",
      "add",
      appId,
      "--email",
      "changed@example.test",
      "--role",
      "app_user",
      "--no-follow",
      "--idempotency-key",
      "access-recovery-key",
    ],
    { journal: accessJournal, status: 1 },
  );
  assert.match(changedAccess.stderr, /idempotency request mismatch/);
  const accessRequests = requests.filter(
    (request) =>
      request.method === "POST" && request.url === `/v1/apps/${appId}/access`,
  );
  assert.equal(accessRequests.length, 2);
  assert.equal(accessRequests[0].key, accessRequests[1].key);

  const changesFile = path.join(temporary, "apply-changes.json");
  await writeFile(
    changesFile,
    JSON.stringify([{ path: "frontend/index.html", content: "recovered" }]),
  );
  const applyArguments = [
    "draft",
    "apply",
    appId,
    applyDraftId,
    "--expected-revision",
    "3",
    "--changes-file",
    changesFile,
    "--idempotency-key",
    "draft-apply-recovery-key",
  ];
  const applyJournal = path.join(temporary, "journal-draft-apply");
  failDraftApplyResponse = true;
  await runCli(applyArguments, { journal: applyJournal, status: 1 });
  const reconciledApply = await runCli(applyArguments, {
    journal: applyJournal,
  });
  assert.equal(JSON.parse(reconciledApply.stdout).draft.revision, 4);
  assert.equal(
    requests.filter(
      (request) =>
        request.method === "PATCH" &&
        request.url === `/v1/apps/${appId}/drafts/${applyDraftId}/files`,
    ).length,
    1,
  );

  failAlertDeleteResponse = true;
  alertRulePresent = true;
  alertDeleteEffects = 0;
  const alertJournal = path.join(temporary, "journal-alert-delete");
  const alertDeleteArguments = [
    "alert-rule",
    "delete",
    appId,
    "contract-rule",
    "--idempotency-key",
    "alert-delete-recovery-key",
  ];
  await runCli(alertDeleteArguments, { journal: alertJournal, status: 1 });
  const reconciledDelete = await runCli(alertDeleteArguments, {
    journal: alertJournal,
  });
  assert.deepEqual(JSON.parse(reconciledDelete.stdout), {
    id: "contract-rule",
    deleted: true,
    reconciled: true,
  });
  assert.equal(alertDeleteEffects, 1);

  const emptyStopJournal = path.join(temporary, "journal-empty-stop");
  const emptyStopRoot = await prepareDevSource(
    "empty-stop-app",
    emptyStopJournal,
  );
  await rm(path.join(emptyStopRoot, ".opencloud", "dev.json"));
  const stopArguments = [
    "app",
    "dev",
    "stop",
    emptyStopRoot,
    "--idempotency-key",
    "empty-stop-recovery-key",
  ];
  const deleteCountBeforeEmptyStop = requests.filter(
    (request) =>
      request.method === "DELETE" &&
      request.url?.includes(`/dev-sessions/${sessionId}`),
  ).length;
  await runCli(stopArguments, { journal: emptyStopJournal, status: 1 });
  await writeDevState(emptyStopRoot);
  await runCli(stopArguments, { journal: emptyStopJournal, status: 1 });
  assert.equal(
    requests.filter(
      (request) =>
        request.method === "DELETE" &&
        request.url?.includes(`/dev-sessions/${sessionId}`),
    ).length,
    deleteCountBeforeEmptyStop,
  );

  const racedStopJournal = path.join(temporary, "journal-raced-stop");
  const racedStopRoot = await prepareDevSource(
    "raced-stop-app",
    racedStopJournal,
  );
  const racedStopFile = path.join(
    racedStopRoot,
    ".opencloud",
    "dev.json",
  );
  swapDevStateOnPlainStop = {
    file: racedStopFile,
    state: {
      schemaVersion: 1,
      appId,
      draftId: replacementDraftId,
      sessionId: replacementSessionId,
      artifactSha256,
      updatedAt: now,
    },
  };
  const racedStop = await runCli(
    ["app", "dev", "stop", racedStopRoot],
    { journal: racedStopJournal },
  );
  assert.equal(JSON.parse(racedStop.stdout).localStateRemoved, false);
  assert.equal(
    JSON.parse(await readFile(racedStopFile, "utf8")).sessionId,
    replacementSessionId,
  );
  const replacementStop = await runCli(
    ["app", "dev", "stop", racedStopRoot],
    { journal: racedStopJournal },
  );
  assert.equal(JSON.parse(replacementStop.stdout).localStateRemoved, true);
  await assert.rejects(() => readFile(racedStopFile), { code: "ENOENT" });

  const directVerifyJournal = path.join(temporary, "journal-verify-direct");
  const directVerifyRoot = await prepareDevSource(
    "verify-direct-app",
    directVerifyJournal,
  );
  activeDevSessionStatus = "active";
  activeDevRevisionId = revisionId;
  devVerificationReceipts = [];
  devVerificationBehavior = "fail";
  const verifyArguments = [
    "app",
    "dev",
    "verify",
    directVerifyRoot,
    "--interval",
    "0.05",
    "--timeout",
    "2",
  ];
  const directFailure = await runCli(verifyArguments, {
    journal: directVerifyJournal,
    status: 1,
  });
  assert.equal(
    JSON.parse(directFailure.stderr).error.code,
    "DEV_VERIFICATION_FAILED",
  );
  activeDevRevisionId = nextRevisionId;
  devVerificationBehavior = "pass";
  const verifiedAfterDirectFailure = await runCli(verifyArguments, {
    journal: directVerifyJournal,
  });
  assert.equal(
    JSON.parse(verifiedAfterDirectFailure.stdout).receipt.summary.passed,
    true,
  );

  const receiptVerifyJournal = path.join(temporary, "journal-verify-receipt");
  const receiptVerifyRoot = await prepareDevSource(
    "verify-receipt-app",
    receiptVerifyJournal,
  );
  activeDevRevisionId = revisionId;
  devVerificationReceipts = [];
  devVerificationBehavior = "lost-fail";
  const receiptVerifyArguments = [
    "app",
    "dev",
    "verify",
    receiptVerifyRoot,
    "--interval",
    "0.05",
    "--timeout",
    "2",
  ];
  const verifyPostsBeforeLostReceipt = requests.filter(
    (request) => request.url?.endsWith(`/dev-sessions/${sessionId}/verify`),
  ).length;
  await runCli(receiptVerifyArguments, {
    journal: receiptVerifyJournal,
    status: 1,
  });
  const reconciledFailedReceipt = await runCli(receiptVerifyArguments, {
    journal: receiptVerifyJournal,
    status: 1,
  });
  assert.equal(
    JSON.parse(reconciledFailedReceipt.stderr).error.code,
    "DEV_VERIFICATION_FAILED",
  );
  assert.equal(
    requests.filter((request) =>
      request.url?.endsWith(`/dev-sessions/${sessionId}/verify`),
    ).length,
    verifyPostsBeforeLostReceipt + 1,
  );
  activeDevRevisionId = nextRevisionId;
  devVerificationReceipts = [];
  devVerificationBehavior = "pass";
  await runCli(receiptVerifyArguments, { journal: receiptVerifyJournal });
  assert.equal(
    requests.filter((request) =>
      request.url?.endsWith(`/dev-sessions/${sessionId}/verify`),
    ).length,
    verifyPostsBeforeLostReceipt + 2,
  );

  const promotionJournal = path.join(temporary, "journal-promotion");
  const sourceRoot = await prepareDevSource("promotion-app", promotionJournal);
  activeDeploymentId = deploymentId;
  finalVerificationDeploymentId = deploymentId;
  activeDevRevisionId = revisionId;
  failVerificationResponse = true;
  await runCli(
    [
      "app",
      "dev",
      "promote",
      sourceRoot,
      "--interval",
      "0.05",
      "--timeout",
      "2",
    ],
    { journal: promotionJournal, status: 1 },
  );
  const recovered = await runCli(
    [
      "app",
      "dev",
      "promote",
      sourceRoot,
      "--interval",
      "0.05",
      "--timeout",
      "2",
    ],
    { journal: promotionJournal },
  );
  const recoveredOutput = JSON.parse(recovered.stdout);
  assert.equal(recoveredOutput.completed, true);
  assert.equal(recoveredOutput.productionVerificationId, verificationId);
  await assert.rejects(readFile(path.join(sourceRoot, ".opencloud", "dev.json")));
  const promotionRequests = requests.filter((request) =>
    request.url?.endsWith(`/dev-sessions/${sessionId}/promote`),
  );
  const verificationRequests = requests.filter(
    (request) => request.url === `/v1/apps/${appId}/verifications`,
  );
  assert.equal(promotionRequests.length, 2);
  assert.equal(verificationRequests.length, 2);
  assert.equal(promotionRequests[0].key, promotionRequests[1].key);
  assert.equal(verificationRequests[0].key, verificationRequests[1].key);
  const successfulStopRequests = requests.filter(
    (request) =>
      request.method === "DELETE" &&
      request.url?.startsWith(
        `/v1/apps/${appId}/dev-sessions/${sessionId}?`,
      ),
  );
  assert.equal(successfulStopRequests.length, 1);
  assert.equal(
    new URL(successfulStopRequests[0].url, "http://localhost").searchParams.get(
      "expectedActiveDeploymentId",
    ),
    deploymentId,
  );

  const mismatchJournal = path.join(temporary, "journal-promotion-mismatch");
  const mismatchRoot = await prepareDevSource(
    "promotion-mismatch-app",
    mismatchJournal,
  );
  finalVerificationDeploymentId = null;
  activeDeploymentId = deploymentId;
  const stopsBeforeMismatch = requests.filter(
    (request) => request.method === "DELETE",
  ).length;
  const verificationMismatch = await runCli(
    [
      "app",
      "dev",
      "promote",
      mismatchRoot,
      "--interval",
      "0.05",
      "--timeout",
      "2",
    ],
    { journal: mismatchJournal, status: 1 },
  );
  assert.equal(
    JSON.parse(verificationMismatch.stderr).error.code,
    "VERIFICATION_FAILED",
  );
  assert.equal(
    requests.filter((request) => request.method === "DELETE").length,
    stopsBeforeMismatch,
  );
  await readFile(path.join(mismatchRoot, ".opencloud", "dev.json"));

  const toctouJournal = path.join(temporary, "journal-promotion-toctou");
  const toctouRoot = await prepareDevSource(
    "promotion-toctou-app",
    toctouJournal,
  );
  finalVerificationDeploymentId = deploymentId;
  activeDeploymentId = deploymentId;
  changeActiveAfterAppRead = true;
  const toctouResult = await runCli(
    [
      "app",
      "dev",
      "promote",
      toctouRoot,
      "--interval",
      "0.05",
      "--timeout",
      "2",
    ],
    { journal: toctouJournal, status: 1 },
  );
  assert.equal(
    JSON.parse(toctouResult.stderr).error.code,
    "ACTIVE_DEPLOYMENT_CHANGED",
  );
  const toctouStop = requests.findLast(
    (request) =>
      request.method === "DELETE" &&
      request.url?.startsWith(
        `/v1/apps/${appId}/dev-sessions/${sessionId}?`,
      ),
  );
  assert.ok(toctouStop);
  assert.equal(
    new URL(toctouStop.url, "http://localhost").searchParams.get(
      "expectedActiveDeploymentId",
    ),
    deploymentId,
  );
  await readFile(path.join(toctouRoot, ".opencloud", "dev.json"));

  const swappedJournal = path.join(temporary, "journal-promotion-swap");
  const swappedRoot = await prepareDevSource(
    "promotion-swap-app",
    swappedJournal,
  );
  activeDeploymentId = deploymentId;
  swapDevStateOnStop = {
    file: path.join(swappedRoot, ".opencloud", "dev.json"),
    state: {
      schemaVersion: 1,
      appId,
      draftId: replacementDraftId,
      sessionId: replacementSessionId,
      artifactSha256,
      updatedAt: now,
    },
  };
  const swapped = await runCli(
    [
      "app",
      "dev",
      "promote",
      swappedRoot,
      "--interval",
      "0.05",
      "--timeout",
      "2",
    ],
    { journal: swappedJournal },
  );
  assert.equal(JSON.parse(swapped.stdout).localStateRemoved, false);
  assert.equal(
    JSON.parse(
      await readFile(path.join(swappedRoot, ".opencloud", "dev.json"), "utf8"),
    ).sessionId,
    replacementSessionId,
  );
  const swappedEntries = await readdir(path.join(swappedJournal, "entries"));
  assert.equal(swappedEntries.length, 1);
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(swappedJournal, "entries", swappedEntries[0]),
        "utf8",
      ),
    ).state,
    "completed",
  );
  const futurePromote = await runCli(
    [
      "app",
      "dev",
      "promote",
      swappedRoot,
      "--interval",
      "0.05",
      "--timeout",
      "2",
    ],
    { journal: swappedJournal, status: 1 },
  );
  assert.doesNotMatch(futurePromote.stderr, /MUTATION_IN_PROGRESS/);
  assert.ok(
    requests.some(
      (request) =>
        request.method === "POST" &&
        request.url ===
          `/v1/apps/${appId}/dev-sessions/${replacementSessionId}/promote`,
    ),
  );

  const retainedSwapJournal = path.join(
    temporary,
    "journal-retained-promotion-swap",
  );
  const retainedSwapRoot = await prepareDevSource(
    "retained-promotion-swap-app",
    retainedSwapJournal,
  );
  const retainedSwapFile = path.join(
    retainedSwapRoot,
    ".opencloud",
    "dev.json",
  );
  activeDeploymentId = deploymentId;
  corruptDevStateOnStop = retainedSwapFile;
  await runCli(
    [
      "app",
      "dev",
      "promote",
      retainedSwapRoot,
      "--interval",
      "0.05",
      "--timeout",
      "2",
    ],
    { journal: retainedSwapJournal, status: 1 },
  );
  await writeDevState(retainedSwapRoot);
  swapDevStateOnVersion = {
    file: retainedSwapFile,
    state: {
      schemaVersion: 1,
      appId,
      draftId: replacementDraftId,
      sessionId: replacementSessionId,
      artifactSha256,
      updatedAt: now,
    },
  };
  const retainedSwap = await runCli(
    [
      "app",
      "dev",
      "promote",
      retainedSwapRoot,
      "--interval",
      "0.05",
      "--timeout",
      "2",
    ],
    { journal: retainedSwapJournal },
  );
  assert.equal(JSON.parse(retainedSwap.stdout).localStateRemoved, false);
  assert.equal(
    JSON.parse(await readFile(retainedSwapFile, "utf8")).sessionId,
    replacementSessionId,
  );
  const retainedSwapEntries = await readdir(
    path.join(retainedSwapJournal, "entries"),
  );
  assert.equal(retainedSwapEntries.length, 1);
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(
          retainedSwapJournal,
          "entries",
          retainedSwapEntries[0],
        ),
        "utf8",
      ),
    ).state,
    "completed",
  );

  const coldPromoteJournal = path.join(
    temporary,
    "journal-cold-promote-replacement",
  );
  const coldPromoteRoot = await prepareDevSource(
    "cold-promote-replacement-app",
    coldPromoteJournal,
  );
  activeDevSessionStatus = "active";
  activeDeploymentId = deploymentId;
  finalVerificationDeploymentId = deploymentId;
  failPromotionResponse = true;
  const coldPromoteArguments = [
    "app",
    "dev",
    "promote",
    coldPromoteRoot,
    "--interval",
    "0.05",
    "--timeout",
    "2",
  ];
  await runCli(coldPromoteArguments, {
    journal: coldPromoteJournal,
    status: 1,
  });
  const coldPromoteOldPosts = requests.filter(
    (request) =>
      request.method === "POST" &&
      request.url === `/v1/apps/${appId}/dev-sessions/${sessionId}/promote`,
  ).length;
  activeDevSessionStatus = "stopped";
  const changedFrontend = path.join(
    coldPromoteRoot,
    "frontend",
    "index.html",
  );
  await writeFile(
    changedFrontend,
    `${await readFile(changedFrontend, "utf8")}\n<!-- replacement revision -->\n`,
  );
  artifactSha256 = JSON.parse(
    (
      await runCli(["validate", coldPromoteRoot], {
        journal: coldPromoteJournal,
      })
    ).stdout,
  ).artifactSha256;
  await writeDevState(coldPromoteRoot, {
    draftId: replacementDraftId,
    sessionId: replacementSessionId,
    artifactSha256,
  });
  const retiredColdPromote = await runCli(coldPromoteArguments, {
    journal: coldPromoteJournal,
  });
  assert.deepEqual(
    {
      retiredSessionId: JSON.parse(retiredColdPromote.stdout).retiredSessionId,
      retiredSessionStatus: JSON.parse(retiredColdPromote.stdout)
        .retiredSessionStatus,
      localStateRemoved: JSON.parse(retiredColdPromote.stdout)
        .localStateRemoved,
    },
    {
      retiredSessionId: sessionId,
      retiredSessionStatus: "stopped",
      localStateRemoved: false,
    },
  );
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(coldPromoteRoot, ".opencloud", "dev.json"),
        "utf8",
      ),
    ).sessionId,
    replacementSessionId,
  );
  assert.equal(
    requests.filter(
      (request) =>
        request.method === "POST" &&
        request.url === `/v1/apps/${appId}/dev-sessions/${sessionId}/promote`,
    ).length,
    coldPromoteOldPosts,
  );
  const nextColdPromote = await runCli(coldPromoteArguments, {
    journal: coldPromoteJournal,
    status: 1,
  });
  assert.doesNotMatch(nextColdPromote.stderr, /MUTATION_IN_PROGRESS/);
  assert.ok(
    requests.some(
      (request) =>
        request.method === "POST" &&
        request.url ===
          `/v1/apps/${appId}/dev-sessions/${replacementSessionId}/promote`,
    ),
  );

  const coldStopJournal = path.join(
    temporary,
    "journal-cold-stop-replacement",
  );
  const coldStopRoot = await prepareDevSource(
    "cold-stop-replacement-app",
    coldStopJournal,
  );
  activeDevSessionStatus = "active";
  failPlainStopResponse = true;
  const coldStopArguments = ["app", "dev", "stop", coldStopRoot];
  const replacementStopsBeforeColdRecovery = requests.filter(
    (request) =>
      request.method === "DELETE" &&
      request.url ===
        `/v1/apps/${appId}/dev-sessions/${replacementSessionId}`,
  ).length;
  await runCli(coldStopArguments, { journal: coldStopJournal, status: 1 });
  const oldStopRequestsAfterLoss = requests.filter(
    (request) =>
      request.method === "DELETE" &&
      request.url === `/v1/apps/${appId}/dev-sessions/${sessionId}`,
  ).length;
  await writeDevState(coldStopRoot, {
    draftId: replacementDraftId,
    sessionId: replacementSessionId,
    artifactSha256,
  });
  const retiredColdStop = await runCli(coldStopArguments, {
    journal: coldStopJournal,
  });
  assert.equal(
    JSON.parse(retiredColdStop.stdout).retiredSessionId,
    sessionId,
  );
  assert.equal(JSON.parse(retiredColdStop.stdout).localStateRemoved, false);
  assert.equal(
    requests.filter(
      (request) =>
        request.method === "DELETE" &&
        request.url === `/v1/apps/${appId}/dev-sessions/${sessionId}`,
    ).length,
    oldStopRequestsAfterLoss,
  );
  const stoppedReplacement = await runCli(coldStopArguments, {
    journal: coldStopJournal,
  });
  assert.equal(JSON.parse(stoppedReplacement.stdout).localStateRemoved, true);
  assert.equal(
    requests.filter(
      (request) =>
        request.method === "DELETE" &&
        request.url ===
          `/v1/apps/${appId}/dev-sessions/${replacementSessionId}`,
    ).length,
    replacementStopsBeforeColdRecovery + 1,
  );
  await assert.rejects(
    readFile(path.join(coldStopRoot, ".opencloud", "dev.json")),
  );

  process.stdout.write(
    "Mutation compatibility, authority/bootstrap boundaries, terminal reconciliation, and fenced promotion recovery contract passed.\n",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
