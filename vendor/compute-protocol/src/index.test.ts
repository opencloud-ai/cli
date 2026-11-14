import { describe, expect, it } from "vitest";
import {
  computeAcknowledgeUsageRequestSchema, computeCollectUsageResponseSchema,
  computeIngressGrantSchema, computeIngressCloseSchema, computeInputGrantSchema, computeInstanceBindingSchema,
  computeLaunchRequestSchema, computeLeaseSchema, computeLogEnvelopeSchema,
  computePinnedImageSchema, computeResourceAllocationSchema, computeUsageReportSchema,
  computeWorkerHelloSchema,
  canonicalComputeSignaturePayload,
  computeNetworkUsageObservationSchema, computeNetworkUsagePageSchema,
  computePrepareImageResponseSchema, computeLeaseRenewRequestSchema, computeResourceObservationSchema, CONTAINER_RUNTIME_ENV,
  computeImageFetchRequestSchema, computeResolveImageRequestSchema, computeReleaseImageRequestSchema,
  computeHttpObservationSchema,
} from "./index.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const binding = {
  installationId: id, workerId: id, workerBootId: id, appId: id,
  environment: "production" as const, developmentSessionId: null,
  revisionId: id, instanceId: id, generation: 1, launchId: `launch:${id}:1`, policyVersion: 1 as const,
};
const lease = {
  leaseId: id, leaseSequence: "1", issuedAt: "2026-11-13T12:00:00Z",
  expiresAt: "2026-11-13T12:00:30Z", killAfter: "2026-11-13T12:00:40Z",
  fundedUntil: "2026-11-13T12:00:45Z", signature: "x".repeat(64),
};
const allocation = { vcpu: 2, memoryMib: 4096, scratchMib: 10240 };
const sample = {
  protocolVersion: 1, binding, sourceSequence: "9007199254740993", eventType: "sample",
  allocation, allocationHash: "a".repeat(64), cumulativeElapsedNanoseconds: "1200000000",
  observedAt: "2026-11-13T12:00:02Z", processStartedAt: "2026-11-13T12:00:00Z",
  processStoppedAt: null, exitCode: null, signal: null,
};
const launch = {
  protocolVersion: 1, binding, workloadName: "example", kind: "job",
  imageDigest: `registry.test/team/example@sha256:${"a".repeat(64)}`,
  allocation, allocationHash: "a".repeat(64), egress: "none",
  startupTimeoutSeconds: 120, lease, executionDeadline: null, executionTimeoutSeconds: 900,
  networkAllowance: { allowanceId: id, bytes: "1000", expiresAt: lease.expiresAt, throughputMbitPerSecond: 100, signature: "a".repeat(64) },
  executionId: id, attempt: 1, replicaSlot: null,
};

describe("compute protocol authority and compatibility", () => {
  it("accepts only trusted terminal HTTP diagnostics without customer labels or content", () => {
    const value = { protocolVersion: 1, binding, requestId: "request-1", observedAt: lease.expiresAt,
      statusCode: null, queueMilliseconds: 1.5, durationMilliseconds: 300, outcome: "client_disconnect" };
    expect(computeHttpObservationSchema.safeParse(value).success).toBe(true);
    for (const bad of [{ ...value, workloadName: "forged" }, { ...value, path: "/private" },
      { ...value, queueMilliseconds: -1 }, { ...value, durationMilliseconds: Infinity }, { ...value, statusCode: 999 }]) {
      expect(computeHttpObservationSchema.safeParse(bad).success).toBe(false);
    }
  });
  it("requires caller-owned retention identity before resolving tags and pinned zero-reference release proof", () => {
    const resolve = { retentionId: id, sourceReference: "registry.test/example:mutable" };
    expect(computeResolveImageRequestSchema.safeParse(resolve).success).toBe(true);
    expect(computeImageFetchRequestSchema.safeParse(resolve).success).toBe(true);
    expect(computeImageFetchRequestSchema.safeParse({ sourceReference: resolve.sourceReference }).success).toBe(false);
    expect(computeReleaseImageRequestSchema.safeParse({ retentionId: id, imageDigest: launch.imageDigest, proofId: id }).success).toBe(true);
    expect(computeReleaseImageRequestSchema.safeParse({ retentionId: id, imageDigest: null, proofId: id }).success).toBe(true);
    expect(computeReleaseImageRequestSchema.safeParse({ retentionId: id, proofId: id }).success).toBe(false);
    expect(computeReleaseImageRequestSchema.safeParse({ retentionId: id, imageDigest: resolve.sourceReference, proofId: id }).success).toBe(false);
    expect(computeReleaseImageRequestSchema.safeParse({ retentionId: id, imageDigest: launch.imageDigest }).success).toBe(false);
    expect(computeReleaseImageRequestSchema.safeParse({ retentionId: id, imageDigest: null }).success).toBe(false);
  });
  it("canonicalizes signed authority independently of object order and omits only the outer signature", () => {
    const one = canonicalComputeSignaturePayload("opencloud.compute.v1.lease", binding, lease);
    const two = canonicalComputeSignaturePayload("opencloud.compute.v1.lease", binding, Object.fromEntries(Object.entries({ ...lease, signature: "different" }).reverse()));
    expect(one).toBe(two);
    expect(one).not.toContain("different");
    expect(one).not.toBe(canonicalComputeSignaturePayload("opencloud.compute.v1.network", binding, lease));
    expect(one).not.toBe(canonicalComputeSignaturePayload("opencloud.compute.v1.lease", { ...binding, generation: 2 }, lease));
    expect(() => canonicalComputeSignaturePayload("opencloud.compute.v1.lease", binding, { invalid: Infinity })).toThrow();
  });
  it("accepts only normalized whole resource allocations", () => {
    expect(computeResourceAllocationSchema.parse(allocation)).toEqual(allocation);
    for (const bad of [{ ...allocation, memoryMib: 1000 }, { ...allocation, vcpu: 0.5 }, { cpu: 2, memoryGiB: 4, scratchGiB: 10 }]) {
      expect(computeResourceAllocationSchema.safeParse(bad).success).toBe(false);
    }
  });
  it("requires exact development binding and rejects extra authority", () => {
    expect(computeInstanceBindingSchema.safeParse(binding).success).toBe(true);
    expect(computeInstanceBindingSchema.safeParse({ ...binding, environment: "development" }).success).toBe(false);
    expect(computeInstanceBindingSchema.safeParse({ ...binding, developmentSessionId: id }).success).toBe(false);
    expect(computeInstanceBindingSchema.safeParse({ ...binding, ownerToken: "secret" }).success).toBe(false);
  });
  it("requires digest pinning without URL credentials", () => {
    expect(computePinnedImageSchema.safeParse(launch.imageDigest).success).toBe(true);
    for (const bad of ["image:latest", "https://registry.test/image", `user:pass@registry.test/image@sha256:${"a".repeat(64)}`]) expect(computePinnedImageSchema.safeParse(bad).success).toBe(false);
  });
  it("accepts idempotent bounded job launches, not raw Docker policy", () => {
    expect(computeLaunchRequestSchema.parse(launch).binding.launchId).toBe(launch.binding.launchId);
    for (const bad of [{ ...launch, privileged: true }, { ...launch, mounts: ["/var/run/docker.sock"] }, { ...launch, protocolVersion: 2 }, { ...launch, service: { port: 8080 } }, { ...launch, executionId: null }]) expect(computeLaunchRequestSchema.safeParse(bad).success).toBe(false);
  });
  it("requires service probes and concurrency, never accepts job authority on workers", () => {
    const service = { ...launch, kind: "service", executionId: null, attempt: null, replicaSlot: 0, executionTimeoutSeconds: null,
      service: { port: 8080, concurrency: 20, startupProbe: { path: "/ready" }, readinessProbe: { path: "/ready", timeoutSeconds: 5 } } };
    expect(computeLaunchRequestSchema.safeParse(service).success).toBe(true);
    expect(computeLaunchRequestSchema.safeParse({ ...service, input: {} }).success).toBe(false);
    expect(computeLaunchRequestSchema.safeParse({ ...service, kind: "worker" }).success).toBe(false);
  });
  it("requires a job duration on the first start and retains the original deadline on retries", () => {
    expect(computeLaunchRequestSchema.safeParse({ ...launch, executionTimeoutSeconds: null }).success).toBe(false);
    expect(computeLaunchRequestSchema.safeParse({ ...launch, executionTimeoutSeconds: 1 }).success).toBe(true);
    expect(computeLaunchRequestSchema.safeParse({ ...launch, attempt: 2 }).success).toBe(false);
    expect(computeLaunchRequestSchema.safeParse({ ...launch, attempt: 2, executionDeadline: "2026-11-13T12:01:00Z" }).success).toBe(true);
  });
  it.each([
    { expiresAt: "2026-11-13T12:00:31Z" },
    { killAfter: "2026-11-13T12:00:41Z" },
    { fundedUntil: "2026-11-13T12:00:39Z" },
    { fundedUntil: "2026-11-13T12:00:46Z" },
  ])("rejects an unfunded or unbounded lease %j", invalid => {
    expect(computeLeaseSchema.safeParse({ ...lease, ...invalid }).success).toBe(false);
  });
  it("keeps file content generations lossless, with no storage location", () => {
    const grant = { fileId: id, contentGeneration: "9007199254740993", transferId: id, sizeBytes: "123", sha256: "a".repeat(64), transferToken: "a".repeat(64) };
    expect(computeInputGrantSchema.parse(grant).contentGeneration).toBe("9007199254740993");
    expect(computeInputGrantSchema.safeParse({ ...grant, generationId: id }).success).toBe(false);
    expect(computeInputGrantSchema.safeParse({ ...grant, objectPath: "/bucket/key" }).success).toBe(false);
  });
  it("retains original boot and sequence on journal replay and pages with explicit ack", () => {
    const parsed = computeUsageReportSchema.parse(sample);
    const oldBoot = parsed.binding.workerBootId;
    expect(computeCollectUsageResponseSchema.parse({ reports: [parsed], nextAfterSequence: parsed.sourceSequence, acknowledgedThroughSequence: null }).reports[0]!.binding.workerBootId).toBe(oldBoot);
    expect(computeAcknowledgeUsageRequestSchema.parse({ protocolVersion: 1, binding, throughSequence: parsed.sourceSequence }).throughSequence).toBe("9007199254740993");
  });
  it("does not permit a meter report to assign money or contradict terminal facts", () => {
    expect(computeUsageReportSchema.parse(sample).cumulativeElapsedNanoseconds).toBe("1200000000");
    for (const invalid of [{ ...sample, payerId: id }, { ...sample, price: "0" }, { ...sample, sourceSequence: 2 }, { ...sample, eventType: "started" }, { ...sample, eventType: "stopped" }, { ...sample, exitCode: 0 }]) expect(computeUsageReportSchema.safeParse(invalid).success).toBe(false);
  });
  it("bounds log bytes and excludes customer attribution", () => {
    const log = { protocolVersion: 1, binding, sourceSequence: "1", observedAt: lease.issuedAt, stream: "stdout", message: "hello", truncated: false, requestId: null };
    expect(computeLogEnvelopeSchema.safeParse(log).success).toBe(true);
    expect(computeLogEnvelopeSchema.safeParse({ ...log, app_id: "forged" }).success).toBe(false);
    expect(computeLogEnvelopeSchema.safeParse({ ...log, message: "🚀".repeat(5000) }).success).toBe(false);
  });
  it("requires conserved byte allowances and fenced close before refund", () => {
    const receipt = { protocolVersion: 1, binding, sourceSequence: "2", allowanceId: id, grantedBytes: "1000", consumedBytes: "300", remainingBytes: "700", expiresAt: lease.expiresAt, observedAt: lease.expiresAt, closedAt: null, closeReason: null, fenceConfirmed: false };
    expect(computeNetworkUsageObservationSchema.parse(receipt)).toEqual(receipt);
    expect(computeNetworkUsageObservationSchema.parse({ ...receipt, accounting: "measured" })).toEqual({ ...receipt, accounting: "measured" });
    expect(computeNetworkUsageObservationSchema.safeParse({ ...receipt, remainingBytes: "1000" }).success).toBe(false);
    expect(computeNetworkUsageObservationSchema.safeParse({ ...receipt, closedAt: lease.expiresAt }).success).toBe(false);
    expect(computeNetworkUsageObservationSchema.safeParse({ ...receipt, closedAt: lease.expiresAt, closeReason: "expired", fenceConfirmed: true }).success).toBe(true);
    expect(computeNetworkUsageObservationSchema.safeParse({ ...receipt, consumedBytes: "not-an-integer" }).success).toBe(false);
  });
  it("closes a retired allowance with unknown counters and a separate full quota forfeiture", () => {
    const previous = { protocolVersion: 1, binding, sourceSequence: "2", allowanceId: id, grantedBytes: "1000", consumedBytes: "300", remainingBytes: "700", expiresAt: lease.expiresAt, observedAt: lease.issuedAt, closedAt: null, closeReason: null, fenceConfirmed: false };
    const terminal = { ...previous, sourceSequence: "3", observedAt: lease.expiresAt, accounting: "forfeited", consumedBytes: null, remainingBytes: null, quotaForfeitedBytes: "1000", closedAt: lease.expiresAt, closeReason: "counter_lost", fenceConfirmed: true, fenceEvidence: "retired_allowance" };
    expect(computeNetworkUsageObservationSchema.parse(terminal)).toEqual(terminal);
    expect(computeNetworkUsagePageSchema.parse({ observations: [previous, terminal], nextAfterSequence: "3" }).observations).toEqual([previous, terminal]);
    expect(computeNetworkUsageObservationSchema.parse(JSON.parse(JSON.stringify(terminal)))).toEqual(terminal);
    for (const invalid of [
      { ...terminal, accounting: undefined }, { ...terminal, accounting: "measured" },
      { ...terminal, consumedBytes: "0" }, { ...terminal, consumedBytes: "1000" },
      { ...terminal, remainingBytes: "0" }, { ...terminal, quotaForfeitedBytes: "700" },
      { ...terminal, quotaForfeitedBytes: "bad" }, { ...terminal, closedAt: null },
      { ...terminal, closeReason: "stopped" }, { ...terminal, fenceConfirmed: false },
      { ...terminal, fenceEvidence: undefined }, { ...terminal, fenceEvidence: "lost" },
      { ...previous, consumedBytes: null, remainingBytes: null },
      { ...previous, quotaForfeitedBytes: "1000" },
    ]) expect(computeNetworkUsageObservationSchema.safeParse(invalid).success).toBe(false);
  });
  it("distinguishes a proven never-started allowance from measured and lost counters", () => {
    const receipt = { protocolVersion: 1, binding, sourceSequence: "1", allowanceId: id, grantedBytes: "1000", accounting: "unused", consumedBytes: "0", remainingBytes: "1000", expiresAt: lease.expiresAt, observedAt: lease.expiresAt, closedAt: lease.expiresAt, closeReason: "never_started", fenceConfirmed: true, fenceEvidence: "durable_no_start" };
    expect(computeNetworkUsageObservationSchema.parse(receipt)).toEqual(receipt);
    expect(computeNetworkUsagePageSchema.parse({ observations: [receipt], nextAfterSequence: "1" }).observations).toEqual([receipt]);
    for (const invalid of [
      { ...receipt, accounting: undefined }, { ...receipt, accounting: "measured" },
      { ...receipt, accounting: "forfeited" }, { ...receipt, consumedBytes: "1" },
      { ...receipt, consumedBytes: null }, { ...receipt, remainingBytes: null },
      { ...receipt, remainingBytes: "999" }, { ...receipt, remainingBytes: "bad" },
      { ...receipt, closedAt: null }, { ...receipt, closeReason: "stopped" },
      { ...receipt, closeReason: "counter_lost" }, { ...receipt, fenceConfirmed: false },
      { ...receipt, fenceEvidence: undefined }, { ...receipt, fenceEvidence: "retired_allowance" },
      { ...receipt, quotaForfeitedBytes: "1000" },
    ]) expect(computeNetworkUsageObservationSchema.safeParse(invalid).success).toBe(false);
  });
  it("rejects malformed integer byte counts without throwing during validation", () => {
    expect(computePrepareImageResponseSchema.safeParse({ imageDigest: launch.imageDigest, compressedBytes: "bad", unpackedBytes: "1", os: "linux", architecture: "amd64" }).success).toBe(false);
    expect(computePrepareImageResponseSchema.safeParse({ imageDigest: launch.imageDigest, compressedBytes: "1", unpackedBytes: "10737418241", os: "linux", architecture: "amd64" }).success).toBe(false);
  });
  it("accepts only bounded capability rotation on an authenticated lease renewal", () => {
    expect(computeLeaseRenewRequestSchema.safeParse({ protocolVersion: 1, binding, lease, capabilityToken: "x".repeat(64) }).success).toBe(true);
    expect(computeLeaseRenewRequestSchema.safeParse({ protocolVersion: 1, binding, lease, capabilityToken: "short" }).success).toBe(false);
    expect(CONTAINER_RUNTIME_ENV.capabilityFile).toBe("OPENCLOUD_CONTAINER_CAPABILITY_FILE");
  });
  it("signs the caller, target generation, slot and request deadline together", () => {
    const grant = { protocolVersion: 1, binding, gatewayId: id, slotId: id, requestId: "request-1", workloadName: "web", routeGeneration: 1, caller: { kind: "anonymous", userId: null, functionName: null }, method: "GET", uri: "/hello?a=1", issuedAt: lease.issuedAt, expiresAt: lease.expiresAt, signature: "x".repeat(64) };
    expect(computeIngressGrantSchema.safeParse(grant).success).toBe(true);
    expect(computeIngressGrantSchema.safeParse({ ...grant, upstream: "http://internal" }).success).toBe(false);
    expect(computeIngressGrantSchema.safeParse({ ...grant, caller: { kind: "anonymous", userId: id, functionName: null } }).success).toBe(false);
    const close = { protocolVersion: 1, binding, slotId: id, requestId: "request-1", closedAt: lease.expiresAt, reason: "completed", signature: "x".repeat(64) };
    expect(computeIngressCloseSchema.safeParse(close).success).toBe(true);
    expect(computeIngressCloseSchema.safeParse({ ...close, signature: undefined }).success).toBe(false);
    expect(canonicalComputeSignaturePayload("opencloud.compute.v1.ingress-close", binding, close)).not.toBe(canonicalComputeSignaturePayload("opencloud.compute.v1.ingress", binding, close));
  });
  it("refuses host registration with degraded isolation or clock bounds", () => {
    const hello = { protocolVersions: [1], installationId: id, workerId: id, workerBootId: id, observedAt: lease.issuedAt, clockUncertaintyMilliseconds: 50, capabilities: { operatingSystem: "linux", architecture: "amd64", sandbox: "runsc", policyVersion: 1, scratchQuota: true, egressGuard: true, independentWatchdog: true }, capacity: { cpu: 8, memoryGiB: 16, scratchGiB: 100, instances: 10 } };
    expect(computeWorkerHelloSchema.safeParse(hello).success).toBe(true);
    expect(computeWorkerHelloSchema.safeParse({ ...hello, clockUncertaintyMilliseconds: 5001 }).success).toBe(false);
    expect(computeWorkerHelloSchema.safeParse({ ...hello, capabilities: { ...hello.capabilities, sandbox: "runc" } }).success).toBe(false);
  });
  it("keeps unobserved kernel and directional network counters unknown", () => {
    expect(computeResourceObservationSchema.parse({ protocolVersion: 1, binding, observedAt: lease.issuedAt,
      cpuUsageNs: null, memoryBytes: null, peakMemoryBytes: null, scratchBytes: null,
      network: { ingressBytes: null, egressBytes: null, coverage: "unavailable" } }).memoryBytes).toBeNull();
  });
  it("preserves retained counter times in terminal diagnostics without restamping them", () => {
    const observation = { protocolVersion: 1, binding, observedAt: lease.expiresAt,
      cpuUsageNs: "9007199254740993", memoryBytes: "1024", peakMemoryBytes: "2048", scratchBytes: "4096",
      network: { ingressBytes: null, egressBytes: null, coverage: "unavailable" },
      sampling: { phase: "terminal", cpuObservedAt: lease.issuedAt, memoryObservedAt: lease.issuedAt,
        peakMemoryObservedAt: lease.issuedAt, scratchObservedAt: lease.expiresAt, networkObservedAt: null } };
    expect(computeResourceObservationSchema.parse(observation)).toEqual(observation);
    expect(computeResourceObservationSchema.parse(observation).sampling?.cpuObservedAt).not.toBe(observation.observedAt);
    const partialNetwork = { ...observation, network: { ingressBytes: "0", egressBytes: null, coverage: "partial" },
      sampling: { ...observation.sampling, networkObservedAt: lease.issuedAt } };
    expect(computeResourceObservationSchema.safeParse(partialNetwork).success).toBe(true);
    for (const sampling of [
      { ...observation.sampling, phase: "stopped" },
      { ...observation.sampling, cpuObservedAt: null },
      { ...observation.sampling, cpuObservedAt: lease.killAfter },
      { ...observation.sampling, networkObservedAt: lease.issuedAt },
      { ...observation.sampling, scratchObservedAt: undefined },
      { ...observation.sampling, futureAuthority: true },
    ]) expect(computeResourceObservationSchema.safeParse({ ...observation, sampling }).success).toBe(false);
    expect(computeResourceObservationSchema.safeParse({ ...observation, memoryBytes: null }).success).toBe(false);
    expect(computeResourceObservationSchema.safeParse({ ...observation, memoryBytes: null,
      sampling: { ...observation.sampling, memoryObservedAt: null } }).success).toBe(true);
  });
});
