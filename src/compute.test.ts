import { describe, expect, it } from "vitest";
import { classifyComputeError } from "@opencloud/contracts/containers";
import { ApiError, OpenCloudClient } from "./api-client.js";
import { computeInput, computeJson, computeKey, computeLogBody, computeQuery } from "./compute.js";
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
