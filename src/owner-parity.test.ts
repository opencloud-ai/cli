import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-client.js";
import { apiErrorFromResponse } from "../vendor/control-plane-client/src/errors.js";
import { withCliHeaders } from "./cli-http.js";
import { withHint } from "./cli-contract-error.js";
import { MutationJournalError } from "./mutation-journal.js";
import {
  CliContractError,
  OperationTerminalError,
  OperationWaitTimeoutError,
  downloadToFile,
  followOperation,
  isDefiniteRefusal,
  jsonOption,
  parseBoundedNumber,
  persistCredentialToken,
  secretFromStdin,
  structuredCliError,
} from "./owner-parity.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "opencloud-owner-parity-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe("owner-parity CLI helpers", () => {
  it("validates bounded numeric options", () => {
    expect(parseBoundedNumber("2.5", "--interval", 0.05, 60, false)).toBe(2.5);
    expect(() => parseBoundedNumber("2.5", "--limit", 1, 100)).toThrow(
      CliContractError,
    );
    expect(() => parseBoundedNumber("101", "--limit", 1, 100)).toThrow(
      /--limit/,
    );
    // Number() would read these as 0, 16 or 10.
    for (const typed of ["", "   ", "0x10", "1e1", "Infinity", "-0"]) {
      expect(() => parseBoundedNumber(typed, "--limit", 0, 100), typed).toThrow(/--limit must be an integer/);
    }
    expect(() => parseBoundedNumber("1e-1", "--interval", 0.05, 60, false)).toThrow(/--interval/);
    expect(parseBoundedNumber(".5", "--interval", 0.05, 60, false)).toBe(0.5);
    expect(parseBoundedNumber(50, "--limit", 1, 100)).toBe(50);
  });

  it("treats only OpenCloud's own non-retryable 4xx codes as refusals that took no effect", () => {
    const compute = (status: number, code: string, details: Record<string, unknown>) => new ApiError(status, {
      statusCode: status, code, message: "refused", details: { billingDisposition: "none", ...details },
    });
    const definite = [
      compute(409, "COMPUTE_REVISION_CONFLICT", { category: "configuration", origin: "policy", phase: "admission", retryScope: "none", retryable: false }),
      compute(429, "COMPUTE_BUDGET_EXCEEDED", { category: "billing", origin: "policy", phase: "admission", retryScope: "none", retryable: false }),
      new ApiError(422, { code: "INVALID_REGISTRY_HOST", message: "refused" }),
      new ApiError(404, { code: "NOT_FOUND", message: "missing" }),
    ];
    for (const error of definite) expect(isDefiniteRefusal(error), error.code ?? "").toBe(true);
    const uncertain = [
      // Its effects may still happen.
      compute(409, "COMPUTE_OUTCOME_UNKNOWN", { category: "execution", origin: "unknown", phase: "running", retryScope: "observer_reconciliation", retryable: false }),
      // Retryable: the same request may still be in hand.
      compute(429, "COMPUTE_CAPACITY_EXCEEDED", { category: "capacity", origin: "policy", phase: "admission", retryScope: "request", retryable: true }),
      new ApiError(409, { code: "REQUEST_IN_PROGRESS", message: "busy", retryable: true }),
      // A proxy's or an older server's uncoded answer, and a timeout.
      new ApiError(404, "<html>not found</html>"),
      new ApiError(408, { code: "REQUEST_TIMEOUT", message: "slow" }),
      new ApiError(503, { code: "APP_LOCK_BUSY", message: "busy", retryable: true }),
      new ApiError(500, { code: "INTERNAL", message: "fault" }),
      // An answer naming an operation is about work that exists.
      new ApiError(409, { code: "OPERATION_EXISTS", message: "exists", operation: { id: "11111111-1111-4111-8111-111111111111", state: "running" } }),
      new Error("fetch failed"),
    ];
    for (const error of uncertain) expect(isDefiniteRefusal(error), String((error as ApiError).code ?? error.message)).toBe(false);
  });

  it("loads exactly one JSON input source and checks its shape", async () => {
    const directory = await temporaryDirectory();
    const inputFile = path.join(directory, "input.json");
    await writeFile(inputFile, '[{"name":"first"}]');

    await expect(
      jsonOption({
        file: inputFile,
        resolvePath: path.resolve,
        kind: "array",
      }),
    ).resolves.toEqual([{ name: "first" }]);
    await expect(
      jsonOption({
        inline: "{}",
        file: inputFile,
        resolvePath: path.resolve,
        kind: "object",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
    await expect(
      jsonOption({
        inline: "[]",
        resolvePath: path.resolve,
        kind: "object",
      }),
    ).rejects.toMatchObject({ code: "INVALID_JSON_SHAPE" });
  });

  it("follows one operation and returns only the terminal replacement", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ id: "operation-1", state: "running" })
      .mockResolvedValueOnce({
        id: "operation-1",
        state: "succeeded",
        output: { ok: true },
      });
    const result = await followOperation({
      client: { get },
      started: {
        resource: { id: "resource-1" },
        operation: { id: "operation-1", state: "queued" },
      },
      options: { follow: true, interval: "0.05", timeout: "5" },
      sleep: async () => undefined,
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      resource: { id: "resource-1" },
      operation: {
        id: "operation-1",
        state: "succeeded",
        output: { ok: true },
      },
    });
  });

  it("makes terminal failures and bounded wait timeouts recoverable", async () => {
    await expect(
      followOperation({
        client: { get: vi.fn() },
        started: { id: "operation-2", state: "failed" },
        options: { follow: false, interval: "2", timeout: "5" },
      }),
    ).rejects.toBeInstanceOf(OperationTerminalError);

    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(1_000);
    await expect(
      followOperation({
        client: { get: vi.fn() },
        started: { id: "operation-3", state: "queued" },
        options: { follow: true, interval: "1", timeout: "1" },
        now,
        sleep: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(OperationWaitTimeoutError);
  });

  it("reads bounded secrets from standard input without echo metadata", async () => {
    await expect(
      secretFromStdin(Readable.from(["secret-value\n"])),
    ).resolves.toBe("secret-value");
    await expect(secretFromStdin(Readable.from(["\n"]))).rejects.toMatchObject({
      code: "SECRET_INPUT_REQUIRED",
    });
  });

  it("persists one-time credentials with mode 0600 and never returns the token", async () => {
    const directory = await temporaryDirectory();
    const destination = path.join(directory, "private", "app.token");
    const metadata = await persistCredentialToken({
      response: {
        id: "credential-1",
        prefix: "oc_app_example",
        token: "oc_app_do-not-print-this-token",
      },
      destination,
    });

    expect(metadata).toEqual({
      id: "credential-1",
      prefix: "oc_app_example",
      tokenFile: destination,
    });
    expect(metadata).not.toHaveProperty("token");
    expect(await readFile(destination, "utf8")).toBe(
      "oc_app_do-not-print-this-token\n",
    );
    if (process.platform !== "win32") {
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
    }
    await expect(
      persistCredentialToken({
        response: { token: "replacement" },
        destination,
      }),
    ).rejects.toMatchObject({ code: "TOKEN_FILE_EXISTS" });
    expect(await readFile(destination, "utf8")).toContain("do-not-print");
    await expect(
      persistCredentialToken({
        response: {
          id: "credential-1",
          prefix: "oc_app_example",
          token: "oc_app_do-not-print-this-token",
        },
        destination,
      }),
    ).resolves.toEqual(metadata);
  });

  it.runIf(process.platform !== "win32")(
    "rejects existing credential files unless they are exact mode 0600 regular files",
    async () => {
      const directory = await temporaryDirectory();
      const destination = path.join(directory, "app.token");
      const response = { token: "same-secret" };

      await writeFile(destination, "same-secret\n", { mode: 0o400 });
      await expect(
        persistCredentialToken({ response, destination }),
      ).rejects.toMatchObject({ code: "UNSAFE_TOKEN_FILE" });

      await chmod(destination, 0o700);
      await expect(
        persistCredentialToken({ response, destination }),
      ).rejects.toMatchObject({ code: "UNSAFE_TOKEN_FILE" });

      await rm(destination);
      const target = path.join(directory, "target.token");
      await writeFile(target, "same-secret\n", { mode: 0o600 });
      await symlink(target, destination);
      await expect(
        persistCredentialToken({ response, destination }),
      ).rejects.toMatchObject({ code: "UNSAFE_TOKEN_FILE" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "detects replacement of an existing credential path after O_NOFOLLOW open",
    async () => {
      const directory = await temporaryDirectory();
      const destination = path.join(directory, "app.token");
      const retained = path.join(directory, "retained.token");
      await writeFile(destination, "same-secret\n", { mode: 0o600 });

      await expect(
        persistCredentialToken({
          response: { token: "same-secret" },
          destination,
          afterExistingFileOpened: async () => {
            await rename(destination, retained);
            await writeFile(destination, "same-secret\n", { mode: 0o600 });
          },
        }),
      ).rejects.toMatchObject({ code: "UNSAFE_TOKEN_FILE" });
      expect(await readFile(retained, "utf8")).toBe("same-secret\n");
    },
  );

  it("streams downloads to a new file and refuses overwrite", async () => {
    const directory = await temporaryDirectory();
    const destination = path.join(directory, "download.bin");
    const result = await downloadToFile({
      response: new Response("streamed-content"),
      destination,
      force: false,
    });

    expect(await readFile(destination, "utf8")).toBe("streamed-content");
    expect(result).toMatchObject({ output: destination, size: 16 });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      downloadToFile({
        response: new Response("replacement"),
        destination,
        force: false,
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_FILE_EXISTS" });
  });

  it("checks package integrity before replacing output and removes failed temporary files", async () => {
    const directory = await temporaryDirectory();
    const destination = path.join(directory, "app.zip");
    const bytes = "verified-content";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(destination, "keep this");
    for (const expected of [{ bytes: bytes.length, sha256: "0".repeat(64) }, { bytes: bytes.length - 1, sha256 }, { bytes: bytes.length + 1, sha256 }]) {
      await expect(downloadToFile({ response: new Response(bytes), destination, force: true, expected }))
        .rejects.toMatchObject({ code: "DOWNLOAD_INTEGRITY_FAILED" });
      expect(await readFile(destination, "utf8")).toBe("keep this");
      expect(await readdir(directory)).toEqual(["app.zip"]);
    }
    expect(await downloadToFile({ response: new Response(bytes), destination, force: true, expected: { bytes: bytes.length, sha256 } }))
      .toMatchObject({ size: bytes.length, sha256 });
    expect(await readFile(destination, "utf8")).toBe(bytes);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
  });

  it("cancels an unread response when destination setup fails", async () => {
    const directory = await temporaryDirectory();
    const existing = path.join(directory, "existing");
    await writeFile(existing, "keep this");
    for (const destination of [existing, path.join(existing, "app.zip")]) {
      let cancelled = false;
      const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      await expect(downloadToFile({ response, destination, force: false })).rejects.toThrow();
      expect(cancelled).toBe(true);
    }
    expect(await readFile(existing, "utf8")).toBe("keep this");
  });

  it("emits typed, redacted API and operation diagnostics", () => {
    const api = structuredCliError(
      new ApiError(503, {
        code: "CAPACITY_UNAVAILABLE",
        message: "retry Bearer oc_owner_do-not-leak",
        retryable: true,
        requestId: "request-1",
      }),
    );
    expect(api).toEqual({
      ok: false,
      error: {
        code: "CAPACITY_UNAVAILABLE",
        message: "retry [REDACTED]",
        status: 503,
        retryable: true,
        requestId: "request-1",
      },
    });
    expect(JSON.stringify(api)).not.toContain("do-not-leak");

    const failed = structuredCliError(
      new OperationTerminalError({
        id: "operation-4",
        state: "failed",
        error: { code: "FUNCTION_FAILED", secret: "hidden" },
      }),
    );
    expect(failed.error).toMatchObject({
      code: "OPERATION_FAILED",
      operationId: "operation-4",
      operationState: "failed",
      operationErrorCode: "FUNCTION_FAILED",
    });
    expect(failed).not.toHaveProperty("error.operation.error.secret");
  });

  it("shows OpenCloud's next step and the session or releases a development refusal names", () => {
    const stale = structuredCliError(new ApiError(409, {
      code: "DEV_SESSION_STALE",
      message: "Production changed after this development session started, so it can no longer sync, verify or promote.",
      details: { sessionId: "11111111-1111-4111-8111-111111111111", status: "stale", baseDeploymentId: null,
        suggestedFix: "Run opencloud app dev stop, then opencloud app dev start." },
      requestId: "request-1",
    }));
    expect(stale.error).toEqual({
      code: "DEV_SESSION_STALE",
      message: "Production changed after this development session started, so it can no longer sync, verify or promote.",
      status: 409,
      sessionId: "11111111-1111-4111-8111-111111111111",
      sessionStatus: "stale",
      baseDeploymentId: null,
      hint: "Run opencloud app dev stop, then opencloud app dev start.",
      retryable: false,
      requestId: "request-1",
    });
    const overtaken = structuredCliError(new ApiError(409, {
      code: "ACTIVE_DEPLOYMENT_CHANGED",
      message: "Production changed after this development session started, so it can no longer sync, verify or promote.",
      details: { expectedActiveDeploymentId: "22222222-2222-4222-8222-222222222222", actualActiveDeploymentId: "33333333-3333-4333-8333-333333333333",
        suggestedFix: "Run opencloud app dev stop, then opencloud app dev start." },
    }));
    expect(overtaken.error).toMatchObject({
      code: "ACTIVE_DEPLOYMENT_CHANGED",
      expectedActiveDeploymentId: "22222222-2222-4222-8222-222222222222",
      actualActiveDeploymentId: "33333333-3333-4333-8333-333333333333",
      hint: "Run opencloud app dev stop, then opencloud app dev start.",
    });
    // A stale copy, which names no next step, keeps pull or --force.
    expect(structuredCliError(new ApiError(409, { code: "ACTIVE_DEPLOYMENT_CHANGED", details: { latestDeploymentId: null } })).error.hint)
      .toMatch(/^Run opencloud pull <directory> /);
    expect(structuredCliError(new ApiError(409, {
      code: "DEV_MIGRATION_FAILED", message: "Migration 0002 failed", details: { suggestedFix: "Correct the migration source, validate the new draft revision, then apply it again." },
    })).error.hint).toBe("Correct the migration source, validate the new draft revision, then apply it again.");
  });

  it("prints what OpenCloud says about refused input: the field, accepted values, aliases and each refused field", () => {
    const surface = structuredCliError(new ApiError(400, {
      code: "LOG_SURFACE_UNKNOWN",
      message: 'Unknown log surface "edge": use function, container, http, ai or platform (runtime, the older name for function, still works)',
      details: { field: "surface", allowed: ["function", "container", "http", "ai", "platform"], aliases: { functions: "function", runtime: "function", containers: "container" } },
    }));
    expect(surface.error).toMatchObject({
      code: "LOG_SURFACE_UNKNOWN", status: 400, retryable: false,
      details: { field: "surface", allowed: ["function", "container", "http", "ai", "platform"], aliases: { functions: "function", runtime: "function", containers: "container" } },
    });
    const malformed = structuredCliError(new ApiError(400, {
      code: "invalid_request",
      message: "Request validation failed: query.limit: Too big: expected number to be <=100",
      details: { fields: [{ field: "query.limit", code: "too_big", message: "Too big: expected number to be <=100" }, { field: "body", message: "Bearer oc_owner_do-not-print-0123456789" }, { nope: 1 }] },
    }));
    expect(malformed.error.details).toEqual({ fields: [
      { field: "query.limit", code: "too_big", message: "Too big: expected number to be <=100" },
      { field: "body", message: "[REDACTED]" },
    ] });
    // The CLI login's owner-only refusal: OpenCloud's next step is the hint.
    const owner = structuredCliError(new ApiError(403, {
      code: "OWNER_ACTION_BROWSER_ONLY",
      message: "This credential can manage the app but can't run owner-only actions on the live app.",
      details: { appId: "11111111-1111-4111-8111-111111111111", suggestedFix: "Do this in the app or on its page in the dashboard, or ask the owner to approve an app access token for a script: opencloud app access-token request 11111111-1111-4111-8111-111111111111 --name <name>" },
    }));
    expect(owner.error).toMatchObject({ code: "OWNER_ACTION_BROWSER_ONLY", status: 403, hint: expect.stringMatching(/^Do this in the app or on its page/) });
    expect(owner.error).not.toHaveProperty("details");
  });

  it("names the unresolved journal entry and a hint added for the failure", () => {
    const pending = {
      command: "opencloud app dev start" as const, idempotencyKey: "ocj1:f96d3c45-0000-4000-8000-000000000001", generatedKey: true,
      state: "attempted" as const, appId: "11111111-1111-4111-8111-111111111111", draftId: "22222222-2222-4222-8222-222222222222", revision: 3,
    };
    const failure = withHint(new MutationJournalError("MUTATION_IN_PROGRESS", "An earlier request has not finished.", true, pending), "Run it again.");
    expect(structuredCliError(failure).error).toEqual({
      code: "MUTATION_IN_PROGRESS", message: "An earlier request has not finished.", retryable: true, pending, hint: "Run it again.",
    });
    // A hint added for this failure replaces OpenCloud's generic one in place.
    const refused = withHint(new ApiError(409, { code: "ACTIVE_DEPLOYMENT_CHANGED", details: {} }), "Run `opencloud app dev stop .` first.");
    const error = structuredCliError(refused).error;
    expect(error.hint).toBe("Run `opencloud app dev stop .` first.");
    expect(Object.keys(error)).toEqual(["code", "message", "status", "hint", "retryable"]);
    // Malformed journal coordinates are dropped rather than printed.
    expect(structuredCliError(new MutationJournalError("MUTATION_IN_PROGRESS", "x", true, { ...pending, idempotencyKey: "has spaces" })).error)
      .not.toHaveProperty("pending");
  });

  it("quotes the answer's x-request-id when the error body has none", () => {
    const fromHeader = structuredCliError(
      apiErrorFromResponse(
        new Response(null, { status: 502, headers: { "x-request-id": "cli-header-id" } }),
        "<html>Bad gateway</html>",
      ),
    );
    expect(fromHeader.error).toEqual({
      code: "HTTP_502",
      message: "OpenCloud API returned HTTP 502",
      status: 502,
      retryable: true,
      requestId: "cli-header-id",
    });
    const fromBody = structuredCliError(
      apiErrorFromResponse(
        new Response(null, { status: 500, headers: { "x-request-id": "header-id" } }),
        { message: "failed", requestId: "body-id" },
      ),
    );
    expect(fromBody.error.requestId).toBe("body-id");
  });

  it("keeps a network failure's cause code and request ID", async () => {
    const refused = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:4010 Bearer oc_owner_do-not-leak"),
      { code: "ECONNREFUSED" },
    );
    const failure = new TypeError("fetch failed", { cause: refused });
    await expect(
      withCliHeaders(async () => {
        throw failure;
      })("https://api.example.test/v1/apps"),
    ).rejects.toBe(failure);
    const output = structuredCliError(failure);
    expect(output.error).toMatchObject({
      code: "CLI_ERROR",
      message: "fetch failed",
      retryable: false,
      cause: {
        code: "ECONNREFUSED",
        message: "connect ECONNREFUSED 127.0.0.1:4010 [REDACTED]",
      },
      requestId: expect.stringMatching(/^cli-/),
    });
    // Several addresses fail as one AggregateError without a message.
    const aggregate = Object.assign(
      new AggregateError([new Error("connect ECONNREFUSED ::1:4010")], ""),
      { code: "ECONNREFUSED" },
    );
    expect(
      structuredCliError(new TypeError("fetch failed", { cause: aggregate })).error.cause,
    ).toEqual({ code: "ECONNREFUSED", message: "connect ECONNREFUSED ::1:4010" });
    expect(structuredCliError(new Error("plain")).error).toEqual({
      code: "CLI_ERROR",
      message: "plain",
      retryable: false,
    });
  });
});
