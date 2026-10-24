import { createServer, type IncomingMessage } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "./api-client.js";
import { resetApiUsage, setCliVersion } from "./cli-http.js";
import {
  ERROR_REPORT_ENDPOINT,
  ERROR_REPORT_NOTICE,
  ErrorReporter,
  buildErrorReport,
  describeInvocation,
  isReportableFailure,
  readTelemetrySettings,
  redactReportText,
  resolveErrorReportSettings,
  serializeReport,
  type CrashReportRequest,
  type FailureSource,
  type ReportInput,
} from "./error-reports.js";
import { MutationJournalError } from "./mutation-journal.js";
import {
  CliContractError,
  OperationTerminalError,
  OperationWaitTimeoutError,
} from "./owner-parity.js";

const APP_ID = "10000000-0000-4000-8000-000000000001";
const OPERATION_ID = "20000000-0000-4000-8000-000000000002";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  resetApiUsage();
  setCliVersion("0.0.0");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function settingsFile(contents?: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencloud-error-reports-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "config", "telemetry.json");
  if (contents !== undefined) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  }
  return file;
}

function reportInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    kind: "cli_error",
    route: "app dev start",
    optionNames: ["--api-url", "--idempotency-key"],
    privateValues: [],
    appId: APP_ID,
    hostedAgent: false,
    occurredAt: new Date("2026-10-24T20:00:00.000Z"),
    durationMs: 1234.4,
    exitCode: 1,
    env: {},
    homeDirectory: "/home/alice",
    stdoutIsTTY: true,
    ...overrides,
  };
}

/** The exact fields the platform accepts; it refuses anything else. */
const REPORT_FIELDS = [
  "appId",
  "client",
  "context",
  "errorCode",
  "errorName",
  "httpStatus",
  "kind",
  "message",
  "occurredAt",
  "operationId",
  "release",
  "requestId",
  "route",
  "source",
  "stack",
];

function source(overrides: Partial<FailureSource> = {}): FailureSource {
  return {
    context: {
      route: "app list",
      optionNames: [],
      privateValues: [],
      appId: null,
      hostedAgent: false,
    },
    apiUrl: "https://api.example.test",
    commandCredential: () => "used-token",
    accountCredential: async () => "account-token",
    ...overrides,
  };
}

function memoryStderr(isTTY = false) {
  const writes: string[] = [];
  return { writes, stream: { isTTY, write: (text: string) => writes.push(text) } };
}

describe("error report settings", () => {
  it("sends reports by default", async () => {
    const file = await settingsFile();
    expect(resolveErrorReportSettings({}, file)).toMatchObject({ mode: "send", source: "default" });
  });

  it("honours the settings file, then OPENCLOUD_TELEMETRY, then DO_NOT_TRACK", async () => {
    const off = await settingsFile({ schemaVersion: 1, errorReports: false });
    const on = await settingsFile({ schemaVersion: 1, errorReports: true });
    expect(resolveErrorReportSettings({}, off)).toMatchObject({ mode: "off", source: "config" });
    expect(resolveErrorReportSettings({}, on)).toMatchObject({ mode: "send", source: "config" });
    for (const value of ["0", "false", "OFF", " no "]) {
      expect(resolveErrorReportSettings({ OPENCLOUD_TELEMETRY: value }, on)).toMatchObject({
        mode: "off",
        source: "env:OPENCLOUD_TELEMETRY",
      });
    }
    for (const value of ["1", "true", "on", "YES"]) {
      expect(resolveErrorReportSettings({ OPENCLOUD_TELEMETRY: value }, off)).toMatchObject({
        mode: "send",
        source: "env:OPENCLOUD_TELEMETRY",
      });
    }
    expect(resolveErrorReportSettings({ OPENCLOUD_TELEMETRY: "log" }, off)).toMatchObject({
      mode: "log",
      source: "env:OPENCLOUD_TELEMETRY",
    });
    // An unknown value changes nothing.
    expect(resolveErrorReportSettings({ OPENCLOUD_TELEMETRY: "maybe" }, off)).toMatchObject({
      mode: "off",
      source: "config",
    });
  });

  it("lets DO_NOT_TRACK win, except that log mode still only prints", async () => {
    const on = await settingsFile({ schemaVersion: 1, errorReports: true });
    for (const value of ["1", "true", "yes", "anything"]) {
      expect(
        resolveErrorReportSettings({ DO_NOT_TRACK: value, OPENCLOUD_TELEMETRY: "1" }, on),
      ).toMatchObject({ mode: "off", source: "env:DO_NOT_TRACK" });
    }
    for (const value of ["", "0", " 0 "]) {
      expect(resolveErrorReportSettings({ DO_NOT_TRACK: value }, on)).toMatchObject({
        mode: "send",
        source: "config",
      });
    }
    expect(
      resolveErrorReportSettings({ DO_NOT_TRACK: "1", OPENCLOUD_TELEMETRY: "log" }, on),
    ).toMatchObject({ mode: "log", source: "env:OPENCLOUD_TELEMETRY" });
  });

  it("treats a missing or unreadable settings file as the defaults", async () => {
    for (const contents of ["not json", "[]", { schemaVersion: 2, errorReports: false }, { schemaVersion: 1, errorReports: "no" }]) {
      const file = await settingsFile(contents);
      expect(readTelemetrySettings(file)).toEqual({ schemaVersion: 1 });
      expect(resolveErrorReportSettings({}, file)).toMatchObject({ mode: "send", source: "default" });
    }
  });

  it("persists enable and disable in a mode-0600 file", async () => {
    const file = await settingsFile();
    const reporter = new ErrorReporter({ settingsFile: file, source: () => source(), env: {} });
    reporter.configure(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ schemaVersion: 1, errorReports: false });
    expect(reporter.status()).toEqual({
      errorReports: false,
      mode: "off",
      source: "config",
      settingsFile: file,
    });
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
    reporter.configure(true);
    expect(reporter.status()).toMatchObject({ errorReports: true, mode: "send", source: "config" });
    const environment = new ErrorReporter({ settingsFile: file, source: () => source(), env: { DO_NOT_TRACK: "1" } });
    expect(environment.status()).toMatchObject({ errorReports: false, source: "env:DO_NOT_TRACK" });
  });
});

describe("which failures are reported", () => {
  it("reports CLI errors, 5xx answers, missing answers and failed or unknown operations", () => {
    for (const error of [
      new Error("ENOTDIR: not a directory, open '/dev/fd/13'"),
      Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" }),
      new CliContractError("ARTIFACT_MISMATCH", "differs"),
      new MutationJournalError("MUTATION_OUTCOME_UNKNOWN", "unknown"),
      new MutationJournalError("CORRUPT_MUTATION_JOURNAL", "corrupt"),
      new ApiError(500, { code: "INTERNAL" }),
      new ApiError(503, {}),
      new ApiError(409, { code: "OPERATION_FAILED", operation: { id: OPERATION_ID, state: "failed" } }),
      new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) }),
      new DOMException("The request timed out after 30000ms", "TimeoutError"),
      new OperationTerminalError({ id: OPERATION_ID, state: "failed" }),
      new OperationWaitTimeoutError({ id: OPERATION_ID, state: "running" }),
      "a thrown string",
    ]) {
      expect(isReportableFailure(error), String(error)).toBe(true);
    }
  });

  it("does not report API 4xx answers, usage errors or cancelled operations", () => {
    for (const error of [
      new ApiError(400, { code: "VALIDATION_FAILED" }),
      new ApiError(401, {}),
      new ApiError(403, {}),
      new ApiError(404, {}),
      new ApiError(409, { code: "ACTIVE_DEPLOYMENT_CHANGED" }),
      new ApiError(413, {}),
      new ApiError(429, { code: "RATE_LIMITED" }),
      new ApiError(402, { code: "PLAN_LIMIT" }),
      new CommanderError(1, "commander.unknownCommand", "error: unknown command 'nope'"),
      new CommanderError(1, "commander.missingArgument", "error: missing required argument"),
      new CommanderError(1, "commander.unknownOption", "error: unknown option"),
      new CliContractError("INVALID_OPTION", "--limit must be an integer"),
      new MutationJournalError("APP_OWNER_IDEMPOTENCY_KEY_REQUIRED", "required"),
      new CliContractError("TOKEN_FILE_EXISTS", "exists"),
      new OperationTerminalError({ id: OPERATION_ID, state: "cancelled" }),
    ]) {
      expect(isReportableFailure(error), String(error)).toBe(false);
    }
  });
});

describe("redaction", () => {
  it("removes credentials, secret values, URL queries and the home directory", () => {
    const text = redactReportText(
      [
        "Bearer abc.def.ghi",
        "oc_owner_abcdefghijklmnop oc_run_private-test-token",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.c2lnbmF0dXJlLXZhbHVl",
        "password=hunter2 refresh_token=r3fr3sh client_secret=s3cr3t",
        '{"accessToken": "jsonsecret", "name": "kept"}',
        "Authorization: Basic dXNlcjpwYXNzd29yZA==",
        "https://user:pw@api.example.test/callback?code=one&state=two#frag",
        "/home/alice/projects/app/opencloud.yaml and /home/alicea/elsewhere",
      ].join("\n"),
      { homeDirectory: "/home/alice" },
    );
    for (const secret of [
      "abc.def.ghi",
      "abcdefghijklmnop",
      "private-test-token",
      "eyJhbGci",
      "hunter2",
      "r3fr3sh",
      "s3cr3t",
      "jsonsecret",
      "dXNlcjpw",
      "user:pw",
      "code=one",
      "frag",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('"name": "kept"');
    expect(text).toContain("https://api.example.test/callback");
    expect(text).toContain("~/projects/app/opencloud.yaml");
    expect(text).toContain("/home/alicea/elsewhere");
  });

  it("removes argument, option and environment values, but not inside other words", () => {
    expect(
      redactReportText(
        "Refusing to overwrite /work/person@example.com.json for app Family tasks in web, a webhook, after 900 ms (ab)",
        { privateValues: ["person@example.com", "Family tasks", "web", "900", "ab"] },
      ),
    ).toBe("Refusing to overwrite /work/[VALUE].json for app [VALUE] in [VALUE], a webhook, after 900 ms (ab)");
  });

  it("never treats the filesystem root as the home directory", () => {
    expect(redactReportText("/usr/lib/node", { homeDirectory: "/" })).toBe("/usr/lib/node");
  });
});

describe("report payload", () => {
  it("contains exactly the fields the platform accepts", () => {
    setCliVersion("3.16.0");
    const error = Object.assign(
      new Error("ENOTDIR: not a directory, open '/home/alice/app/.opencloud/journal'"),
      { code: "ENOTDIR", syscall: "open" },
    );
    const report = buildErrorReport(error, reportInput({ env: { CI: "true" } }));
    expect(Object.keys(report).sort()).toEqual(REPORT_FIELDS);
    expect(report).toMatchObject({
      source: "cli",
      kind: "cli_error",
      occurredAt: "2026-10-24T20:00:00.000Z",
      message: "ENOTDIR: not a directory, open '~/app/.opencloud/journal'",
      errorName: "Error",
      errorCode: "ENOTDIR",
      requestId: null,
      operationId: null,
      httpStatus: null,
      appId: APP_ID,
      release: "3.16.0",
      route: "app dev start",
      client: {
        name: "opencloud-cli",
        version: "3.16.0",
        platform: process.platform,
        arch: process.arch,
        runtime: `node ${process.versions.node}`,
      },
    });
    expect(Object.keys(report.client).sort()).toEqual(["arch", "name", "platform", "runtime", "version"]);
    expect(report.stack).toMatch(/^Error: ENOTDIR: not a directory, open '~\/app\/\.opencloud\/journal'\n\s+at /);
    expect(report.context).toEqual({
      exitCode: 1,
      durationMs: 1234,
      retryable: false,
      ci: true,
      tty: true,
      hostedAgent: false,
      syscall: "open",
      nodeZlib: process.versions.zlib,
      osRelease: os.release(),
      options: "--api-url,--idempotency-key",
    });
  });

  it("describes API failures, durable operations and network failures", () => {
    const api = buildErrorReport(
      new ApiError(503, { code: "CAPACITY_UNAVAILABLE", message: "busy", requestId: "cli-0f2c" }),
      reportInput(),
    );
    expect(api).toMatchObject({
      message: "busy",
      errorName: "ApiError",
      errorCode: "CAPACITY_UNAVAILABLE",
      requestId: "cli-0f2c",
      httpStatus: 503,
      context: { retryable: true },
    });
    const operation = buildErrorReport(
      new OperationTerminalError({ id: OPERATION_ID, state: "failed", error: { code: "FUNCTION_FAILED" } }),
      reportInput(),
    );
    expect(operation).toMatchObject({
      errorCode: "OPERATION_FAILED",
      operationId: OPERATION_ID,
      context: { operationState: "failed", operationErrorCode: "FUNCTION_FAILED" },
    });
    const network = buildErrorReport(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
      }),
      reportInput(),
    );
    expect(network).toMatchObject({ errorName: "TypeError", errorCode: "CLI_ERROR", context: { causeCode: "CERT_HAS_EXPIRED" } });
  });

  it("drops identifiers the platform would refuse", () => {
    const report = buildErrorReport(
      new OperationTerminalError({ id: "operation-4", state: "failed" }),
      reportInput({ appId: "00000000-0000-0000-0000-000000000001" }),
    );
    expect(report.operationId).toBeNull();
    expect(report.appId).toBeNull();
    expect(
      buildErrorReport(new ApiError(500, { requestId: "has spaces" }), reportInput()).requestId,
    ).toBeNull();
  });

  it("never sends parser excerpts of a file", () => {
    const yaml = buildErrorReport(
      Object.assign(new Error("Flow sequence must end with a ] at line 4, column 3:\n\n  KEY: [unclosed\n  other: s3cretvalue\n  ^\n"), { name: "YAMLParseError" }),
      reportInput(),
    );
    expect(yaml.message).toBe("Flow sequence must end with a ] at line 4, column 3:");
    expect(yaml.stack).not.toContain("s3cretvalue");
    let json: unknown;
    try {
      JSON.parse('{"token": oops-s3cretvalue}');
    } catch (error) {
      json = error;
    }
    const report = buildErrorReport(json, reportInput());
    expect(report.message).not.toContain("s3cretvalue");
    expect(report.stack).not.toContain("s3cretvalue");
  });

  it("caps every field and the request body", () => {
    const huge = new Error(`${"x".repeat(5_000)} \u0001`.repeat(4));
    huge.stack = `Error: ${huge.message}\n${"    at frame (/home/alice/\u0001\u0002.js:1:1)\n".repeat(2_000)}`;
    const report = buildErrorReport(
      huge,
      reportInput({ route: "r".repeat(400), optionNames: Array.from({ length: 200 }, (_, index) => `--option-${index}`) }),
    );
    expect(report.message.length).toBeLessThanOrEqual(2_000);
    expect(report.stack!.length).toBeLessThanOrEqual(16_000);
    expect(report.route!.length).toBeLessThanOrEqual(300);
    expect(String(report.context.options).length).toBeLessThanOrEqual(500);
    expect(Object.keys(report.context).length).toBeLessThanOrEqual(40);
    const body = serializeReport(report);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(64 * 1024);
    expect(Object.keys(JSON.parse(body))).toEqual(["reports"]);
  });

  it("shortens the stack when escaping would exceed 64 KB", () => {
    const report = buildErrorReport(new Error("boom"), reportInput());
    // Each control character is escaped as six bytes of JSON.
    const escaped = { ...report, stack: "\u0001".repeat(16_000), message: "\u0002".repeat(2_000) };
    const body = serializeReport(escaped);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(64 * 1024);
    const sent = JSON.parse(body).reports[0];
    expect(sent.message).toBe(escaped.message);
    expect(sent.stack.length).toBeLessThan(16_000);
    expect(serializeReport(report)).toBe(JSON.stringify({ reports: [report] }));
  });
});

describe("command invocation", () => {
  it("names the command path and options without their values", async () => {
    let described: ReturnType<typeof describeInvocation> | null = null;
    const program = new Command()
      .exitOverride()
      .option("--api-url <url>")
      .option("--token <token>");
    program.hook("preAction", (_root, action) => {
      described = describeInvocation(action);
    });
    program
      .command("app")
      .command("dev")
      .command("start")
      .argument("<directory>")
      .option("--idempotency-key <key>")
      .option("--no-follow")
      .option("--interval <seconds>", "", "2")
      .option("--method <method>")
      .action(() => undefined);
    await program.parseAsync(
      ["--api-url", "https://api.example.test", "app", "dev", "start", "/home/alice/app", "--idempotency-key", "key-123456", "--no-follow"],
      { from: "user" },
    );
    expect(described).toEqual({
      route: "app dev start",
      optionNames: ["--api-url", "--idempotency-key", "--no-follow"],
      privateValues: expect.arrayContaining(["https://api.example.test", "key-123456", "/home/alice/app"]),
    });
  });
});

describe("reporting", () => {
  function reporter(options: Partial<ConstructorParameters<typeof ErrorReporter>[0]> & { file: string }) {
    return new ErrorReporter({
      settingsFile: options.file,
      source: options.source ?? (() => source()),
      env: options.env ?? {},
      stderr: options.stderr ?? memoryStderr().stream,
      stdoutIsTTY: false,
      homeDirectory: "/home/alice",
      ...options,
    });
  }

  it("posts one report with the command's credential and CLI headers", async () => {
    const file = await settingsFile();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const stderr = memoryStderr();
    const errorReporter = reporter({
      file,
      stderr: stderr.stream,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        return Response.json({ accepted: 1, references: [OPERATION_ID] }, { status: 202 });
      }) as typeof fetch,
    });
    expect(await errorReporter.reportFailure(new Error("boom"))).toBe("sent");
    expect(await errorReporter.reportFailure(new Error("again"))).toBe("skipped");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.example.test${ERROR_REPORT_ENDPOINT}`);
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer used-token");
    expect(headers.get("user-agent")).toMatch(/^opencloud-cli\//);
    expect(headers.get("x-request-id")).toMatch(/^cli-/);
    expect(calls[0]!.init.redirect).toBe("manual");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.reports).toHaveLength(1);
    expect(Object.keys(body.reports[0]).sort()).toEqual(REPORT_FIELDS);
    expect(stderr.writes).toEqual([]);
  });

  it("falls back to the stored login, then reports anonymously", async () => {
    const file = await settingsFile();
    const headers: Array<string | null> = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get("authorization"));
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    await reporter({ file, fetch: fetcher, source: () => source({ commandCredential: () => null }) }).reportFailure(new Error("one"));
    await reporter({
      file,
      fetch: fetcher,
      source: () => source({ commandCredential: () => null, accountCredential: async () => null }),
    }).reportFailure(new Error("two"));
    expect(headers).toEqual(["Bearer account-token", null]);
  });

  it("never changes the outcome when the endpoint fails, refuses or hangs", async () => {
    const file = await settingsFile();
    const exitCode = process.exitCode;
    const answers: Array<() => Promise<Response>> = [
      async () => new Response("not found", { status: 404 }),
      async () => new Response("boom", { status: 500 }),
      async () => new Response(null, { status: 429 }),
      async () => {
        throw new TypeError("fetch failed");
      },
    ];
    for (const answer of answers) {
      const stderr = memoryStderr(false);
      const outcome = await reporter({
        file,
        stderr: stderr.stream,
        fetch: (async () => answer()) as typeof fetch,
      }).reportFailure(new Error("boom"));
      expect(["refused", "failed"]).toContain(outcome);
      expect(stderr.writes).toEqual([]);
    }
    const started = Date.now();
    const hanging = await reporter({
      file,
      timeoutMs: 200,
      fetch: ((_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        })) as typeof fetch,
    }).reportFailure(new Error("boom"));
    expect(hanging).toBe("failed");
    expect(Date.now() - started).toBeLessThan(2_000);
    const slowLogin = await reporter({
      file,
      timeoutMs: 200,
      source: () => source({ commandCredential: () => null, accountCredential: () => new Promise(() => undefined) }),
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        return new Response(null, { status: 202 });
      }) as typeof fetch,
    }).reportFailure(new Error("boom"));
    expect(slowLogin).toBe("failed");
    expect(process.exitCode).toBe(exitCode);
  });

  it("sends nothing when disabled, for non-reportable failures, or for telemetry commands", async () => {
    let posted = 0;
    const fetcher = (async () => {
      posted += 1;
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const disabled = await settingsFile({ schemaVersion: 1, errorReports: false });
    expect(await reporter({ file: disabled, fetch: fetcher }).reportFailure(new Error("x"))).toBe("disabled");
    const file = await settingsFile();
    expect(await reporter({ file, fetch: fetcher, env: { DO_NOT_TRACK: "1" } }).reportFailure(new Error("x"))).toBe("disabled");
    expect(await reporter({ file, fetch: fetcher, env: { OPENCLOUD_TELEMETRY: "0" } }).reportFailure(new Error("x"))).toBe("disabled");
    expect(await reporter({ file, fetch: fetcher }).reportFailure(new ApiError(404, {}))).toBe("not_reportable");
    expect(
      await reporter({ file, fetch: fetcher }).reportFailure(new CommanderError(1, "commander.unknownOption", "unknown option")),
    ).toBe("not_reportable");
    const telemetry = source();
    telemetry.context.route = "telemetry disable";
    expect(await reporter({ file, fetch: fetcher, source: () => telemetry }).reportFailure(new Error("EACCES"))).toBe("excluded");
    expect(posted).toBe(0);
  });

  it("prints the exact report instead of sending it in log mode", async () => {
    const file = await settingsFile();
    const stderr = memoryStderr(true);
    let posted = 0;
    const outcome = await reporter({
      file,
      stderr: stderr.stream,
      env: { OPENCLOUD_TELEMETRY: "log", DO_NOT_TRACK: "1" },
      fetch: (async () => {
        posted += 1;
        return new Response(null, { status: 202 });
      }) as typeof fetch,
    }).reportFailure(new Error("inspect me"));
    expect(outcome).toBe("logged");
    expect(posted).toBe(0);
    expect(stderr.writes).toHaveLength(1);
    const printed = JSON.parse(stderr.writes[0]!);
    expect(printed.reports[0]).toMatchObject({ message: "inspect me", route: "app list" });
    expect(stderr.writes[0]).not.toContain(ERROR_REPORT_NOTICE.slice(0, 20));
  });

  it("shows the notice once, only in a terminal, before the first default report", async () => {
    const fetcher = (async () => new Response(null, { status: 202 })) as typeof fetch;
    const piped = await settingsFile();
    const pipedStderr = memoryStderr(false);
    await reporter({ file: piped, stderr: pipedStderr.stream, fetch: fetcher }).reportFailure(new Error("x"));
    expect(pipedStderr.writes).toEqual([]);
    expect(readTelemetrySettings(piped)).toEqual({ schemaVersion: 1 });

    const terminal = await settingsFile();
    const first = memoryStderr(true);
    await reporter({
      file: terminal,
      stderr: first.stream,
      fetch: fetcher,
      now: () => new Date("2026-10-24T20:00:00.000Z"),
    }).reportFailure(new Error("x"));
    expect(first.writes).toEqual([`${ERROR_REPORT_NOTICE}\n`]);
    expect(ERROR_REPORT_NOTICE).toContain("opencloud telemetry disable");
    expect(ERROR_REPORT_NOTICE).toContain("OPENCLOUD_TELEMETRY=0");
    expect(readTelemetrySettings(terminal)).toEqual({
      schemaVersion: 1,
      noticeShownAt: "2026-10-24T20:00:00.000Z",
    });
    const second = memoryStderr(true);
    await reporter({ file: terminal, stderr: second.stream, fetch: fetcher }).reportFailure(new Error("x"));
    expect(second.writes).toEqual([]);

    // An explicit choice needs no notice.
    const chosen = await settingsFile({ schemaVersion: 1, errorReports: true });
    const explicit = memoryStderr(true);
    await reporter({ file: chosen, stderr: explicit.stream, fetch: fetcher }).reportFailure(new Error("x"));
    expect(explicit.writes).toEqual([]);
  });

  it("reports a crash synchronously and only once", async () => {
    const file = await settingsFile();
    const sent: CrashReportRequest[] = [];
    const errorReporter = reporter({ file, sendSync: (request) => sent.push(request) });
    expect(errorReporter.reportCrash(new TypeError("boom"), "uncaughtException")).toBe("sent");
    expect(errorReporter.reportCrash(new TypeError("again"), "unhandledRejection")).toBe("skipped");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: `https://api.example.test${ERROR_REPORT_ENDPOINT}`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer used-token",
        "user-agent": expect.stringMatching(/^opencloud-cli\//),
        "x-request-id": expect.stringMatching(/^cli-/),
      },
      timeoutMs: 2_500,
    });
    const report = JSON.parse(sent[0]!.body).reports[0];
    expect(report).toMatchObject({ kind: "cli_crash", errorName: "TypeError", context: { crashOrigin: "uncaughtException" } });

    const pipe = reporter({ file, sendSync: (request) => sent.push(request) });
    expect(pipe.reportCrash(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }), "uncaughtException")).toBe("not_reportable");
    const logged: string[] = [];
    const log = reporter({ file, env: { OPENCLOUD_TELEMETRY: "log" }, writeSync: (text) => logged.push(text) });
    expect(log.reportCrash("plain reason", "unhandledRejection")).toBe("logged");
    expect(JSON.parse(logged[0]!).reports[0]).toMatchObject({ kind: "cli_crash", message: "plain reason", stack: null });
  });

  it("sends a real report to a local HTTP server within the time limit", async () => {
    const file = await settingsFile();
    const received: Array<{ request: IncomingMessage; body: string }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({ request, body: Buffer.concat(chunks).toString("utf8") });
      // Only the first request gets an answer.
      if (received.length === 1) {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: 1, references: [OPERATION_ID] }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      const apiUrl = `http://127.0.0.1:${address.port}`;
      expect(await reporter({ file, source: () => source({ apiUrl }) }).reportFailure(new Error("real"))).toBe("sent");
      expect(received[0]!.request.url).toBe(ERROR_REPORT_ENDPOINT);
      expect(received[0]!.request.headers.authorization).toBe("Bearer used-token");
      expect(JSON.parse(received[0]!.body).reports[0].message).toBe("real");
      const started = Date.now();
      expect(
        await reporter({ file, timeoutMs: 300, source: () => source({ apiUrl }) }).reportFailure(new Error("slow")),
      ).toBe("failed");
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
