import { describe, expect, it } from "vitest";
import { parseManifest } from "@opencloud/contracts";
import { computeInput } from "./compute.js";
import { structuredCliError } from "./owner-parity.js";
import { isZodError, issuePath, issueSummary, readableIssues } from "./readable-issues.js";

const base = {
  schemaVersion: 3, appId: "11111111-1111-4111-8111-111111111111", frontend: { directory: "frontend" },
  runtime: { sdk: { version: "2.8.0" } }, files: { access: "user", maxUploadBytes: 1_000 },
  migrations: [], functions: [], queues: [], cron: [], health: { path: "/" }, secrets: {},
};
const image = `registry.example.test/team/app@sha256:${"a".repeat(64)}`;
const probes = { startupProbe: { path: "/ready" }, readinessProbe: { path: "/ready" } };

function problems(manifest: Record<string, unknown>) {
  try {
    parseManifest({ ...base, ...manifest });
  } catch (error) {
    if (!isZodError(error)) throw error;
    return readableIssues(error.issues);
  }
  throw new Error("The manifest parsed");
}

describe("readable manifest problems", () => {
  it("names the allowed values of an enum, a literal union and a discriminator", () => {
    expect(problems({ containers: [{ name: "r", kind: "service", image, resources: { cpu: 3 }, service: probes }] }))
      .toEqual([{ path: "containers[0].resources.cpu", message: "must be one of 1, 2, 4, 8" }]);
    expect(problems({ containers: [{ name: "w", kind: "worker", image, egress: "all", worker: {} }] }))
      .toEqual([{ path: "containers[0].egress", message: 'must be one of "internet-http", "none"' }]);
    expect(problems({ containers: [{ name: "r", kind: "serivce", image }] }))
      .toEqual([{ path: "containers[0].kind", message: 'must be one of "job", "service", "worker"' }]);
  });

  it("says a fractional size must be whole and a missing field is required", () => {
    expect(problems({
      containers: [{ name: "j", kind: "job", image, resources: { scratchGiB: 5 }, job: { outputs: { directory: "/work/output", maxFiles: 2, maxTotalGiB: 0.5 } } }],
    })).toEqual([{ path: "containers[0].job.outputs.maxTotalGiB", message: "must be a whole number" }]);
    expect(problems({ containers: [{ name: "r", kind: "service", image, service: {} }] })).toEqual([
      { path: "containers[0].service.startupProbe", message: "is required" },
      { path: "containers[0].service.readinessProbe", message: "is required" },
    ]);
  });

  it("names unknown keys, limits and custom rules", () => {
    expect(problems({ containers: [{ name: "w", kind: "worker", image, worker: { replica: 1 } }] }))
      .toEqual([{ path: "containers[0].worker", message: 'has unknown key "replica"' }]);
    expect(problems({ containers: [{ name: "w", kind: "worker", image, worker: { replicas: 50 } }] }))
      .toEqual([{ path: "containers[0].worker.replicas", message: "must be at most 20" }]);
    expect(problems({ routes: [{ id: "render", path: "/render", container: "renderer", methods: ["POST"] }] }))
      .toEqual([{ path: "routes[0].container", message: "Container route must reference a declared service" }]);
  });

  it("follows the closest route form, or lists the forms told apart by their target", () => {
    expect(problems({ routes: [{ id: "x", path: "/x", function: "f", methods: ["FETCH"] }] }))
      .toEqual([{ path: "routes[0].methods[0]", message: 'must be one of "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"' }]);
    expect(problems({ routes: [{ id: "x", path: "/x" }] }))
      .toEqual([{ path: "routes[0]", message: "needs one of: asset; function and methods; container and methods" }]);
  });

  it("summarizes at most ten problems on one line", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ path: issuePath(["functions", index, "access"]), message: "is required" }));
    expect(issueSummary("opencloud.yaml", many.slice(0, 1))).toBe("opencloud.yaml has 1 problem: functions[0].access: is required");
    const summary = issueSummary("opencloud.yaml", many);
    expect(summary).toMatch(/^opencloud\.yaml has 12 problems: functions\[0\]\.access: is required; /);
    expect(summary).toMatch(/functions\[9\]\.access: is required; and 2 more$/);
    expect(issueSummary("opencloud.yaml", [{ path: "", message: 'has unknown key "name"' }]))
      .toBe('opencloud.yaml has 1 problem: top level: has unknown key "name"');
    expect(issuePath(["secrets", "MY-KEY", 0])).toBe("secrets.MY-KEY[0]");
    expect(issuePath(["env", "has space"])).toBe('env["has space"]');
  });
});

describe("structured Zod failures", () => {
  it("lists each problem instead of the issue tree", () => {
    let failure: unknown;
    try {
      computeInput("listContainers", { appId: "11111111-1111-4111-8111-111111111111", query: { limit: 101 } });
    } catch (error) {
      failure = error;
    }
    expect(structuredCliError(failure).error).toEqual({
      code: "CLI_ERROR",
      message: "The input has 1 problem: query.limit: must be at most 100",
      retryable: false,
      issues: [{ path: "query.limit", message: "must be at most 100" }],
    });
  });
});
