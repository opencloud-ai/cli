import { describe, expect, it } from "vitest";
import { classifyComputeError } from "@opencloud/contracts/containers";
import { ApiError } from "./api-client.js";
import { computeInput, computeJson, computeKey, computeLogBody, computeQuery } from "./compute.js";
import { isReportableFailure } from "./error-reports.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
describe("compute command boundaries", () => {
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
