import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const binary = path.resolve(import.meta.dirname, "../dist/index.cjs");
const temporary = await mkdtemp(path.join(os.tmpdir(), "opencloud-integration-contract-"));
const token = "synthetic-integration-authority";
const appId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const draftId = "00000000-0000-4000-8000-000000000003";
const connectionId = "00000000-0000-4000-8000-000000000004";
const providerAppId = "00000000-0000-4000-8000-000000000005";
const organisationId = "00000000-0000-4000-8000-000000000006";
const deliveryId = "00000000-0000-4000-8000-000000000007";
const timestamp = "2026-09-30T12:00:00.000Z";
const appRoot = path.join(temporary, "consumer-app");
const devBase = `/v1/apps/${appId}/dev-sessions/${sessionId}`;
const catalog = {
  integrations: [{
    providerAppId, providerAppName: "Acme CRM gateway", organisationId,
    name: "acme-crm", title: "Acme CRM", description: "Contacts from Acme CRM.",
    authorization: { type: "oauth2", scopes: ["contacts.read"], redirectUri: "https://api.example.test/v1/custom-integrations/oauth/callback" },
    events: [{ type: "contact.created", capability: "contacts.read", description: "A contact was created.", fake: { contactId: "c_1" } }],
    sync: { schedule: "*/15 * * * *", timezone: null }, webhook: true, credentials: [],
    capabilities: [{ name: "contacts.read", description: "Read contacts" }],
    operations: [{ name: "contacts.list", capability: "contacts.read", description: "List contacts.", input: null, output: null, fake: { contacts: [] } }],
    canConnectForOrganisation: false, canAdminister: false, connections: [],
  }],
};
const deliveries = {
  deliveries: [{
    id: deliveryId, eventId: "evt-1", eventType: "contact.created", integrationName: "crm",
    handlerFunction: "on-contact", environment: "production", status: "delivered", attempts: 1,
    lastError: null, occurredAt: timestamp, createdAt: timestamp, deliveredAt: timestamp,
  }],
};
const settings = {
  sessionId,
  slots: [{ integrationName: "crm", provider: "custom", mode: "fake", liveAvailable: true }],
  providedIntegration: {
    name: "acme-crm", testConnectionId: null,
    eligibleTestConnections: [{ id: connectionId, label: "Sandbox", custody: "personal" }],
  },
};
const requests = [];
let dropNextInjection = false;

const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const url = new URL(request.url, "http://localhost");
  requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), key: request.headers["idempotency-key"], body });
  const send = (status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (url.pathname === "/version") {
    send(200, { version: "3.11.0", commit: "synthetic", builtAt: timestamp, releaseId: "synthetic", contracts: { cliMutationJournal: 1 } });
    return;
  }
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  const route = `${request.method} ${url.pathname}`;
  if (route === `GET /v1/apps/${appId}/custom-integrations`) return send(200, catalog);
  if (route === `GET /v1/apps/${appId}/integration-events`) return send(200, deliveries);
  if (route === `GET ${devBase}/integrations`) return send(200, settings);
  if (route === `PUT ${devBase}/integrations/crm/mode`) {
    const { mode } = JSON.parse(body);
    return send(200, { ...settings, slots: [{ ...settings.slots[0], mode }] });
  }
  if (route === `PUT ${devBase}/integration-test-connection`) {
    const selected = JSON.parse(body).connectionId;
    return send(200, { ...settings, providedIntegration: { ...settings.providedIntegration, testConnectionId: selected } });
  }
  if (route === `POST ${devBase}/integrations/crm/events`) {
    // The platform rejects injection without an 8-200 character Idempotency-Key.
    const key = request.headers["idempotency-key"] ?? "";
    if (key.length < 8 || key.length > 200) {
      return send(400, { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key header must contain 8 to 200 characters" });
    }
    if (dropNextInjection) {
      dropNextInjection = false;
      request.socket.destroy();
      return;
    }
    const event = JSON.parse(body);
    return send(200, { eventId: event.id ?? "dev-generated", delivered: true, status: 200, requestId: "dev-request", error: null });
  }
  send(404, { code: "UNEXPECTED_ROUTE", message: `Unexpected ${route}` });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

async function run(args, { status = 0, cwd = temporary } = {}) {
  const env = { ...process.env, OPENCLOUD_MUTATION_JOURNAL_DIR: path.join(temporary, "journal") };
  for (const key of ["INIT_CWD", "OPENCLOUD_API_URL", "OPENCLOUD_TOKEN", "OPENCLOUD_SESSION_FILE", "OPENCLOUD_WORKSPACE_FILE"]) delete env[key];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, "--api-url", `http://127.0.0.1:${server.address().port}`, "--token", token, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, status, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(token), "credential exposed");
  const content = (status === 0 ? result.stdout : result.stderr).trim();
  assert.equal(content.split("\n").length, 1, content);
  return JSON.parse(content);
}

async function rejected(args, code, { mayCheckCompatibility = false } = {}) {
  const before = requests.length;
  const failure = await run(args, { status: 1 });
  assert.equal(failure.ok, false);
  if (code) assert.equal(failure.error.code, code, JSON.stringify(failure));
  const sent = requests.slice(before).map((request) => request.path);
  assert.deepEqual(sent, mayCheckCompatibility ? sent.filter((item) => item === "/version") : [], `invalid input reached the API: ${args.join(" ")}`);
  return failure;
}

function lastRequest(method, pathname) {
  const match = requests.filter((request) => request.method === method && request.path === pathname).at(-1);
  assert.ok(match, `missing ${method} ${pathname}`);
  return match;
}

const generatedKey = /^ocj1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

try {
  await mkdir(path.join(appRoot, ".opencloud"), { recursive: true });
  await writeFile(path.join(appRoot, ".opencloud", "dev.json"), `${JSON.stringify({ schemaVersion: 1, appId, draftId, sessionId, artifactSha256: "a".repeat(64), updatedAt: timestamp })}\n`, { mode: 0o600 });
  await writeFile(path.join(appRoot, "event.json"), JSON.stringify({ contactId: "c_file", name: "File Contact" }));

  // Organisation catalog and production delivery history are plain reads.
  assert.deepEqual(await run(["integration", "custom-list", appId]), catalog);
  assert.equal(lastRequest("GET", `/v1/apps/${appId}/custom-integrations`).key, undefined);
  assert.deepEqual(await run(["integration", "events", appId]), deliveries);
  assert.deepEqual(requests.at(-1).query, { limit: "50" });
  await run(["integration", "events", appId, "--limit", "25"]);
  assert.deepEqual(requests.at(-1).query, { limit: "25" });
  for (const limit of ["0", "101", "2.5", "many"]) {
    await rejected(["integration", "events", appId, "--limit", limit], "INVALID_OPTION");
  }

  assert.deepEqual(await run(["app", "dev", "integration", "list", appRoot]), settings);
  assert.equal(requests.at(-1).path, `${devBase}/integrations`);

  // Fake/live mode changes are journaled PUTs of the whole requested state.
  const live = await run(["app", "dev", "integration", "mode", appRoot, "crm", "live", "--idempotency-key", "contract-mode-live"]);
  assert.equal(live.slots[0].mode, "live");
  const modeRequest = lastRequest("PUT", `${devBase}/integrations/crm/mode`);
  assert.deepEqual(JSON.parse(modeRequest.body), { mode: "live" });
  assert.equal(modeRequest.key, "contract-mode-live");
  assert.equal((await run(["app", "dev", "integration", "mode", appRoot, "crm", "fake"])).slots[0].mode, "fake");
  assert.match(lastRequest("PUT", `${devBase}/integrations/crm/mode`).key, generatedKey);
  await rejected(["app", "dev", "integration", "mode", appRoot, "crm", "sometimes"]);
  await rejected(["app", "dev", "integration", "mode", appRoot, "CRM", "live"], "INVALID_INTEGRATION_NAME");

  // Test connections are selected by ID or explicitly cleared with null.
  const selected = await run(["app", "dev", "integration", "test-connection", appRoot, connectionId, "--idempotency-key", "contract-test-connection"]);
  assert.equal(selected.providedIntegration.testConnectionId, connectionId);
  const selectRequest = lastRequest("PUT", `${devBase}/integration-test-connection`);
  assert.deepEqual(JSON.parse(selectRequest.body), { connectionId });
  assert.equal(selectRequest.key, "contract-test-connection");
  assert.equal((await run(["app", "dev", "integration", "test-connection", appRoot, "--clear", "--idempotency-key", "contract-test-clear"])).providedIntegration.testConnectionId, null);
  assert.deepEqual(JSON.parse(lastRequest("PUT", `${devBase}/integration-test-connection`).body), { connectionId: null });
  await rejected(["app", "dev", "integration", "test-connection", appRoot], "INVALID_OPTION");
  await rejected(["app", "dev", "integration", "test-connection", appRoot, connectionId, "--clear"], "INVALID_OPTION");
  await rejected(["app", "dev", "integration", "test-connection", appRoot, "not-a-connection"], "INVALID_OPTION");

  // Event injection always carries the required Idempotency-Key header.
  const injected = await run(["app", "dev", "integration", "inject", appRoot, "crm", "--type", "contact.created", "--data", '{"contactId":"c_9","name":"Ada"}', "--id", "evt-9", "--idempotency-key", "contract-event-explicit"]);
  assert.deepEqual(injected, { eventId: "evt-9", delivered: true, status: 200, requestId: "dev-request", error: null });
  const explicitInjection = lastRequest("POST", `${devBase}/integrations/crm/events`);
  assert.equal(explicitInjection.key, "contract-event-explicit");
  assert.deepEqual(JSON.parse(explicitInjection.body), { type: "contact.created", data: { contactId: "c_9", name: "Ada" }, id: "evt-9" });

  await run(["app", "dev", "integration", "inject", appRoot, "crm", "--type", "contact.created"]);
  const defaultInjection = lastRequest("POST", `${devBase}/integrations/crm/events`);
  assert.match(defaultInjection.key, generatedKey);
  assert.deepEqual(JSON.parse(defaultInjection.body), { type: "contact.created" });

  // --data-file resolves relative to the app directory, not the caller cwd.
  await run(["app", "dev", "integration", "inject", appRoot, "crm", "--type", "contact.created", "--data-file", "event.json", "--idempotency-key", "contract-event-file"]);
  assert.deepEqual(JSON.parse(lastRequest("POST", `${devBase}/integrations/crm/events`).body).data, { contactId: "c_file", name: "File Contact" });

  await rejected(["app", "dev", "integration", "inject", appRoot, "crm", "--type", "Contact Created"], "INVALID_INTEGRATION_EVENT");
  await rejected(["app", "dev", "integration", "inject", appRoot, "crm", "--type", "contact.created", "--data", "[1]"], "INVALID_JSON_SHAPE");
  await rejected(["app", "dev", "integration", "inject", appRoot, "crm", "--type", "contact.created", "--data", "{", "--idempotency-key", "contract-event-invalid-json"], "INVALID_JSON");
  await rejected(["app", "dev", "integration", "inject", appRoot, "crm", "--type", "contact.created", "--data", "{}", "--data-file", "event.json"]);
  await rejected(["app", "dev", "integration", "inject", appRoot, "crm"]);
  await rejected(["app", "dev", "integration", "inject", appRoot, "crm", "--type", "contact.created", "--idempotency-key", "short"], "INVALID_IDEMPOTENCY_KEY", { mayCheckCompatibility: true });

  // A lost response is retried with the journal's same generated key, while a
  // different unresolved event for the slot is refused before any request.
  const lostArgs = ["app", "dev", "integration", "inject", appRoot, "crm", "--type", "contact.created", "--id", "evt-lost"];
  dropNextInjection = true;
  const beforeLost = requests.length;
  await run(lostArgs, { status: 1 });
  const firstAttempt = requests.slice(beforeLost).find((request) => request.method === "POST");
  assert.match(firstAttempt.key, generatedKey);
  const conflict = await run(["app", "dev", "integration", "inject", appRoot, "crm", "--type", "contact.updated"], { status: 1 });
  assert.equal(conflict.error.code, "MUTATION_IN_PROGRESS");
  assert.equal(requests.filter((request) => request.method === "POST").at(-1), firstAttempt);
  assert.equal((await run(lostArgs)).eventId, "evt-lost");
  const replayed = lastRequest("POST", `${devBase}/integrations/crm/events`);
  assert.notEqual(replayed, firstAttempt);
  assert.equal(replayed.key, firstAttempt.key);
  assert.equal(replayed.body, firstAttempt.body);

  process.stdout.write("Integration command HTTP, input validation, and idempotency contract passed.\n");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
