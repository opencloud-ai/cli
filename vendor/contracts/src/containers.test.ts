import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest.js";
import { appRoutesSchema, compileAppRoutes, matchAppRoute, parseAppRouteRequest } from "./app-routes.js";
import {
  classifyComputeError, isExpectedComputeError, computeErrorCatalog, computeErrorSchema, computeJobSubmitRequestSchema,
  computePriceDefinitionSchema, containerDefinitionSchema, normalizeComputeResources,
  unsupportedComputeCapabilities, containerRuntimeServiceRequestSchema, containerRuntimeServiceResponseSchema,
  containerServiceRequestBodyBytes, computeExecutionSchema, computeRefusalPage,
} from "./containers.js";
import { installationCapabilitiesSchema } from "./installation.js";
import { resolvePlatformFeatureFlag } from "./feature-flags.js";

const appId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const image = "registry.test/team/example:release";
const job = { name: "batch", kind: "job", image, job: {} };
const service = { name: "web", kind: "service", image, service: { startupProbe: { path: "/ready" }, readinessProbe: { path: "/ready" } } };
const worker = { name: "poller", kind: "worker", image, worker: {} };
const base = { schemaVersion: 3, appId, frontend: { directory: "frontend" }, runtime: { sdk: { version: "2.7.0" } } };
const price = { key: "test", currency: "usd", taxBehavior: "exclusive", quantumSeconds: 1, minimumSeconds: 1, ratesMinorPerUnit: { vcpu_second: "0.004", gib_memory_second: "0.0002", gib_scratch_second: "0" }, effectiveFrom: "2026-12-01T00:00:00Z" };

describe("container manifest contracts", () => {
  it("keeps existing schema-2/3 manifests readable without injecting containers", () => {
    expect(parseManifest(base)).not.toHaveProperty("containers");
    expect(parseManifest({ ...base, schemaVersion: 2, version: "legacy" })).not.toHaveProperty("containers");
    expect(() => parseManifest({ ...base, schemaVersion: 2, version: "legacy", containers: [job] })).toThrow();
  });
  it("normalizes all kinds and their documented defaults", () => {
    const manifest = parseManifest({ ...base, containers: [job, service, worker] });
    expect(manifest.schemaVersion).toBe(3);
    if (manifest.schemaVersion !== 3) return;
    expect(manifest.containers?.map(entry => entry.resources)).toEqual(Array.from({ length: 3 }, () => ({ cpu: 1, memoryGiB: 2, scratchGiB: 1 })));
    expect(manifest.containers?.[0]).toMatchObject({ job: { timeoutSeconds: 900, queueTimeoutSeconds: 86400, concurrency: 1, maxAttempts: 1, retryExitCodes: [] } });
    expect(manifest.containers?.[1]).toMatchObject({ service: { port: 8080, concurrency: 20, drainTimeoutSeconds: 30, scaling: { minInstances: 0, maxInstances: 5 } } });
    expect(manifest.containers?.[2]).toMatchObject({ worker: { replicas: 1, maxReplicas: 1, restart: "always" } });
    expect(normalizeComputeResources({ cpu: 2, memoryGiB: 4, scratchGiB: 10 })).toEqual({ vcpu: 2, memoryMib: 4096, scratchMib: 10240 });
  });
  it("requires exactly one strict kind-specific object and unique bounded names", () => {
    for (const definition of [{ ...job, job: undefined }, { ...job, worker: {} }, { ...job, kind: "daemon" }, { ...worker, privileged: true }, { ...worker, worker: { replicas: 21 } }, { ...service, service: { ...service.service, scaling: { minInstances: 2, maxInstances: 1 } } }]) expect(containerDefinitionSchema.safeParse(definition).success).toBe(false);
    expect(() => parseManifest({ ...base, containers: [job, job] })).toThrow();
    expect(() => parseManifest({ ...base, containers: Array.from({ length: 11 }, (_, i) => ({ ...job, name: `job-${i}` })) })).toThrow();
  });
  it("derives worker ceilings including replicas zero and rejects scaling beyond a ceiling", () => {
    expect(containerDefinitionSchema.parse({ ...worker, worker: { replicas: 0 } })).toMatchObject({ worker: { replicas: 0, maxReplicas: 1 } });
    expect(containerDefinitionSchema.parse({ ...worker, worker: { replicas: 5 } })).toMatchObject({ worker: { replicas: 5, maxReplicas: 5 } });
    expect(containerDefinitionSchema.safeParse({ ...worker, worker: { replicas: 2, maxReplicas: 1 } }).success).toBe(false);
  });
  it("enforces resource classes, bounded UTF-8 commands and normalized configuration", () => {
    for (const resources of [{ cpu: 3 }, { memoryGiB: 3 }, { scratchGiB: 4 }, { cpu: 16 }, { gpu: 1 }]) expect(containerDefinitionSchema.safeParse({ ...job, resources }).success).toBe(false);
    expect(containerDefinitionSchema.safeParse({ ...job, command: ["🚀".repeat(1_025)] }).success).toBe(false);
    expect(containerDefinitionSchema.safeParse({ ...job, args: Array(129).fill("x") }).success).toBe(false);
    expect(containerDefinitionSchema.safeParse({ ...job, env: { HUGE: "x".repeat(65_536) } }).success).toBe(false);
    expect(containerDefinitionSchema.safeParse({ ...job, command: ["a\0b"] }).success).toBe(false);
  });
  it("protects platform environment names and declared secret references", () => {
    for (const name of ["PORT", "OPENCLOUD_TOKEN", "SUPABASE_KEY"]) expect(containerDefinitionSchema.safeParse({ ...job, env: { [name]: "value" } }).success).toBe(false);
    expect(containerDefinitionSchema.safeParse({ ...job, secrets: { TOKEN: "third-party-key" } }).success).toBe(false);
    expect(containerDefinitionSchema.safeParse({ ...job, env: { TOKEN: "x" }, secrets: { TOKEN: "KEY" } }).success).toBe(false);
    expect(() => parseManifest({ ...base, containers: [{ ...job, secrets: { TOKEN: "KEY" } }] })).toThrow();
    expect(() => parseManifest({ ...base, secrets: { KEY: "required" }, containers: [{ ...job, secrets: { TOKEN: "KEY" } }] })).not.toThrow();
  });
  it("requires declared system Functions and declared metrics for capabilities/completion", () => {
    const workload = { ...job, permissions: { functions: ["save"], metrics: ["processed_items"] }, job: { onComplete: "save" } };
    const manifest = { ...base, containers: [workload], functions: [{ name: "save", entrypoint: "functions/save.ts", access: "system" }], observability: { metrics: [{ name: "processed_items", type: "counter" }] } };
    expect(() => parseManifest(manifest)).not.toThrow();
    expect(() => parseManifest({ ...manifest, functions: [{ ...manifest.functions[0], access: "user" }] })).toThrow();
    expect(() => parseManifest({ ...manifest, observability: undefined })).toThrow();
  });
  it("rejects unsafe output directories and unsupported probes", () => {
    for (const directory of ["/work", "/work/inputs", "/work/inputs/out", "/work/../etc", "/work/out/", "/tmp/out", "/work/%2e%2e/etc"]) expect(containerDefinitionSchema.safeParse({ ...job, job: { outputs: { directory, maxFiles: 1, maxTotalGiB: 1 } } }).success).toBe(false);
    for (const path of ["//example.test/ready", "/../ready", "/%2e%2e/ready", "https://example.test", "/ready?x=1"]) expect(containerDefinitionSchema.safeParse({ ...service, service: { ...service.service, startupProbe: { path } } }).success).toBe(false);
    expect(containerDefinitionSchema.safeParse({ ...service, service: { ...service.service, livenessProbe: { exec: ["true"] } } }).success).toBe(false);
    expect(containerDefinitionSchema.safeParse({ ...job, job: { outputs: { directory: "/work/out", maxFiles: 1, maxTotalGiB: 2 } } }).success).toBe(false);
  });
  it("routes only to services and keeps frontend alternatives exclusive", () => {
    expect(() => parseManifest({ ...base, frontend: { container: "web" }, containers: [service] })).not.toThrow();
    for (const frontend of [{ container: "batch" }, { container: "web", directory: "frontend" }, { container: "web", build: { script: "build" } }]) expect(() => parseManifest({ ...base, frontend, containers: [service, job] })).toThrow();
    expect(() => parseManifest({ ...base, containers: [job], routes: [{ id: "api", path: "/api", container: "batch", methods: ["GET"] }] })).toThrow();
    expect(() => parseManifest({ ...base, health: { path: "/api" }, containers: [service], routes: [{ id: "api", path: "/api", container: "web", methods: ["GET"] }] })).toThrow();
    expect(() => parseManifest({ ...base, frontend: { container: "web" }, containers: [service], routes: [{ id: "icon", path: "/icon", asset: "icon.png" }] })).toThrow();
  });
  it("adds OPTIONS only for container routes, preserving grammar, root and reserved namespaces", () => {
    const route = { id: "api", path: "/api/*path", container: "web", methods: ["OPTIONS", "GET"] };
    const table = compileAppRoutes(appRoutesSchema.parse([route]));
    expect(matchAppRoute(table, parseAppRouteRequest("/api/users?x=1", "OPTIONS"))).toMatchObject({ kind: "matched", params: { path: ["users"] } });
    for (const path of ["/", "/_opencloud/*path", "/api{/*path}"]) expect(appRoutesSchema.safeParse([{ ...route, path }]).success).toBe(false);
    expect(appRoutesSchema.safeParse([{ id: "asset", path: "/asset", asset: "a", methods: ["GET", "HEAD", "OPTIONS"] }]).success).toBe(false);
    expect(appRoutesSchema.safeParse([{ id: "fn", path: "/fn", function: "fn", methods: ["OPTIONS"] }]).success).toBe(false);
    expect(appRoutesSchema.safeParse([{ ...route, access: "public" }]).success).toBe(false);
  });
  it("defaults new installation modes and the feature flag off", () => {
    const capabilities = installationCapabilitiesSchema.parse({}).compute;
    expect(capabilities).toEqual({ jobs: false, services: false, workers: false, containerFrontend: false });
    expect(resolvePlatformFeatureFlag("container-compute", {})).toEqual({ enabled: false, source: "default" });
    expect(unsupportedComputeCapabilities({ frontend: { container: "web" }, containers: [containerDefinitionSchema.parse(service)] }, capabilities)).toEqual(["services", "containerFrontend"]);
  });
});

describe("compute API errors and money", () => {
  it("validates full-size service bodies without a regex stack and bounds decoded bytes", () => {
    const maximumBytes = 4 * 1024 * 1024;
    expect(containerServiceRequestBodyBytes).toBe(maximumBytes);
    // The response is framed raw bytes (no Base64): its head bounds the declared length.
    expect(containerRuntimeServiceResponseSchema.safeParse({ status: 200, headers: {}, bodyBytes: 32 * 1024 * 1024 }).success).toBe(true);
    expect(containerRuntimeServiceResponseSchema.safeParse({ status: 200, headers: {}, bodyBytes: 32 * 1024 * 1024 + 1 }).success).toBe(false);
    const bytes = Buffer.alloc(maximumBytes + 1, 255);
    const bodyBase64 = bytes.subarray(0, maximumBytes).toString("base64");
    expect(containerRuntimeServiceRequestSchema.safeParse({ name: "web", path: "/", bodyBase64 }).success).toBe(true);
    const oversized = bytes.toString("base64");
    expect(oversized.length).toBe(bodyBase64.length);
    const result = containerRuntimeServiceRequestSchema.safeParse({ name: "web", path: "/", bodyBase64: oversized });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual([expect.objectContaining({ code: "too_big", path: ["bodyBase64"], maximum: maximumBytes, message: "Decoded body exceeds 4 MiB" })]);
    const malformed = containerRuntimeServiceRequestSchema.safeParse({ name: "web", path: "/", bodyBase64: `${bodyBase64.slice(0, -1)}?` });
    expect(malformed.success).toBe(false);
    if (!malformed.success) expect(malformed.error.issues).toEqual([expect.objectContaining({ code: "custom", path: ["bodyBase64"] })]);
  });
  it("keeps service bodies canonical across alphabet, padding, length and unused bits", () => {
    for (const bodyBase64 of ["", "AA==", "AAA=", "AAAA", "/w==", "//8=", "+/8=", Buffer.from(Array.from({ length: 256 }, (_, value) => value)).toString("base64")]) {
      expect(containerRuntimeServiceRequestSchema.safeParse({ name: "web", path: "/", bodyBase64 }).success, bodyBase64).toBe(true);
    }
    for (const bodyBase64 of ["A", "AA", "AA=", "AA===", "=AAA", "AA=A", "====", "AB==", "AAB=", "AA_A", "AA-A", "AAAA\n", " AAA", "AAAé"]) {
      expect(containerRuntimeServiceRequestSchema.safeParse({ name: "web", path: "/", bodyBase64 }).success, bodyBase64).toBe(false);
    }
    expect(containerRuntimeServiceRequestSchema.safeParse({ name: "web", path: "/" }).success).toBe(true);
  });

  it("keeps every error stable and refuses unsafe detail fields", () => {
    for (const code of Object.keys(computeErrorCatalog) as (keyof typeof computeErrorCatalog)[]) {
      expect(computeErrorSchema.safeParse(classifyComputeError(code)).success).toBe(true);
    }
    const failure = classifyComputeError("COMPUTE_OUTCOME_UNKNOWN");
    expect(failure.details).toMatchObject({ retryable: false, retryScope: "observer_reconciliation", billingDisposition: "pending_evidence" });
    expect(computeErrorSchema.safeParse({ ...failure, details: { ...failure.details, hostPath: "/secret" } }).success).toBe(false);
    expect(computeErrorSchema.safeParse({ ...failure, statusCode: 500 }).success).toBe(false);
  });
  it("tells a container its credential is wrong apart from revoked authority", () => {
    // Missing, malformed or stale: the caller's to fix, by reading the file again.
    expect(classifyComputeError("COMPUTE_CAPABILITY_INVALID")).toMatchObject({
      statusCode: 401,
      details: { category: "authority", origin: "app", retryScope: "request", retryable: false, billingDisposition: "none" },
    });
    expect(isExpectedComputeError("COMPUTE_CAPABILITY_INVALID")).toBe(true);
    expect(classifyComputeError("COMPUTE_AUTHORITY_REVOKED").statusCode).toBe(403);
  });
  it("says why a waiting job has not started, from a small fixed set", () => {
    const usage = {
      quantities: { vcpuSeconds: "0", memoryGiBSeconds: "0", scratchGiBSeconds: "0" }, currency: null, grossEstimatedCostMinor: null,
      appliedCreditMinor: null, netEstimatedCostMinor: null, priceVersionIds: [], pendingEvidenceCount: 0, lastSettledAt: null,
      observedAt: "2026-11-19T12:00:00.000Z",
    };
    const execution = {
      executionId: "11111111-1111-4111-8111-111111111111", workloadName: "thumbnailer", revisionId: "22222222-2222-4222-8222-222222222222",
      environment: "production", developmentSessionId: null, state: "queued", waitReason: "host_unavailable",
      acceptedAt: "2026-11-19T12:00:00.000Z", queueDeadline: "2026-11-19T12:30:00.000Z", statusUrl: "/v1/apps/x/container-executions/y",
      attempt: 0, startedAt: null, finishedAt: null, executionDeadline: null, phaseDeadline: "2026-11-19T12:30:00.000Z", error: null,
      outputFileIds: [], completionDelivery: { state: "not_configured", attempts: 0, lastAttemptAt: null, nextAttemptAt: null, error: null }, usage,
    };
    expect(computeExecutionSchema.parse(execution).waitReason).toBe("host_unavailable");
    expect(computeExecutionSchema.parse({ ...execution, state: "running", waitReason: null }).waitReason).toBeNull();
    expect(computeExecutionSchema.safeParse({ ...execution, waitReason: "COMPUTE_NO_CAPACITY" }).success).toBe(false);
    const { waitReason: _omitted, ...withoutReason } = execution;
    expect(computeExecutionSchema.safeParse(withoutReason).success).toBe(false);
  });
  it("says another release replaced this one: a waiting job was cancelled, a stopping copy's Function call refused", () => {
    expect(classifyComputeError("COMPUTE_RELEASE_REPLACED")).toMatchObject({
      statusCode: 409,
      details: { category: "configuration", origin: "policy", phase: "admission", retryable: false, billingDisposition: "none" },
    });
    const message = classifyComputeError("COMPUTE_RELEASE_REPLACED").message;
    expect(message).toMatch(/replaced this one\. A job still waiting to start on it was cancelled/);
    expect(message).toMatch(/copy of it is stopping and can no longer call Functions/);
    // The customer's own release change: never a platform fault.
    expect(isExpectedComputeError("COMPUTE_RELEASE_REPLACED")).toBe(true);
  });
  it("tells a host that is down apart from hosts that are full, both worth a retry", () => {
    for (const code of ["COMPUTE_HOST_UNAVAILABLE", "COMPUTE_NO_CAPACITY"] as const)
      expect(classifyComputeError(code)).toMatchObject({
        statusCode: 503,
        details: { category: "capacity", origin: "platform", phase: "admission", retryable: true, billingDisposition: "none" },
      });
    expect(classifyComputeError("COMPUTE_HOST_UNAVAILABLE").message).toMatch(/No compute host is available/);
    expect(classifyComputeError("COMPUTE_NO_CAPACITY").message).toMatch(/full/);
  });
  it("tells a new release's copy to retry until it goes live, unlike revoked authority", () => {
    // Decision 19: refused before the deploy or sync switches, but retryable.
    expect(classifyComputeError("COMPUTE_NOT_LIVE")).toMatchObject({
      statusCode: 503,
      details: { category: "authority", origin: "policy", phase: "startup", retryScope: "request", retryable: true, billingDisposition: "none" },
    });
    expect(isExpectedComputeError("COMPUTE_NOT_LIVE")).toBe(true);
    expect(classifyComputeError("COMPUTE_AUTHORITY_REVOKED").details.retryable).toBe(false);
  });
  it("rejects runtime overrides and oversized inputs, normalizing file selection", () => {
    expect(computeJobSubmitRequestSchema.parse({})).toEqual({ input: {}, inputFileIds: [] });
    expect(computeJobSubmitRequestSchema.safeParse({ input: {}, image }).success).toBe(false);
    expect(computeJobSubmitRequestSchema.safeParse({ input: "x".repeat(65_536) }).success).toBe(false);
    expect(computeJobSubmitRequestSchema.safeParse({ inputFileIds: [appId, appId] }).success).toBe(false);
  });
  it("preserves request size statuses without granting replay or blaming the platform", () => {
    for (const [code, statusCode] of [["COMPUTE_REQUEST_TOO_LARGE", 413], ["COMPUTE_REQUEST_HEADERS_TOO_LARGE", 431]] as const) {
      const failure = classifyComputeError(code);
      expect(failure).toMatchObject({ statusCode, details: { origin: "app", phase: "ingress", retryable: false, retryScope: "none", billingDisposition: "confirmed_usage" } });
      expect(isExpectedComputeError(code)).toBe(true);
      expect(computeErrorSchema.parse({ ...failure, requestId: "compute-contracts-size-limit" }).requestId).toBe("compute-contracts-size-limit");
      expect(computeErrorSchema.safeParse({ ...failure, statusCode: 422 }).success).toBe(false);
    }
  });
  it("requires every precise price and fixed quantum, preserving explicit zeros", () => {
    expect(computePriceDefinitionSchema.parse(price).ratesMinorPerUnit.gib_scratch_second).toBe("0");
    for (const value of [0.004, "-1", "1e-3", "NaN", "0.0000000000001"]) expect(computePriceDefinitionSchema.safeParse({ ...price, ratesMinorPerUnit: { ...price.ratesMinorPerUnit, vcpu_second: value } }).success).toBe(false);
    expect(computePriceDefinitionSchema.safeParse({ ...price, ratesMinorPerUnit: { vcpu_second: "0" } }).success).toBe(false);
    expect(computePriceDefinitionSchema.safeParse({ ...price, quantumSeconds: 60 }).success).toBe(false);
  });
});

describe("the page a site visitor gets for a compute refusal", () => {
  it("tells the visitor plainly whether waiting helps, keeps the builder's message out, and escapes the request ID", () => {
    const paused = computeRefusalPage({ statusCode: 503, code: "COMPUTE_SERVICE_UNAVAILABLE", details: { retryable: false } }, "<id-1>");
    expect(paused).toContain("<h1>This site isn't available right now</h1><p>Please try again later.</p>");
    expect(paused).toContain("COMPUTE_SERVICE_UNAVAILABLE · &#60;id-1&#62;");
    expect(paused).not.toMatch(/<script|<form|<a |OpenCloud|containers get|service web/);
    expect(computeRefusalPage({ statusCode: 503, code: "COMPUTE_STARTING_PENDING", details: { retryable: true } }, "id-2")).toContain("Please try again in a moment.");
    expect(computeRefusalPage({ statusCode: 429, code: "COMPUTE_CONCURRENCY_EXCEEDED" }, "id-3")).toContain("<h1>This site is busy right now</h1><p>Please try again in a moment.</p>");
  });
});
