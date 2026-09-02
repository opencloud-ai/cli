import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const binary = path.join(root, "dist", "index.cjs");
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "opencloud-owner-http-contract-"),
);
const appId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000002";
const fileId = "00000000-0000-4000-8000-000000000003";
const connectionId = "00000000-0000-4000-8000-000000000004";
const bindingId = "00000000-0000-4000-8000-000000000005";
const draftId = "00000000-0000-4000-8000-000000000006";
const userId = "00000000-0000-4000-8000-000000000007";
const tokenId = "00000000-0000-4000-8000-000000000008";
const deploymentId = "00000000-0000-4000-8000-000000000009";
const messageId = "00000000-0000-4000-8000-00000000000a";
const backupId = "00000000-0000-4000-8000-00000000000b";
const contractTimestamp = "2026-09-02T12:00:00.000Z";
const requests = [];

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  const body = await requestBody(request);
  requests.push({
    method: request.method,
    url: request.url,
    headers: request.headers,
    body,
  });
  if (request.url === "/version") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        version: "3.7.0",
        commit: "contract-test",
        builtAt: "2026-09-02T00:00:00.000Z",
        releaseId: "platform-v3.7.0-contract-test",
        contracts: { cliMutationJournal: 1 },
      }),
    );
    return;
  }
  if (request.url === `/v1/apps/${appId}/files/${fileId}/content`) {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": "15",
    });
    response.end("downloaded-file");
    return;
  }
  let payload;
  if (
    request.method === "POST" &&
    request.url === `/v1/apps/${appId}/credentials`
  ) {
    payload = {
      id: "credential-contract",
      prefix: "oc_app_contract",
      token: "oc_app_contractOnlyValue1234",
      scopes: ["app:read"],
      expiresAt: "2026-09-03T00:00:00.000Z",
    };
  } else if (
    request.method === "POST" &&
    request.url === `/v1/apps/${appId}/access-token-requests`
  ) {
    payload = {
      approvalUrl: "https://approval.example.test/request",
      expiresAt: "2026-09-03T00:00:00.000Z",
    };
  } else if (
    request.method === "PUT" &&
    request.url === `/v1/apps/${appId}/secrets/API_KEY`
  ) {
    payload = { name: "API_KEY", stored: true };
  } else if (
    request.method === "PATCH" &&
    request.url === `/v1/apps/${appId}/drafts/${draftId}/files`
  ) {
    payload = { draft: { id: draftId, revision: 4 }, files: [] };
  } else if (
    request.method === "GET" &&
    request.url === `/v1/apps/${appId}/drafts/${draftId}`
  ) {
    payload = {
      id: draftId,
      appId,
      baseDeploymentId: null,
      name: "Contract draft",
      status: "open",
      revision: 3,
      createdAt: contractTimestamp,
      updatedAt: contractTimestamp,
      deployedAt: null,
    };
  } else if (
    request.method === "POST" &&
    request.url === `/v1/apps/${appId}/drafts/${draftId}/validate`
  ) {
    payload = {
      id: operationId,
      draftId,
      revision: 3,
      passed: true,
      artifactSha256: "a".repeat(64),
      manifest: {},
      canonicalSourceManifest: "opencloud.yaml",
      sourceManifest: "opencloud.yaml",
      sourceFiles: [],
      artifactFiles: [],
      diagnostics: [],
      nextAction: "deploy",
      createdAt: contractTimestamp,
    };
  } else if (
    request.method === "GET" &&
    request.url === `/v1/apps/${appId}/backups`
  ) {
    payload = [{ id: backupId, appId, state: "succeeded" }];
  } else if (
    request.url?.includes("/integrations/") &&
    request.url.endsWith("/binding-operations")
  ) {
    payload = { id: operationId, state: "succeeded" };
  } else if (request.url === `/v1/operations/${operationId}`) {
    payload = { id: operationId, state: "succeeded", output: { ok: true } };
  } else {
    payload = { id: operationId, state: "queued" };
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
});

async function runCli(arguments_, options = {}) {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const environment = { ...process.env };
  for (const name of [
    "INIT_CWD",
    "OPENCLOUD_API_URL",
    "OPENCLOUD_TOKEN",
    "OPENCLOUD_SESSION_FILE",
    "OPENCLOUD_WORKSPACE_FILE",
    "OPENCLOUD_MUTATION_JOURNAL_DIR",
  ]) {
    delete environment[name];
  }
  environment.OPENCLOUD_MUTATION_JOURNAL_DIR = path.join(
    temporary,
    "mutation-journal",
  );
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      [
        "--api-url",
        `http://127.0.0.1:${address.port}`,
        "--token",
        "synthetic-authority",
        ...arguments_,
      ],
      {
        cwd: temporary,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) =>
      resolve({ status, signal, stdout, stderr }),
    );
    child.stdin.end(options.input);
  });
  assert.equal(
    result.status,
    0,
    `${arguments_.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
  );
  assert.equal(result.signal, null);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `${arguments_.join(" ")} emitted extra JSON`);
  return JSON.parse(lines[0]);
}

async function verifyRequest({
  arguments_,
  method,
  url,
  body,
  idempotencyKey,
}) {
  const offset = requests.length;
  await runCli(arguments_);
  const emitted = requests
    .slice(offset)
    .filter((request) => request.url !== "/version");
  assert.ok(emitted.length >= 1, `${arguments_.join(" ")} made no request`);
  const target = emitted.find(
    (request) => request.method === method && request.url === url,
  );
  assert.ok(target, `${arguments_.join(" ")} omitted ${method} ${url}`);
  if (body !== undefined) {
    assert.deepEqual(
      JSON.parse(target.body.toString("utf8")),
      body,
      arguments_.join(" "),
    );
  }
  if (idempotencyKey !== undefined) {
    assert.equal(
      target.headers["idempotency-key"],
      idempotencyKey,
      arguments_.join(" "),
    );
  }
}

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  await runCli([
    "app",
    "restart",
    appId,
    "--idempotency-key",
    "contract-restart",
    "--interval",
    "0.05",
    "--timeout",
    "2",
  ]);
  await runCli([
    "data",
    "create",
    appId,
    "items",
    "--values",
    '{"title":"one"}',
    "--no-follow",
    "--idempotency-key",
    "contract-data",
  ]);
  await runCli([
    "function",
    "invoke",
    appId,
    "refresh-items",
    "--input",
    '{"limit":3}',
    "--no-follow",
    "--idempotency-key",
    "contract-function",
  ]);

  const upload = path.join(temporary, "upload.txt");
  await writeFile(upload, "streamed upload");
  await runCli([
    "file",
    "upload",
    appId,
    upload,
    "--name",
    "renamed.txt",
    "--content-type",
    "text/plain",
    "--no-follow",
    "--idempotency-key",
    "contract-file-upload",
  ]);
  const downloaded = path.join(temporary, "download.bin");
  await runCli(["file", "download", appId, fileId, "--output", downloaded]);
  assert.equal(await readFile(downloaded, "utf8"), "downloaded-file");

  await runCli(
    ["secret", "set", appId, "API_KEY", "--idempotency-key", "contract-secret"],
    { input: "synthetic-secret\n" },
  );
  const tokenFile = path.join(temporary, "credential.token");
  const credential = await runCli([
    "app",
    "credential-create",
    appId,
    "--name",
    "contract",
    "--token-file",
    tokenFile,
    "--scopes",
    "app:read",
    "--idempotency-key",
    "contract-credential",
  ]);
  assert.equal("token" in credential, false);
  assert.equal(credential.tokenFile, tokenFile);
  assert.equal(
    await readFile(tokenFile, "utf8"),
    "oc_app_contractOnlyValue1234\n",
  );

  const changesFile = path.join(temporary, "changes.json");
  await writeFile(
    changesFile,
    JSON.stringify([{ path: "frontend/index.html", content: "updated" }]),
  );
  await runCli([
    "draft",
    "apply",
    appId,
    draftId,
    "--expected-revision",
    "3",
    "--changes-file",
    changesFile,
  ]);
  await runCli([
    "draft",
    "deploy",
    appId,
    draftId,
    "--no-follow",
    "--idempotency-key",
    "contract-draft-deploy",
  ]);
  await runCli([
    "integration",
    "bind",
    appId,
    "calendar",
    "--connection-id",
    connectionId,
    "--resource-id",
    "primary",
    "--idempotency-key",
    "contract-integration",
  ]);
  await runCli(["operation", "get", operationId, "--follow"]);
  await runCli([
    "app",
    "access",
    "builder-remove",
    appId,
    bindingId,
    "--no-follow",
    "--idempotency-key",
    "contract-access",
  ]);

  const noFollow = ["--no-follow", "--idempotency-key"];
  const routeCases = [
    {
      arguments_: [
        "app",
        "configure",
        appId,
        "--name",
        "Renamed",
        ...noFollow,
        "contract-configure",
      ],
      method: "PATCH",
      url: `/v1/apps/${appId}`,
      body: { name: "Renamed" },
      idempotencyKey: "contract-configure",
    },
    ...["archive", "unarchive"].map((action) => ({
      arguments_: ["app", action, appId, ...noFollow, `contract-${action}`],
      method: "POST",
      url: `/v1/apps/${appId}/${action}`,
      body: {},
      idempotencyKey: `contract-${action}`,
    })),
    {
      arguments_: ["app", "delete", appId, ...noFollow, "contract-delete"],
      method: "DELETE",
      url: `/v1/apps/${appId}`,
      idempotencyKey: "contract-delete",
    },
    {
      arguments_: ["app", "members", appId],
      method: "GET",
      url: `/v1/apps/${appId}/members`,
    },
    {
      arguments_: ["app", "access", "list", appId],
      method: "GET",
      url: `/v1/apps/${appId}/access`,
    },
    {
      arguments_: [
        "app",
        "access",
        "add",
        appId,
        "--email",
        "owner@example.test",
        "--role",
        "builder",
        ...noFollow,
        "contract-access-add",
      ],
      method: "POST",
      url: `/v1/apps/${appId}/access`,
      body: { email: "owner@example.test", role: "builder" },
      idempotencyKey: "contract-access-add",
    },
    ...[
      ["grant", "access", "PUT"],
      ["revoke", "access", "DELETE"],
      ["builder-add", "builders", "PUT"],
    ].map(([command, segment, method]) => ({
      arguments_: [
        "app",
        "access",
        command,
        appId,
        userId,
        ...noFollow,
        `contract-${command}`,
      ],
      method,
      url: `/v1/apps/${appId}/${segment}/${userId}`,
      ...(method === "PUT" ? { body: {} } : {}),
      idempotencyKey: `contract-${command}`,
    })),
    {
      arguments_: ["app", "access-token", "list", appId],
      method: "GET",
      url: `/v1/apps/${appId}/access-tokens`,
    },
    {
      arguments_: [
        "app",
        "access-token",
        "create",
        appId,
        "--name",
        "Automation",
        "--expires-in-days",
        "30",
        "--idempotency-key",
        "contract-token-create",
      ],
      method: "POST",
      url: `/v1/apps/${appId}/access-tokens`,
      body: { name: "Automation", expiresInDays: 30, delivery: "reveal_link" },
      idempotencyKey: "contract-token-create",
    },
    {
      arguments_: [
        "app",
        "access-token",
        "request",
        appId,
        "--name",
        "Approval",
        "--expires-in-days",
        "14",
      ],
      method: "POST",
      url: `/v1/apps/${appId}/access-token-requests`,
      body: { name: "Approval", expiresInDays: 14 },
    },
    {
      arguments_: [
        "app",
        "access-token",
        "revoke",
        appId,
        tokenId,
        "--idempotency-key",
        "contract-token-revoke",
      ],
      method: "DELETE",
      url: `/v1/apps/${appId}/access-tokens/${tokenId}`,
      idempotencyKey: "contract-token-revoke",
    },
    {
      arguments_: ["app", "email", "capture-get", appId, messageId],
      method: "GET",
      url: `/v1/apps/${appId}/email/captures/${messageId}`,
    },
    {
      arguments_: ["draft", "create", appId, "--name", "Candidate", "--empty"],
      method: "POST",
      url: `/v1/apps/${appId}/drafts`,
      body: { name: "Candidate", cloneActive: false },
    },
    ...["list", "get", "files", "diff"].map((command) => ({
      arguments_: [
        "draft",
        command,
        appId,
        ...(["get", "files", "diff"].includes(command) ? [draftId] : []),
      ],
      method: "GET",
      url:
        command === "list"
          ? `/v1/apps/${appId}/drafts`
          : `/v1/apps/${appId}/drafts/${draftId}${command === "get" ? "" : `/${command}`}`,
    })),
    {
      arguments_: [
        "draft",
        "read",
        appId,
        draftId,
        "--path",
        "frontend/index.html",
        "--path",
        "opencloud.yaml",
      ],
      method: "POST",
      url: `/v1/apps/${appId}/drafts/${draftId}/files/read`,
      body: { paths: ["frontend/index.html", "opencloud.yaml"] },
    },
    {
      arguments_: [
        "draft",
        "validate",
        appId,
        draftId,
        "--legacy-version",
        "legacy-2",
      ],
      method: "POST",
      url: `/v1/apps/${appId}/drafts/${draftId}/validate`,
      body: { version: "legacy-2" },
    },
    {
      arguments_: [
        "draft",
        "discard",
        appId,
        draftId,
        "--idempotency-key",
        "contract-draft-discard",
      ],
      method: "DELETE",
      url: `/v1/apps/${appId}/drafts/${draftId}`,
      idempotencyKey: "contract-draft-discard",
    },
    {
      arguments_: ["data", "tables", appId],
      method: "GET",
      url: `/v1/apps/${appId}/data/tables`,
    },
    {
      arguments_: [
        "data",
        "list",
        appId,
        "items",
        "--limit",
        "25",
        "--cursor",
        "next",
      ],
      method: "GET",
      url: `/v1/apps/${appId}/data/items/rows?limit=25&cursor=next`,
    },
    {
      arguments_: ["data", "get", appId, "items", "row-1"],
      method: "GET",
      url: `/v1/apps/${appId}/data/items/rows/row-1`,
    },
    {
      arguments_: [
        "data",
        "create-many",
        appId,
        "items",
        "--values",
        '[{"title":"one"}]',
        ...noFollow,
        "contract-data-many",
      ],
      method: "POST",
      url: `/v1/apps/${appId}/data/items/mutations`,
      body: { action: "createMany", values: [{ title: "one" }] },
      idempotencyKey: "contract-data-many",
    },
    {
      arguments_: [
        "data",
        "update",
        appId,
        "items",
        "row-1",
        "--values",
        '{"done":true}',
        ...noFollow,
        "contract-data-update",
      ],
      method: "POST",
      url: `/v1/apps/${appId}/data/items/mutations`,
      body: { action: "updateById", id: "row-1", values: { done: true } },
      idempotencyKey: "contract-data-update",
    },
    {
      arguments_: [
        "data",
        "delete",
        appId,
        "items",
        "row-1",
        ...noFollow,
        "contract-data-delete",
      ],
      method: "POST",
      url: `/v1/apps/${appId}/data/items/mutations`,
      body: { action: "deleteById", id: "row-1" },
      idempotencyKey: "contract-data-delete",
    },
    {
      arguments_: ["file", "list", appId, "--limit", "25", "--cursor", "next"],
      method: "GET",
      url: `/v1/apps/${appId}/files?limit=25&cursor=next`,
    },
    {
      arguments_: ["file", "get", appId, fileId],
      method: "GET",
      url: `/v1/apps/${appId}/files/${fileId}`,
    },
    {
      arguments_: [
        "file",
        "replace",
        appId,
        fileId,
        upload,
        "--name",
        "replacement.txt",
        "--content-type",
        "text/plain",
        ...noFollow,
        "contract-file-replace",
      ],
      method: "PUT",
      url: `/v1/apps/${appId}/files/${fileId}?name=replacement.txt`,
      idempotencyKey: "contract-file-replace",
    },
    {
      arguments_: [
        "file",
        "delete",
        appId,
        fileId,
        ...noFollow,
        "contract-file-delete",
      ],
      method: "DELETE",
      url: `/v1/apps/${appId}/files/${fileId}`,
      idempotencyKey: "contract-file-delete",
    },
    {
      arguments_: ["operation", "list", appId, "--limit", "25"],
      method: "GET",
      url: `/v1/apps/${appId}/operations?limit=25`,
    },
    {
      arguments_: [
        "deployment",
        "delete",
        appId,
        deploymentId,
        "--idempotency-key",
        "contract-deploy-delete",
      ],
      method: "DELETE",
      url: `/v1/apps/${appId}/deployments/${deploymentId}`,
      idempotencyKey: "contract-deploy-delete",
    },
    {
      arguments_: ["backup", "get", appId, backupId],
      method: "GET",
      url: `/v1/apps/${appId}/backups`,
    },
    {
      arguments_: [
        "cron",
        "invoke",
        appId,
        "daily-refresh",
        ...noFollow,
        "contract-cron-invoke",
      ],
      method: "POST",
      url: `/v1/apps/${appId}/cron/daily-refresh/operations`,
      idempotencyKey: "contract-cron-invoke",
    },
    {
      arguments_: ["integration", "list", appId],
      method: "GET",
      url: `/v1/apps/${appId}/integrations`,
    },
    {
      arguments_: [
        "integration",
        "resources",
        appId,
        "calendar",
        "--connection-id",
        connectionId,
      ],
      method: "GET",
      url: `/v1/apps/${appId}/integrations/calendar/connections/${connectionId}/resources`,
    },
    {
      arguments_: [
        "integration",
        "unbind",
        appId,
        "calendar",
        bindingId,
        "--idempotency-key",
        "contract-integration-unbind",
      ],
      method: "POST",
      url: `/v1/apps/${appId}/integrations/calendar/bindings/${bindingId}/delete-operations`,
      idempotencyKey: "contract-integration-unbind",
    },
    {
      arguments_: [
        "visitors",
        appId,
        "--from",
        "2026-08-01T00:00:00Z",
        "--to",
        "2026-09-01T00:00:00Z",
      ],
      method: "GET",
      url: `/v1/apps/${appId}/visitors?from=2026-08-01T00%3A00%3A00Z&to=2026-09-01T00%3A00%3A00Z`,
    },
  ];
  for (const routeCase of routeCases) await verifyRequest(routeCase);

  const findRequest = (method, url) =>
    requests.find(
      (request) => request.method === method && request.url === url,
    );
  assert.equal(
    findRequest("POST", `/v1/apps/${appId}/restart`)?.headers[
      "idempotency-key"
    ],
    "contract-restart",
  );
  assert.deepEqual(
    JSON.parse(
      findRequest(
        "POST",
        `/v1/apps/${appId}/data/items/mutations`,
      ).body.toString("utf8"),
    ),
    { action: "create", values: { title: "one" } },
  );
  assert.deepEqual(
    JSON.parse(
      findRequest(
        "POST",
        `/v1/apps/${appId}/functions/refresh-items/invocations`,
      ).body.toString("utf8"),
    ),
    { input: { limit: 3 } },
  );
  const uploadRequest = findRequest(
    "POST",
    `/v1/apps/${appId}/files?name=renamed.txt`,
  );
  assert.equal(uploadRequest.body.toString("utf8"), "streamed upload");
  assert.equal(uploadRequest.headers["content-type"], "text/plain");
  assert.equal(uploadRequest.headers["content-length"], "15");
  assert.deepEqual(
    JSON.parse(
      findRequest("PUT", `/v1/apps/${appId}/secrets/API_KEY`).body.toString(
        "utf8",
      ),
    ),
    { value: "synthetic-secret" },
  );
  assert.deepEqual(
    JSON.parse(
      findRequest(
        "PATCH",
        `/v1/apps/${appId}/drafts/${draftId}/files`,
      ).body.toString("utf8"),
    ),
    {
      expectedRevision: 3,
      changes: [{ path: "frontend/index.html", content: "updated" }],
    },
  );

  process.stdout.write(
    `Owner HTTP contract passed across ${requests.length} bounded requests.\n`,
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
