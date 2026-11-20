import { describe, expect, it } from "vitest";
import { classifyComputeError } from "@opencloud/contracts/containers";
import { ApiError, OpenCloudClient } from "./api-client.js";
import { computeInput, computeJson, computeKey, computeLogBody, computeQuery, controlGeneration, logSurface, workerReplicas } from "./compute.js";
import { isReportableFailure } from "./error-reports.js";
import { structuredCliError } from "./owner-parity.js";
import { computeInstanceDiagnosticsSchema } from "../vendor/contracts/src/compute-observation.js";

const now = "2026-11-19T12:00:00.000Z";
const usage = {
  quantities: { vcpuSeconds: "0", memoryGiBSeconds: "0", scratchGiBSeconds: "0" }, currency: null, grossEstimatedCostMinor: null,
  appliedCreditMinor: null, netEstimatedCostMinor: null, priceVersionIds: [], pendingEvidenceCount: 0, lastSettledAt: null, observedAt: now,
};

/** One execution as the platform's read API returns it. */
function execution(fields: Record<string, unknown>) {
  return {
    executionId: "11111111-1111-4111-8111-111111111111", workloadName: "thumbnailer", revisionId: "22222222-2222-4222-8222-222222222222",
    environment: "production", developmentSessionId: null, state: "queued", waitReason: null, acceptedAt: now,
    queueDeadline: "2026-11-19T12:30:00.000Z", statusUrl: "/v1/apps/x/container-executions/y", attempt: 0, startedAt: null,
    finishedAt: null, executionDeadline: null, phaseDeadline: null, error: null, outputFileIds: [],
    completionDelivery: { state: "not_configured", attempts: 0, lastAttemptAt: null, nextAttemptAt: null, error: null }, usage,
    ...fields,
  };
}

function answering(body: unknown) {
  return new OpenCloudClient({
    apiUrl: "https://api.example.test", token: "synthetic-compute-reader",
    fetch: async () => Response.json(body),
  });
}

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
describe("compute command boundaries", () => {
  it("preserves terminal resource measurement times through the public snapshot", () => {
    const measuredAt = "2026-11-14T00:00:00Z", terminalAt = "2026-11-14T00:00:30Z";
    const diagnostics = { freshness: { status: "partial", observedAt: terminalAt, lagSeconds: 0, truncated: false },
      sample: { observedAt: terminalAt, cpuUsageNs: "1000000000", memoryBytes: "4096", peakMemoryBytes: "8192", scratchBytes: "1024",
        network: { ingressBytes: null, egressBytes: null, coverage: "unavailable" },
        sampling: { phase: "terminal", cpuObservedAt: measuredAt, memoryObservedAt: measuredAt, peakMemoryObservedAt: measuredAt,
          scratchObservedAt: terminalAt, networkObservedAt: null } } };
    expect(computeInstanceDiagnosticsSchema.parse(diagnostics)).toEqual(diagnostics);
    expect(computeInstanceDiagnosticsSchema.safeParse({ ...diagnostics, sample: { ...diagnostics.sample, sampling: undefined } }).success).toBe(true);
  });

  it("pins a job submission to its environment and canonical input file set", () => {
    const input = { appId: id, name: "job", body: { input: computeJson('{"hello":"world"}'), inputFileIds: [id] } };
    expect(computeInput("submitContainerJob", input).body.input).toEqual({ hello: "world" });
    for (const bad of [{ ...input, sessionId: id }, { ...input, body: { image: "override" } }, { ...input, body: { inputFileIds: [id,id] } }]) {
      expect(() => computeInput("submitContainerJob", bad)).toThrow();
    }
    expect(() => computeInput("submitDevContainerJob", input)).toThrow();
    expect(computeInput("submitDevContainerJob", { ...input, sessionId: id }).sessionId).toBe(id);
    expect(() => computeKey("unsafe key")).toThrow();
    expect(computeKey("stable-key-1")).toBe("stable-key-1");
  });
  it("validates independent workload and execution filters and control generations", () => {
    expect(computeInput("listContainers", { appId: id, query: computeQuery({ state: "crash_loop" }) }).query?.state).toBe("crash_loop");
    expect(() => computeInput("listContainerExecutions", { appId: id, query: computeQuery({ state: "crash_loop" }) })).toThrow();
    for (const body of [{ expectedGeneration: 0, replicas: 1 }, { expectedGeneration: 1, replicas: 21 }, { expectedGeneration: 1.5, replicas: 1 }]) {
      expect(() => computeInput("scaleContainer", { appId: id, name: "worker", body })).toThrow();
    }
  });
  it("filters logs by the platform's surface names and plurals, refusing anything else before a request", () => {
    for (const name of ["function", "container", "http", "ai", "platform"]) expect(logSurface(name)).toBe(name);
    expect(logSurface(" Functions ")).toBe("function");
    // The older name for Function lines, which the published guide and earlier CLIs use.
    expect(logSurface("runtime")).toBe("function");
    expect(logSurface("Runtime")).toBe("function");
    expect(logSurface("containers")).toBe("container");
    for (const unknown of ["edge", "runtimes", "functionz", "__proto__", "constructor", "http.log.access.log0"]) {
      expect(() => logSurface(unknown)).toThrowError(expect.objectContaining({
        code: "LOG_SURFACE_UNKNOWN",
        message: `Unknown log surface ${JSON.stringify(unknown)}: use function, container, http, ai or platform (runtime, the older name for function, still works)`,
      }));
    }
    // The same details the platform answers with, printed with the error.
    let refusal: unknown;
    try { logSurface("edge"); } catch (error) { refusal = error; }
    expect(structuredCliError(refusal).error).toMatchObject({
      code: "LOG_SURFACE_UNKNOWN",
      details: { field: "surface", allowed: ["function", "container", "http", "ai", "platform"],
        aliases: { functions: "function", runtime: "function", containers: "container" } },
    });
    expect(computeLogBody({ from: "2026-01-01T00:00:00Z", to: "2026-01-01T01:00:00Z", surface: "functions" }).surface).toBe("function");
  });

  it("binds log filters without exposing another environment selector", () => {
    const body = computeLogBody({ from: "2026-01-01T00:00:00Z", to: "2026-01-01T01:00:00Z", workload: "job", execution: id, cursor: "opaque+/=" });
    expect(computeInput("queryDevLogsPage", { appId: id, sessionId: id, body }).body.executionId).toBe(id);
    expect(() => computeInput("queryLogsPage", { appId: id, body: { ...body, developmentSessionId: id } })).toThrow();
  });
  it("reports trusted platform faults while preserving expected policy and app failures", () => {
    for (const code of ["COMPUTE_STARTING_PENDING", "COMPUTE_REQUEST_TIMEOUT", "COMPUTE_BILLING_UNAVAILABLE"] as const) {
      const value = classifyComputeError(code);
      expect(isReportableFailure(new ApiError(value.statusCode, value))).toBe(false);
    }
    const value = classifyComputeError("COMPUTE_METER_CONFLICT");
    expect(isReportableFailure(new ApiError(value.statusCode, value))).toBe(true);
    const override = classifyComputeError("COMPUTE_STARTUP_FAILED", { origin: "platform" });
    expect(isReportableFailure(new ApiError(override.statusCode, override))).toBe(true);
    expect(isReportableFailure(new ApiError(503, "Unknown"))).toBe(true);
  });

  it("reads why a waiting job has not started and the exit code of a failed one", async () => {
    const input = { appId: "11111111-1111-4111-8111-111111111111", executionId: "11111111-1111-4111-8111-111111111111" };
    const waiting = await answering(execution({ waitReason: "host_unavailable" })).call("getContainerExecution", input);
    expect(waiting.waitReason).toBe("host_unavailable");
    const exited = classifyComputeError("COMPUTE_EXIT_NONZERO", { exitCode: 3 });
    const failed = await answering(execution({ state: "failed", attempt: 1, finishedAt: now, error: exited })).call("getContainerExecution", input);
    expect(failed.error?.details.exitCode).toBe(3);
    expect(failed.waitReason).toBeNull();
  });

  it("says an answer from another API version does not match, instead of blaming the input", async () => {
    const { waitReason: _omitted, ...older } = execution({});
    const input = { appId: "11111111-1111-4111-8111-111111111111", executionId: "11111111-1111-4111-8111-111111111111" };
    const failure = await answering(older).call("getContainerExecution", input).catch((error: unknown) => error);
    const error = structuredCliError(failure).error;
    expect(error).toMatchObject({ code: "API_CONTRACT_MISMATCH", retryable: false, issues: [{ path: "waitReason" }] });
    expect(error.message).toMatch(/^OpenCloud's answer to getContainerExecution has 1 problem: waitReason: must be one of "no_capacity", /);
    expect(error.message).toMatch(/\. This CLI and the OpenCloud API may be different versions\.$/);
    expect(isReportableFailure(failure)).toBe(true);
    // Invalid input is still the caller's, refused before any request.
    await expect(answering(older).call("getContainerExecution", { ...input, executionId: "not-an-id" })).rejects.toMatchObject({ name: "ZodError" });
  });

  it("reads a job that never created its output directory, and keeps a Function's error status on a capability answer", async () => {
    const input = { appId: "11111111-1111-4111-8111-111111111111", executionId: "11111111-1111-4111-8111-111111111111" };
    const missing = classifyComputeError("COMPUTE_OUTPUT_DIRECTORY_MISSING");
    const failed = await answering(execution({ state: "failed", attempt: 1, finishedAt: now, error: missing })).call("getContainerExecution", input);
    expect(failed.error).toMatchObject({ code: "COMPUTE_OUTPUT_DIRECTORY_MISSING", details: { origin: "app", phase: "collecting" } });
    const upstream = classifyComputeError("COMPUTE_FUNCTION_FAILED", { upstreamStatus: 500 });
    const failure = new ApiError(upstream.statusCode, { ...upstream, requestId: "request-2" });
    expect(structuredCliError(failure).error).toMatchObject({
      code: "COMPUTE_FUNCTION_FAILED", status: 502, retryable: false, details: { upstreamStatus: 500, origin: "app" },
    });
    // A Function's own error, a container's metric mistake or an installation
    // without containers is the app's or policy's, never a platform fault.
    for (const code of ["COMPUTE_FUNCTION_FAILED", "COMPUTE_METRIC_INVALID", "COMPUTE_METRIC_LIMIT", "COMPUTE_NOT_OFFERED", "COMPUTE_OUTPUT_DIRECTORY_MISSING"] as const) {
      const value = classifyComputeError(code);
      expect(isReportableFailure(new ApiError(value.statusCode, value)), code).toBe(false);
    }
  });

  it("reads --generation and --replicas as plain digits, so an unset variable never scales to zero", () => {
    expect(workerReplicas("0")).toBe(0);
    expect(workerReplicas("20")).toBe(20);
    expect(workerReplicas(" 3 ")).toBe(3);
    expect(controlGeneration("3")).toBe(3);
    for (const typed of ["", " ", "0x2", "1e1", "2.0", "-1", "+2", "Infinity", "21"]) {
      expect(() => workerReplicas(typed), typed).toThrowError(expect.objectContaining({ code: "INVALID_OPTION", message: "--replicas must be an integer from 0 through 20" }));
    }
    for (const typed of ["", " ", "0", "0x3", "3e0", "3.5", undefined]) {
      expect(() => controlGeneration(typed), String(typed)).toThrowError(expect.objectContaining({ code: "INVALID_OPTION" }));
    }
  });

  it("reads a control change's receipt, which names the next generation and no operation", async () => {
    const receipt = { workloadName: "worker", generation: 5, acceptedAt: now };
    const app = "11111111-1111-4111-8111-111111111111";
    for (const operation of ["pauseContainer", "resumeContainer", "restartContainer"] as const) {
      expect(await answering(receipt).call(operation, { appId: app, name: "worker", body: { expectedGeneration: 4 } }, { idempotencyKey: "control-key-1" }))
        .toEqual(receipt);
    }
    expect(await answering(receipt).call("scaleContainer", { appId: app, name: "worker", body: { expectedGeneration: 4, replicas: 2 } }, { idempotencyKey: "control-key-2" }))
      .toEqual(receipt);
    expect(await answering(receipt).call("pauseDevContainer", { appId: app, sessionId: app, name: "worker", body: { expectedGeneration: 4 } }, { idempotencyKey: "control-key-3" }))
      .toEqual(receipt);
  });

  it("keeps the release, host and go-live codes structured, retryable as the catalog says", () => {
    for (const [code, status, retryable, reported] of [
      ["COMPUTE_NOT_LIVE", 503, true, false],
      ["COMPUTE_HOST_UNAVAILABLE", 503, true, true],
      ["COMPUTE_RELEASE_REPLACED", 409, false, false],
    ] as const) {
      const failure = new ApiError(status, { ...classifyComputeError(code), requestId: "request-1" });
      expect(structuredCliError(failure).error).toMatchObject({
        code, status, retryable, requestId: "request-1",
        details: expect.objectContaining({ retryable }),
      });
      expect(isReportableFailure(failure)).toBe(reported);
    }
  });
});
