import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { cliConfigDirectory } from "./cli-config-directory.mjs";

// Runs the built CLI against a fake control plane and checks which failures
// it reports, what a report contains, and that reporting never changes a
// command's output or exit code.

const root = path.resolve(import.meta.dirname, "..");
const binary = path.join(root, "dist", "index.cjs");
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
// The real path, as the CLI sees its working directory (macOS: /private/var).
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "opencloud-error-report-contract-")));
const home = path.join(temporary, "home");
const configHome = path.join(temporary, "config");
const configDirectory = cliConfigDirectory({ home, configHome });
const settingsFile = path.join(configDirectory, "telemetry.json");
await mkdir(home, { recursive: true });

const appId = "10000000-0000-4000-8000-000000000001";
const missingAppId = "10000000-0000-4000-8000-000000000002";
const slowAppId = "10000000-0000-4000-8000-000000000003";
const operationId = "20000000-0000-4000-8000-000000000004";
const token = "synthetic-report-token";
const accountToken = "synthetic-account-access-token";

const REPORT_FIELDS = [
  "appId", "client", "context", "errorCode", "errorName", "httpStatus", "kind", "message",
  "occurredAt", "operationId", "release", "requestId", "route", "source", "stack",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** accept, missing (404), error (500), slow (never answers) or reset. */
let reportMode = "accept";
/** How the login token endpoint answers a refresh: revoked (400 invalid_grant) or down (500). */
let tokenMode = "revoked";
const requests = [];
const reports = [];

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const record = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
  if (request.url === "/v1/platform-errors/reports") {
    reports.push(record);
    if (reportMode === "slow") return;
    if (reportMode === "reset") return request.socket.destroy();
    const status = { accept: 202, missing: 404, error: 500 }[reportMode];
    response.writeHead(status, { "content-type": "application/json" });
    return response.end(status === 202 ? JSON.stringify({ accepted: 1, references: [operationId] }) : "{}");
  }
  requests.push(record);
  // Like the platform, answer with the request's x-request-id.
  const requestId = request.headers["x-request-id"];
  const send = (status, value) => {
    response.writeHead(status, { "content-type": "application/json", ...(requestId ? { "x-request-id": requestId } : {}) });
    response.end(JSON.stringify(value));
  };
  if (request.url === "/version") {
    return send(200, { version: "9.9.9", commit: "contract", builtAt: "2026-10-24T00:00:00Z", releaseId: "contract", contracts: { cliMutationJournal: 1 } });
  }
  if (request.method === "POST" && request.url === "/oauth/token") {
    return tokenMode === "revoked"
      ? send(400, { error: "invalid_grant", error_description: "The refresh token was revoked" })
      : send(500, {});
  }
  if (request.url === "/v1/apps") return send(200, []);
  if (request.url === `/v1/apps/${appId}`) return send(503, { code: "CAPACITY_UNAVAILABLE", message: "Capacity is busy", retryable: true });
  if (request.url === `/v1/apps/${slowAppId}`) return setTimeout(() => send(200, { id: slowAppId }), 1_500);
  if (request.url === `/v1/apps/${appId}/usage`) return request.socket.destroy();
  if (request.method === "POST" && request.url === `/v1/apps/${appId}/restart`) return send(202, { id: operationId, state: "queued" });
  if (request.url === `/v1/operations/${operationId}`) {
    return send(200, { id: operationId, state: "failed", error: { code: "RESTART_FAILED", message: "The runtime did not start" } });
  }
  return send(404, { code: "NOT_FOUND", message: "Not found" });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;

const crashInjector = path.join(home, "crash.cjs");
await writeFile(crashInjector, `// Crashes the running command, as a bug in a callback would, quoting its
// last argument.
if (process.argv[1] && process.argv[1].endsWith("index.cjs")) {
  const argument = process.argv.at(-1);
  setTimeout(() => {
    if (process.env.CONTRACT_CRASH === "rejection") Promise.reject(new Error("contract rejection for " + argument));
    else throw new TypeError("contract crash for " + argument);
  }, 100);
}
`);

async function run(args, { cwd = temporary, env = {}, authority = true } = {}) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("OPENCLOUD_") || name === "DO_NOT_TRACK" || name === "INIT_CWD" || name === "NODE_OPTIONS") {
      delete environment[name];
    }
  }
  Object.assign(environment, {
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    APPDATA: configHome,
    OPENCLOUD_MUTATION_JOURNAL_DIR: path.join(temporary, "journal"),
    ...env,
  });
  const prefix = ["--api-url", apiUrl, ...(authority ? ["--token", token] : [])];
  const started = Date.now();
  const child = spawn(process.execPath, [binary, ...prefix, ...args], { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { status, stdout, stderr, elapsedMs: Date.now() - started };
}

/** Runs a command and returns the reports it sent. */
async function reported(args, options) {
  const offset = reports.length;
  const result = await run(args, options);
  return { ...result, sent: reports.slice(offset) };
}

/** A sent report: its headers, then its body. */
function parsedReport(record) {
  assert.equal(record.headers["content-type"], "application/json");
  assert.match(record.headers["user-agent"], new RegExp(`^opencloud-cli/${version.replaceAll(".", "\\.")} \\(\\S+ \\S+; node \\d+\\.\\d+\\.\\d+\\)$`));
  assert.match(record.headers["x-request-id"], /^cli-/);
  return reportBody(record.body);
}

/** The body has exactly the fields and limits the platform accepts. */
function reportBody(text) {
  assert.ok(Buffer.byteLength(text) <= 64 * 1024, "report body exceeds 64 KB");
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body), ["reports"]);
  assert.equal(body.reports.length, 1);
  const report = body.reports[0];
  assert.deepEqual(Object.keys(report).sort(), REPORT_FIELDS);
  assert.equal(report.source, "cli");
  assert.ok(["cli_error", "cli_crash"].includes(report.kind));
  assert.ok(!Number.isNaN(Date.parse(report.occurredAt)));
  assert.ok(typeof report.message === "string" && report.message.length <= 2_000);
  for (const field of ["errorName", "errorCode"]) {
    assert.ok(report[field] === null || (typeof report[field] === "string" && report[field].length <= 120));
  }
  assert.ok(report.stack === null || (typeof report.stack === "string" && report.stack.length <= 16_000));
  assert.ok(report.requestId === null || REQUEST_ID.test(report.requestId));
  for (const field of ["operationId", "appId"]) assert.ok(report[field] === null || UUID.test(report[field]));
  assert.ok(report.httpStatus === null || (Number.isInteger(report.httpStatus) && report.httpStatus <= 599));
  assert.equal(report.release, version);
  assert.ok(report.route === null || (report.route.length <= 300 && /^[a-z][a-z0-9 -]*$/.test(report.route)));
  assert.deepEqual(Object.keys(report.client).sort(), ["arch", "name", "platform", "runtime", "version"]);
  assert.deepEqual(report.client, {
    name: "opencloud-cli", version, platform: process.platform, arch: process.arch, runtime: `node ${process.versions.node}`,
  });
  const context = Object.entries(report.context);
  assert.ok(context.length <= 40);
  for (const [key, value] of context) {
    assert.match(key, /^[A-Za-z][A-Za-z0-9_]{0,63}$/);
    assert.ok(value === null || ["number", "boolean"].includes(typeof value) || (typeof value === "string" && value.length <= 500));
  }
  assert.equal(report.context.exitCode, 1);
  assert.equal(report.context.nodeZlib, process.versions.zlib);
  // Nothing private leaves the machine.
  for (const secret of [token, accountToken, home]) assert.ok(!text.includes(secret), `report contains ${secret}`);
  return report;
}

function structured(stderr) {
  const lines = stderr.trim().split("\n");
  assert.equal(lines.length, 1, `expected one JSON error line:\n${stderr}`);
  return JSON.parse(lines[0]);
}

const sameIds = (text) => text.replace(/cli-[0-9a-f-]{36}/g, "cli-<id>");

try {
  // Every API request names the CLI and carries a request ID; success sends nothing.
  const listed = await reported(["app", "list"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.sent.length, 0);
  const listRequest = requests.at(-1);
  assert.equal(listRequest.url, "/v1/apps");
  assert.match(listRequest.headers["user-agent"], /^opencloud-cli\//);
  assert.match(listRequest.headers["x-request-id"], /^cli-[0-9a-f-]{36}$/);

  // A 5xx answer: the command's credential, request ID and status.
  const unavailable = await reported(["app", "get", appId]);
  assert.equal(unavailable.status, 1);
  assert.equal(unavailable.stdout, "");
  const unavailableError = structured(unavailable.stderr);
  assert.equal(unavailableError.error.code, "CAPACITY_UNAVAILABLE");
  assert.equal(unavailableError.error.requestId, requests.at(-1).headers["x-request-id"]);
  assert.equal(unavailable.sent.length, 1);
  assert.equal(unavailable.sent[0].headers.authorization, `Bearer ${token}`);
  assert.equal(unavailable.sent[0].url, "/v1/platform-errors/reports");
  const apiReport = parsedReport(unavailable.sent[0]);
  assert.equal(apiReport.kind, "cli_error");
  assert.equal(apiReport.route, "app get");
  assert.equal(apiReport.message, "Capacity is busy");
  assert.equal(apiReport.errorName, "ApiError");
  assert.equal(apiReport.errorCode, "CAPACITY_UNAVAILABLE");
  assert.equal(apiReport.httpStatus, 503);
  assert.equal(apiReport.requestId, unavailableError.error.requestId);
  assert.equal(apiReport.context.retryable, true);
  assert.equal(apiReport.context.options, "--api-url,--token");
  assert.ok(!unavailable.sent[0].body.includes(appId), "an argument value was reported");

  // No answer at all: the cause code and the request ID the CLI sent.
  const dropped = await reported(["usage", appId]);
  assert.equal(dropped.status, 1);
  const droppedError = structured(dropped.stderr);
  assert.equal(droppedError.error.message, "fetch failed");
  assert.equal(droppedError.error.cause.code, "UND_ERR_SOCKET");
  assert.equal(droppedError.error.requestId, requests.at(-1).headers["x-request-id"]);
  const networkReport = parsedReport(dropped.sent[0]);
  assert.equal(networkReport.errorName, "TypeError");
  assert.equal(networkReport.context.causeCode, "UND_ERR_SOCKET");
  assert.equal(networkReport.requestId, droppedError.error.requestId);
  assert.equal(networkReport.httpStatus, null);

  // A durable operation that failed.
  const restarted = await reported(["app", "restart", appId, "--idempotency-key", "contract-restart-1", "--interval", "0.05", "--timeout", "5"]);
  assert.equal(restarted.status, 1);
  assert.equal(structured(restarted.stderr).error.code, "OPERATION_FAILED");
  const operationReport = parsedReport(restarted.sent[0]);
  assert.equal(operationReport.route, "app restart");
  assert.equal(operationReport.operationId, operationId);
  assert.equal(operationReport.context.operationState, "failed");
  assert.equal(operationReport.context.operationErrorCode, "RESTART_FAILED");
  assert.equal(operationReport.context.options, "--api-url,--idempotency-key,--interval,--timeout,--token");

  // A CLI failure before any request: paths in the home directory are
  // reported from ~, and parsers' excerpts of files never.
  const broken = path.join(home, "broken");
  await mkdir(path.join(broken, ".opencloud"), { recursive: true });
  await writeFile(path.join(broken, ".opencloud", "app.json"), JSON.stringify({ schemaVersion: 1 }));
  const invalid = await reported(["app", "list"], { cwd: broken });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.sent[0].headers.authorization, `Bearer ${token}`);
  assert.equal(parsedReport(invalid.sent[0]).message, "Invalid OpenCloud workspace binding: ~/broken/.opencloud/app.json");
  const corruptApp = path.join(home, "corrupt");
  await mkdir(path.join(corruptApp, ".opencloud"), { recursive: true });
  await writeFile(path.join(corruptApp, ".opencloud", "dev.json"), '{"sessionId": s3cret-session-value');
  const corrupt = await reported(["app", "dev", "status", corruptApp]);
  assert.equal(corrupt.status, 1);
  // The local error quotes the file, as before; the report does not.
  assert.match(corrupt.stderr, /s3cret/);
  assert.equal(corrupt.sent.length, 1);
  assert.ok(!corrupt.sent[0].body.includes("s3cret"), "a file excerpt was reported");
  assert.equal(parsedReport(corrupt.sent[0]).route, "app dev status");

  // Without a credential for the API the report is anonymous; a login kept in
  // the protected file is used, but never the OS credential service.
  const anonymous = await reported(["app", "list"], { cwd: broken, authority: false });
  assert.equal(anonymous.status, 1);
  assert.equal(anonymous.sent[0].headers.authorization, undefined);
  parsedReport(anonymous.sent[0]);
  const credentials = path.join(configDirectory, "credentials");
  const storeLogin = async (accessExpiresAt) => {
    await mkdir(credentials, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(credentials, `account-${createHash("sha256").update(apiUrl).digest("hex")}.json`),
      `${JSON.stringify({
        schemaVersion: 1, kind: "account", apiUrl, issuer: apiUrl,
        tokenEndpoint: `${apiUrl}/oauth/token`, revocationEndpoint: `${apiUrl}/oauth/revoke`,
        accessToken: accountToken, accessExpiresAt,
        refreshToken: "synthetic-refresh", refreshExpiresAt: "2099-01-01T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
  };
  await storeLogin("2099-01-01T00:00:00.000Z");
  const signedIn = await reported(["app", "dev", "status", corruptApp], { authority: false });
  assert.equal(signedIn.status, 1);
  assert.equal(signedIn.sent[0].headers.authorization, `Bearer ${accountToken}`);
  assert.equal(parsedReport(signedIn.sent[0]).route, "app dev status");

  // A login that cannot be refreshed: revoked is the caller's to replace, an
  // outage of the token endpoint is reported (anonymously: the login expired).
  await storeLogin("2000-01-01T00:00:00.000Z");
  const revoked = await reported(["login"], { authority: false });
  assert.equal(revoked.status, 1);
  assert.match(structured(revoked.stderr).error.message, /could not be refreshed/);
  assert.equal(revoked.sent.length, 0);
  tokenMode = "down";
  const outage = await reported(["login"], { authority: false });
  assert.equal(outage.status, 1);
  assert.equal(revoked.stderr, outage.stderr);
  assert.equal(outage.sent.length, 1);
  assert.equal(outage.sent[0].headers.authorization, undefined);
  assert.equal(parsedReport(outage.sent[0]).route, "login");
  await rm(credentials, { recursive: true, force: true });

  // Outcomes for the caller are not reported: API 4xx answers, usage errors,
  // a missing login, an invalid manifest, and another app than the directory's.
  const project = path.join(home, "project");
  await mkdir(path.join(project, ".opencloud"), { recursive: true });
  await writeFile(path.join(project, ".opencloud", "app.json"), JSON.stringify({
    schemaVersion: 1, apiUrl, appId, appName: "Contract", appUrl: "https://contract.example.test",
    connectedAt: "2026-10-24T00:00:00.000Z", credentialExpiresAt: "2099-01-01T00:00:00.000Z",
  }));
  const empty = path.join(temporary, "empty-app");
  await mkdir(empty);
  const unknownKey = path.join(temporary, "unknown-key-app");
  await mkdir(unknownKey);
  await writeFile(path.join(unknownKey, "opencloud.yaml"), `schemaVersion: 3\nappId: ${appId}\nname: Contract\nmanifestSecret: s3cret-manifest-value\n`);
  for (const [args, options] of [
    [["app", "get", missingAppId]],
    [["app", "nope"]],
    [["app", "get"]],
    [["app", "credential-create", appId, "--name", "n", "--token-file", path.join(temporary, "t"), "--idempotency-key", "contract-usage-1", "--expires-in-hours", "999"]],
    [["app", "list"], { authority: false }],
    [["app", "dev", "start", empty, "--idempotency-key", "contract-start-1"]],
    [["validate", unknownKey]],
    [["app", "restart", missingAppId, "--idempotency-key", "contract-mismatch-1"], { cwd: project }],
    [["app", "--help"]],
    [["--cli-version"]],
    [["--version"]],
    [["-v"]],
  ]) {
    const result = await reported(args, options);
    const shown = args.includes("--help") || args.includes("--cli-version") ||
      args.includes("--version") || args.includes("-v");
    assert.equal(result.status, shown ? 0 : 1, `${args.join(" ")}\n${result.stderr}`);
    assert.equal(result.sent.length, 0, `${args.join(" ")} was reported`);
  }

  // A failing, refusing or silent report endpoint changes nothing.
  const baseline = await reported(["app", "get", appId], { env: { OPENCLOUD_TELEMETRY: "0" } });
  assert.equal(baseline.sent.length, 0);
  for (const mode of ["missing", "error", "reset", "slow"]) {
    reportMode = mode;
    const result = await reported(["app", "get", appId]);
    assert.equal(result.sent.length, 1, mode);
    assert.equal(result.status, baseline.status, mode);
    assert.equal(result.stdout, baseline.stdout, mode);
    assert.equal(sameIds(result.stderr), sameIds(baseline.stderr), mode);
    // The report waits at most 2.5 s.
    assert.ok(result.elapsedMs < baseline.elapsedMs + 3_500, `${mode} kept the CLI alive for ${result.elapsedMs} ms`);
  }
  reportMode = "accept";

  // Crashes are reported, and Node still prints them and exits as usual. The
  // connected directory names the app; the argument's value is removed.
  for (const crash of ["exception", "rejection"]) {
    const env = { NODE_OPTIONS: `--require ${crashInjector}`, CONTRACT_CRASH: crash };
    const quiet = await reported(["app", "get", slowAppId], { cwd: project, env: { ...env, OPENCLOUD_TELEMETRY: "0" } });
    const result = await reported(["app", "get", slowAppId], { cwd: project, env });
    assert.equal(quiet.sent.length, 0);
    assert.equal(result.status, 1);
    assert.equal(result.status, quiet.status);
    assert.equal(result.stdout, quiet.stdout);
    assert.equal(result.stderr, quiet.stderr);
    assert.match(result.stderr, crash === "exception" ? /TypeError: contract crash for / : /Error: contract rejection for /);
    assert.equal(result.sent.length, 1);
    const crashReport = parsedReport(result.sent[0]);
    assert.equal(crashReport.kind, "cli_crash");
    assert.equal(crashReport.message, `contract ${crash === "exception" ? "crash" : "rejection"} for [VALUE]`);
    assert.match(crashReport.stack, /\(~\/crash\.cjs:\d+:\d+\)/);
    assert.equal(crashReport.route, "app get");
    assert.equal(crashReport.appId, appId);
    assert.equal(crashReport.context.crashOrigin, crash === "exception" ? "uncaughtException" : "unhandledRejection");
    assert.equal(result.sent[0].headers.authorization, `Bearer ${token}`);
    assert.ok(!result.sent[0].body.includes(slowAppId), "an argument value was reported");
  }

  // Opting out, and the status that explains it.
  const status = async (env) => JSON.parse((await run(["telemetry", "status"], { env })).stdout);
  assert.deepEqual(await status(), { errorReports: true, mode: "send", source: "default", settingsFile });
  for (const env of [{ OPENCLOUD_TELEMETRY: "0" }, { OPENCLOUD_TELEMETRY: "off" }, { DO_NOT_TRACK: "1" }, { DO_NOT_TRACK: "1", OPENCLOUD_TELEMETRY: "1" }]) {
    assert.equal((await reported(["app", "get", appId], { env })).sent.length, 0, JSON.stringify(env));
  }
  assert.deepEqual(await status({ DO_NOT_TRACK: "1" }), { errorReports: false, mode: "off", source: "env:DO_NOT_TRACK", settingsFile });
  const disabled = await run(["telemetry", "disable"]);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.deepEqual(JSON.parse(disabled.stdout), { errorReports: false, mode: "off", source: "config", settingsFile });
  assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")), { schemaVersion: 1, errorReports: false });
  assert.equal((await reported(["app", "get", appId])).sent.length, 0);
  assert.equal((await reported(["app", "get", appId], { env: { OPENCLOUD_TELEMETRY: "1" } })).sent.length, 1);
  assert.deepEqual(JSON.parse((await run(["telemetry", "enable"])).stdout), { errorReports: true, mode: "send", source: "config", settingsFile });
  assert.equal((await reported(["app", "get", appId])).sent.length, 1);

  // Log mode prints the exact report instead of sending it, even with DO_NOT_TRACK.
  const logged = await reported(["app", "get", appId], { env: { OPENCLOUD_TELEMETRY: "log", DO_NOT_TRACK: "1" } });
  assert.equal(logged.status, 1);
  assert.equal(logged.sent.length, 0);
  const [errorLine, reportLine, ...rest] = logged.stderr.trim().split("\n");
  assert.deepEqual(rest, []);
  assert.equal(JSON.parse(errorLine).error.code, "CAPACITY_UNAVAILABLE");
  assert.equal(reportBody(reportLine).route, "app get");

  // Agents read stderr through a pipe, so the one-time notice never shows there.
  await rm(settingsFile, { force: true });
  const piped = await reported(["app", "get", appId]);
  assert.equal(piped.sent.length, 1);
  structured(piped.stderr);
  await assert.rejects(readFile(settingsFile, "utf8"), { code: "ENOENT" });

  // A broken settings file falls back to the default, and telemetry commands are never reported.
  await mkdir(settingsFile, { recursive: true });
  const unwritable = await reported(["telemetry", "disable"]);
  assert.equal(unwritable.status, 1);
  assert.equal(unwritable.sent.length, 0);
  assert.equal((await reported(["app", "get", appId])).sent.length, 1);
  await rm(settingsFile, { recursive: true, force: true });

  process.stdout.write(
    "Error report contract passed: 5xx, network, operation, CLI and crash failures are reported with the command's credential, redacted and within the platform's limits; caller outcomes, opt-outs, log mode and failing report endpoints change nothing.\n",
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
