import { describe, expect, it } from "vitest";
import { classifyComputeError } from "@opencloud/contracts/containers";
import { ApiError } from "./api-client.js";
import { computeInput, computeJson, computeKey, computeLogBody, computeQuery } from "./compute.js";
import { isReportableFailure } from "./error-reports.js";
import { computeInstanceDiagnosticsSchema } from "../vendor/contracts/src/compute-observation.js";

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
});
