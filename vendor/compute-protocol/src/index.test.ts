import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeAcknowledgeUsageRequestSchema,
  computeCollectUsageRequestSchema,
  computeCollectUsageResponseSchema,
  computeInputGrantSchema,
  computeInstanceBindingSchema,
  computeInspectionSchema,
  computePreparationErrorCodeSchema,
  computeLaunchRequestSchema,
  computeLeaseSchema,
  computeLogBatchSchema,
  computeLogEnvelopeSchema,
  computeLaunchIdentityPayload,
  computeRetireUnstartedRequestSchema,
  computeRetireUnstartedResponseSchema,
  computeRetireUndeliveredAllowancesRequestSchema,
  computeRetireUndeliveredAllowancesResponseSchema,
  computePinnedImageSchema,
  computeResourceAllocationSchema,
  computeUsageReportSchema,
  computeWorkerHelloSchema,
  computeWorkerOperations,
  canonicalComputeSignaturePayload,
  computeNetworkUsageObservationSchema,
  computeNetworkUsagePageSchema,
  computePrepareImageResponseSchema,
  computeLeaseRenewRequestSchema,
  computeResourceObservationSchema,
  CONTAINER_RUNTIME_ENV,
  computeImageFetchRequestSchema,
  computeResolveImageRequestSchema,
  computeReleaseImageRequestSchema,
  computeHttpObservationSchema,
} from "./index.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const binding = {
  installationId: id,
  workerId: id,
  workerBootId: id,
  appId: id,
  environment: "production" as const,
  developmentSessionId: null,
  revisionId: id,
  instanceId: id,
  generation: 1,
  launchId: `launch:${id}:1`,
  policyVersion: 1 as const,
};
const lease = {
  leaseId: id,
  leaseSequence: "1",
  issuedAt: "2026-11-13T12:00:00Z",
  expiresAt: "2026-11-13T12:00:30Z",
  killAfter: "2026-11-13T12:00:40Z",
  fundedUntil: "2026-11-13T12:00:45Z",
  signature: "x".repeat(64),
};
const allocation = { vcpu: 2, memoryMib: 4096, scratchMib: 10240 };
const sample = {
  protocolVersion: 1,
  binding,
  sourceSequence: "9007199254740993",
  eventType: "sample",
  allocation,
  allocationHash: "a".repeat(64),
  cumulativeElapsedNanoseconds: "1200000000",
  observedAt: "2026-11-13T12:00:02Z",
  processStartedAt: "2026-11-13T12:00:00Z",
  processStoppedAt: null,
  exitCode: null,
  signal: null,
};
const inspection = {
  protocolVersion: 1,
  binding,
  state: "running",
  observedAt: sample.observedAt,
  processStartedAt: sample.processStartedAt,
  processStoppedAt: null,
  exitCode: null,
  signal: null,
  oomKilled: false,
  scratchExhausted: false,
  stopConfirmed: false,
  sourceSequence: "9007199254740994",
};
const launch = {
  protocolVersion: 1,
  binding,
  workloadName: "example",
  kind: "job",
  imageDigest: `registry.test/team/example@sha256:${"a".repeat(64)}`,
  allocation,
  allocationHash: "a".repeat(64),
  egress: "none",
  startupTimeoutSeconds: 120,
  lease,
  executionDeadline: null,
  executionTimeoutSeconds: 900,
  networkAllowance: {
    allowanceId: id,
    bytes: "1000",
    expiresAt: lease.expiresAt,
    throughputMbitPerSecond: 100,
    signature: "a".repeat(64),
  },
  executionId: id,
  attempt: 1,
  replicaSlot: null,
};

describe("compute protocol authority and compatibility", () => {
  it("preserves frozen legacy launch identity bytes and schema normalization", () => {
    const digest = (raw: unknown) => createHash("sha256").update(computeLaunchIdentityPayload(raw)).digest("hex");
    // Captured from Runtime's pre-helper serializer, including schema defaults and key order.
    expect(digest(launch)).toBe("9d7b26a84e68602ec021894653f399d3018eff27a1c4d81006888469bdbea0ed");
    expect(computeLaunchIdentityPayload(Object.fromEntries(Object.entries(launch).reverse()))).toBe(
      computeLaunchIdentityPayload(launch),
    );
    expect(computeLaunchIdentityPayload({ ...launch, env: {}, inputs: [] })).toBe(computeLaunchIdentityPayload(launch));
    const withInput = {
      ...launch,
      env: { Z_LAST: "synthetic-secret", A_FIRST: "value" },
      input: { z: 1, a: { b: 2, a: 3 } },
      inputs: [
        {
          fileId: id,
          contentGeneration: "7",
          transferId: id,
          sizeBytes: "123",
          sha256: "b".repeat(64),
        },
      ],
      capabilityToken: "c".repeat(64),
    };
    expect(digest(withInput)).toBe("9d1c4f7eeb0604c7067c4bc6a9e5b43d1bd04abde34b042d45ba115ae343be6a");
    expect(
      computeLaunchIdentityPayload({
        ...withInput,
        lease: { ...lease, leaseSequence: "2", signature: "s".repeat(64) },
        networkAllowance: { ...launch.networkAllowance, bytes: "2000", signature: "n".repeat(64) },
        capabilityToken: "d".repeat(64),
      }),
    ).toBe(computeLaunchIdentityPayload(withInput));
    expect(digest({ ...withInput, env: { A_FIRST: "value", Z_LAST: "synthetic-secret" } })).not.toBe(digest(withInput));
    expect(digest({ ...withInput, inputs: [{ ...withInput.inputs[0], contentGeneration: "8" }] })).not.toBe(
      digest(withInput),
    );
    expect(() => computeLaunchIdentityPayload({ ...launch, unexpected: true })).toThrow();
  });
  // Review round 4, nit 2: the identity was a plain SHA-256 over the resolved
  // secret values, stored by Control and in the worker journal (which the
  // compute export includes), so a weak secret could be guessed offline.
  it("names a launch's secrets by their versions in its identity, never by their values", () => {
    const digest = (raw: unknown) => createHash("sha256").update(computeLaunchIdentityPayload(raw)).digest("hex");
    const secret = (value: string, version = "v-1") => ({
      ...launch,
      env: { MODE: "fast", API_TOKEN: value },
      secretVersions: { API_TOKEN: version },
    });
    expect(computeLaunchIdentityPayload(secret("synthetic-weak-secret"))).not.toContain("synthetic-weak-secret");
    expect(digest(secret("synthetic-weak-secret"))).toBe(digest(secret("another-value")));
    // A rotated secret is a new version, so a new identity; plain settings still count.
    expect(digest(secret("synthetic-weak-secret", "v-2"))).not.toBe(digest(secret("synthetic-weak-secret")));
    expect(digest({ ...secret("synthetic-weak-secret"), env: { MODE: "slow", API_TOKEN: "x" } })).not.toBe(
      digest(secret("synthetic-weak-secret")),
    );
    // A version must name an entry the launch carries.
    expect(() => computeLaunchIdentityPayload({ ...launch, secretVersions: { MISSING: "v-1" } })).toThrow();
  });
  it("allows only bounded secret-free retirement metadata and unique signed grants", () => {
    const request = {
      protocolVersion: 1,
      binding,
      requestHash: "b".repeat(64),
      launch: {
        workloadName: launch.workloadName,
        kind: launch.kind,
        imageDigest: launch.imageDigest,
        allocation,
        allocationHash: launch.allocationHash,
      },
      lease,
      networkAllowances: [launch.networkAllowance],
    };
    // Old signatures are structurally valid: authenticating them authorizes retirement only.
    expect(computeRetireUnstartedRequestSchema.parse(request)).toEqual(request);
    const maximum = Array.from({ length: 100 }, (_, index) => ({
      ...launch.networkAllowance,
      allowanceId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    }));
    expect(computeRetireUnstartedRequestSchema.safeParse({ ...request, networkAllowances: maximum }).success).toBe(
      true,
    );
    for (const invalid of [
      { ...request, networkAllowances: [] },
      { ...request, networkAllowances: [...maximum, launch.networkAllowance] },
      { ...request, networkAllowances: [launch.networkAllowance, launch.networkAllowance] },
      { ...request, networkAllowances: [launch.networkAllowance, { ...launch.networkAllowance, bytes: "2000" }] },
      { ...request, requestHash: "bad" },
      { ...request, protocolVersion: 2 },
      { ...request, launch: { ...request.launch, allocationHash: "bad" } },
      { ...request, launch: { ...request.launch, allocation: { ...allocation, vcpu: 3 } } },
      { ...request, capabilityToken: "secret" },
      { ...request, launch },
      ...["env", "input", "inputs", "service", "outputs", "command", "args", "capabilityToken"].map((field) => ({
        ...request,
        launch: { ...request.launch, [field]: "forbidden" },
      })),
    ])
      expect(computeRetireUnstartedRequestSchema.safeParse(invalid).success).toBe(false);
    expect(computeWorkerOperations.retireUnstarted).toMatchObject({
      method: "POST",
      path: "/v1/instances/retire-unstarted",
      input: computeRetireUnstartedRequestSchema,
      output: computeRetireUnstartedResponseSchema,
    });
  });
  it("distinguishes a real accepted instance from terminal no-start retirement", () => {
    expect(computeRetireUnstartedResponseSchema.parse({ instance: inspection, retired: false }).instance).toEqual({
      ...inspection,
      terminationReason: null,
      preparationErrorCode: null,
    });
    const terminal = { ...inspection, state: "stopped", processStartedAt: null, stopConfirmed: true };
    expect(computeRetireUnstartedResponseSchema.safeParse({ instance: terminal, retired: true }).success).toBe(true);
    for (const instance of [
      inspection,
      { ...terminal, processStartedAt: sample.processStartedAt },
      { ...terminal, stopConfirmed: false },
      { ...terminal, state: "lost" },
    ]) {
      expect(computeRetireUnstartedResponseSchema.safeParse({ instance, retired: true }).success).toBe(false);
    }
  });
  it("bounds terminal grant reconciliation without accepting new execution authority", () => {
    const request = { protocolVersion: 1, binding, networkAllowances: [launch.networkAllowance] };
    // Expired grants remain readable for authenticated closure, never renewed authority.
    expect(computeRetireUndeliveredAllowancesRequestSchema.parse(request)).toEqual(request);
    const maximum = Array.from({ length: 100 }, (_, index) => ({
      ...launch.networkAllowance,
      allowanceId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    }));
    expect(
      computeRetireUndeliveredAllowancesRequestSchema.safeParse({ ...request, networkAllowances: maximum }).success,
    ).toBe(true);
    for (const invalid of [
      { ...request, networkAllowances: [] },
      { ...request, networkAllowances: [...maximum, launch.networkAllowance] },
      { ...request, networkAllowances: [launch.networkAllowance, launch.networkAllowance] },
      { ...request, networkAllowances: [launch.networkAllowance, { ...launch.networkAllowance, bytes: "2000" }] },
      { ...request, networkAllowances: [{ ...launch.networkAllowance, signature: "short" }] },
      { ...request, networkAllowances: [{ ...launch.networkAllowance, payerId: id }] },
      { ...request, binding: { ...binding, generation: 0 } },
      { ...request, protocolVersion: 2 },
      ...["lease", "launch", "capabilityToken", "env", "input", "command", "requestHash"].map((field) => ({
        ...request,
        [field]: "forbidden",
      })),
    ])
      expect(computeRetireUndeliveredAllowancesRequestSchema.safeParse(invalid).success).toBe(false);
    expect(computeWorkerOperations.retireUndeliveredAllowances).toMatchObject({
      method: "POST",
      path: "/v1/instances/retire-undelivered-allowances",
      input: computeRetireUndeliveredAllowancesRequestSchema,
      output: computeRetireUndeliveredAllowancesResponseSchema,
    });
  });
  it("requires confirmed terminal stop for grant reconciliation but permits prior process execution", () => {
    const terminal = { ...inspection, state: "stopped", processStoppedAt: lease.expiresAt, stopConfirmed: true };
    expect(
      computeRetireUndeliveredAllowancesResponseSchema.parse({ instance: terminal, accepted: true }).instance,
    ).toEqual({ ...terminal, terminationReason: null, preparationErrorCode: null });
    expect(
      computeRetireUndeliveredAllowancesResponseSchema.safeParse({
        instance: { ...terminal, state: "failed" },
        accepted: true,
      }).success,
    ).toBe(true);
    for (const instance of [
      inspection,
      { ...terminal, stopConfirmed: false },
      { ...terminal, state: "lost" },
      { ...terminal, state: "stopping" },
      { ...terminal, state: "ready" },
    ]) {
      expect(computeRetireUndeliveredAllowancesResponseSchema.safeParse({ instance, accepted: true }).success).toBe(
        false,
      );
    }
    expect(
      computeRetireUndeliveredAllowancesResponseSchema.safeParse({ instance: terminal, accepted: false }).success,
    ).toBe(false);
    expect(
      computeRetireUndeliveredAllowancesResponseSchema.safeParse({ instance: terminal, accepted: true, revived: true })
        .success,
    ).toBe(false);
  });
  it("accepts only trusted terminal HTTP diagnostics without customer labels or content", () => {
    const value = {
      protocolVersion: 1,
      binding,
      requestId: "request-1",
      observedAt: lease.expiresAt,
      statusCode: null,
      queueMilliseconds: 1.5,
      durationMilliseconds: 300,
      outcome: "client_disconnect",
    };
    expect(computeHttpObservationSchema.safeParse(value).success).toBe(true);
    for (const bad of [
      { ...value, workloadName: "forged" },
      { ...value, path: "/private" },
      { ...value, queueMilliseconds: -1 },
      { ...value, durationMilliseconds: Infinity },
      { ...value, statusCode: 999 },
    ]) {
      expect(computeHttpObservationSchema.safeParse(bad).success).toBe(false);
    }
  });
  it("requires caller-owned retention identity before resolving tags and pinned zero-reference release proof", () => {
    const resolve = { retentionId: id, sourceReference: "registry.test/example:mutable" };
    expect(computeResolveImageRequestSchema.safeParse(resolve).success).toBe(true);
    expect(computeImageFetchRequestSchema.safeParse(resolve).success).toBe(true);
    expect(computeImageFetchRequestSchema.safeParse({ sourceReference: resolve.sourceReference }).success).toBe(false);
    expect(
      computeReleaseImageRequestSchema.safeParse({ retentionId: id, imageDigest: launch.imageDigest, proofId: id })
        .success,
    ).toBe(true);
    expect(
      computeReleaseImageRequestSchema.safeParse({ retentionId: id, imageDigest: null, proofId: id }).success,
    ).toBe(true);
    expect(computeReleaseImageRequestSchema.safeParse({ retentionId: id, proofId: id }).success).toBe(false);
    expect(
      computeReleaseImageRequestSchema.safeParse({ retentionId: id, imageDigest: resolve.sourceReference, proofId: id })
        .success,
    ).toBe(false);
    expect(
      computeReleaseImageRequestSchema.safeParse({ retentionId: id, imageDigest: launch.imageDigest }).success,
    ).toBe(false);
    expect(computeReleaseImageRequestSchema.safeParse({ retentionId: id, imageDigest: null }).success).toBe(false);
  });
  it("canonicalizes signed authority independently of object order and omits only the outer signature", () => {
    const one = canonicalComputeSignaturePayload("opencloud.compute.v1.lease", binding, lease);
    const two = canonicalComputeSignaturePayload(
      "opencloud.compute.v1.lease",
      binding,
      Object.fromEntries(Object.entries({ ...lease, signature: "different" }).reverse()),
    );
    expect(one).toBe(two);
    expect(one).not.toContain("different");
    expect(one).not.toBe(canonicalComputeSignaturePayload("opencloud.compute.v1.network", binding, lease));
    expect(one).not.toBe(
      canonicalComputeSignaturePayload("opencloud.compute.v1.lease", { ...binding, generation: 2 }, lease),
    );
    expect(() =>
      canonicalComputeSignaturePayload("opencloud.compute.v1.lease", binding, { invalid: Infinity }),
    ).toThrow();
  });
  it("accepts only normalized whole resource allocations", () => {
    expect(computeResourceAllocationSchema.parse(allocation)).toEqual(allocation);
    for (const bad of [
      { ...allocation, memoryMib: 1000 },
      { ...allocation, vcpu: 0.5 },
      { cpu: 2, memoryGiB: 4, scratchGiB: 10 },
    ]) {
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
    for (const bad of [
      "image:latest",
      "https://registry.test/image",
      `user:pass@registry.test/image@sha256:${"a".repeat(64)}`,
    ])
      expect(computePinnedImageSchema.safeParse(bad).success).toBe(false);
  });
  it("accepts idempotent bounded job launches, not raw Docker policy", () => {
    expect(computeLaunchRequestSchema.parse(launch).binding.launchId).toBe(launch.binding.launchId);
    for (const bad of [
      { ...launch, privileged: true },
      { ...launch, mounts: ["/var/run/docker.sock"] },
      { ...launch, protocolVersion: 2 },
      { ...launch, service: { port: 8080 } },
      { ...launch, executionId: null },
    ])
      expect(computeLaunchRequestSchema.safeParse(bad).success).toBe(false);
  });
  it("requires service probes and concurrency, never accepts job authority on workers", () => {
    const service = {
      ...launch,
      kind: "service",
      executionId: null,
      attempt: null,
      replicaSlot: 0,
      executionTimeoutSeconds: null,
      service: {
        port: 8080,
        concurrency: 20,
        startupProbe: { path: "/ready" },
        readinessProbe: { path: "/ready", timeoutSeconds: 5 },
      },
    };
    expect(computeLaunchRequestSchema.safeParse(service).success).toBe(true);
    expect(computeLaunchRequestSchema.safeParse({ ...service, input: {} }).success).toBe(false);
    expect(computeLaunchRequestSchema.safeParse({ ...service, kind: "worker" }).success).toBe(false);
  });
  it("requires a job duration on the first start and retains the original deadline on retries", () => {
    expect(computeLaunchRequestSchema.safeParse({ ...launch, executionTimeoutSeconds: null }).success).toBe(false);
    expect(computeLaunchRequestSchema.safeParse({ ...launch, executionTimeoutSeconds: 1 }).success).toBe(true);
    expect(computeLaunchRequestSchema.safeParse({ ...launch, attempt: 2 }).success).toBe(false);
    expect(
      computeLaunchRequestSchema.safeParse({ ...launch, attempt: 2, executionDeadline: "2026-11-13T12:01:00Z" })
        .success,
    ).toBe(true);
  });
  it.each([
    { expiresAt: "2026-11-13T12:05:01Z", killAfter: "2026-11-13T12:05:11Z", fundedUntil: "2026-11-13T12:05:15Z" },
    { killAfter: "2026-11-13T12:00:41Z" },
    { fundedUntil: "2026-11-13T12:00:39Z" },
    { fundedUntil: "2026-11-13T12:05:16Z" },
  ])("rejects an unfunded or unbounded lease %j", (invalid) => {
    expect(computeLeaseSchema.safeParse({ ...lease, ...invalid }).success).toBe(false);
  });
  it("accepts a lease of up to five minutes that funds its stop grace", () => {
    expect(
      computeLeaseSchema.safeParse({
        ...lease,
        expiresAt: "2026-11-13T12:05:00Z",
        killAfter: "2026-11-13T12:05:10Z",
        fundedUntil: "2026-11-13T12:05:15Z",
      }).success,
    ).toBe(true);
  });
  it("keeps file content generations lossless, with no storage location", () => {
    // Exactly what Files activates for an input: a launch carries it unchanged.
    const grant = {
      fileId: id,
      contentGeneration: "9007199254740993",
      transferId: id,
      sizeBytes: "123",
      sha256: "a".repeat(64),
    };
    expect(computeInputGrantSchema.parse(grant)).toEqual(grant);
    expect(computeInputGrantSchema.parse(grant).contentGeneration).toBe("9007199254740993");
    expect(computeInputGrantSchema.safeParse({ ...grant, generationId: id }).success).toBe(false);
    expect(computeInputGrantSchema.safeParse({ ...grant, objectPath: "/bucket/key" }).success).toBe(false);
  });
  it("reads older inspections with no termination reason and preserves complete replay facts", () => {
    const parsed = computeInspectionSchema.parse(inspection);
    expect(parsed).toEqual({ ...inspection, terminationReason: null, preparationErrorCode: null });
    expect(computeInspectionSchema.parse({ ...inspection, terminationReason: null })).toEqual(parsed);
    expect(computeInspectionSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
  it.each(["timeout", "lease_expired", "startup_timeout", "liveness"])(
    "retains trusted %s evidence even when the process exits zero",
    (terminationReason) => {
      const terminal = {
        ...inspection,
        state: "stopped",
        processStoppedAt: lease.expiresAt,
        observedAt: lease.expiresAt,
        exitCode: 0,
        stopConfirmed: true,
        terminationReason,
      };
      expect(computeInspectionSchema.parse(terminal)).toEqual({ ...terminal, preparationErrorCode: null });
      expect(
        computeInspectionSchema.parse({ ...inspection, state: "stopping", terminationReason }).terminationReason,
      ).toBe(terminationReason);
    },
  );
  it("rejects unknown termination claims and requires the full instance binding", () => {
    for (const terminationReason of [
      "cancelled",
      "authority_revoked",
      "budget",
      "tenant",
      "unknown",
      { reason: "timeout" },
    ]) {
      expect(computeInspectionSchema.safeParse({ ...inspection, terminationReason }).success).toBe(false);
    }
    for (const invalid of [
      { ...inspection, terminationReason: "timeout", tenant: "forged" },
      { ...inspection, terminationReason: "timeout", binding: { ...binding, generation: 0 } },
      { ...inspection, terminationReason: "timeout", binding: { ...binding, instanceId: undefined } },
    ])
      expect(computeInspectionSchema.safeParse(invalid).success).toBe(false);
  });
  it.each(computePreparationErrorCodeSchema.options)(
    "retains safe preparation code %s only with terminal no-start proof",
    (preparationErrorCode) => {
      const failed = {
        ...inspection,
        state: "failed",
        processStartedAt: null,
        stopConfirmed: true,
        preparationErrorCode,
      };
      expect(computeInspectionSchema.parse(failed)).toEqual({ ...failed, terminationReason: null });
      for (const invalid of [
        { ...failed, state: "preparing" },
        { ...failed, state: "stopped" },
        { ...failed, state: "lost" },
        { ...failed, stopConfirmed: false },
        { ...failed, processStartedAt: sample.processStartedAt },
        { ...failed, processStoppedAt: sample.observedAt },
        { ...failed, exitCode: 0 },
        { ...failed, signal: "SIGTERM" },
        { ...failed, oomKilled: true },
        { ...failed, scratchExhausted: true },
        { ...failed, terminationReason: "lease_expired" },
      ])
        expect(computeInspectionSchema.safeParse(invalid).success).toBe(false);
    },
  );
  it("rejects remote preparation text, unsupported codes and evidence on other envelopes", () => {
    const failed = { ...inspection, state: "failed", processStartedAt: null, stopConfirmed: true };
    for (const preparationErrorCode of [
      "COMPUTE_CANCELLED",
      "COMPUTE_AUTHORITY_REVOKED",
      "COMPUTE_INTERNAL_ERROR",
      "connection refused with secret",
      { code: "COMPUTE_IMAGE_PULL_FAILED" },
    ]) {
      expect(computeInspectionSchema.safeParse({ ...failed, preparationErrorCode }).success).toBe(false);
    }
    expect(
      computeInspectionSchema.safeParse({
        ...failed,
        preparationErrorCode: "COMPUTE_IMAGE_PULL_FAILED",
        message: "remote details",
      }).success,
    ).toBe(false);
    expect(
      computeUsageReportSchema.safeParse({ ...sample, preparationErrorCode: "COMPUTE_IMAGE_PULL_FAILED" }).success,
    ).toBe(false);
    expect(
      computeLogEnvelopeSchema.safeParse({
        protocolVersion: 1,
        binding,
        sourceSequence: "1",
        observedAt: lease.issuedAt,
        stream: "stderr",
        message: "tenant",
        truncated: false,
        requestId: null,
        preparationErrorCode: "COMPUTE_IMAGE_PULL_FAILED",
      }).success,
    ).toBe(false);
  });
  it("keeps inspection identity and termination evidence out of immutable usage reports and cursors", () => {
    expect(computeInspectionSchema.parse(inspection).sourceSequence).not.toBe(sample.sourceSequence);
    expect(computeUsageReportSchema.parse(sample)).toEqual(sample);
    const request = { protocolVersion: 1, binding, afterSequence: sample.sourceSequence, limit: 100 };
    const page = { reports: [sample], nextAfterSequence: sample.sourceSequence, acknowledgedThroughSequence: null };
    expect(computeCollectUsageRequestSchema.parse(request)).toEqual(request);
    expect(computeCollectUsageResponseSchema.parse(page)).toEqual(page);
    expect(computeUsageReportSchema.safeParse({ ...sample, terminationReason: "timeout" }).success).toBe(false);
    expect(
      computeCollectUsageRequestSchema.safeParse({ ...request, inspectionSequence: inspection.sourceSequence }).success,
    ).toBe(false);
  });
  it("retains original boot and sequence on journal replay and pages with explicit ack", () => {
    const parsed = computeUsageReportSchema.parse(sample);
    const oldBoot = parsed.binding.workerBootId;
    expect(
      computeCollectUsageResponseSchema.parse({
        reports: [parsed],
        nextAfterSequence: parsed.sourceSequence,
        acknowledgedThroughSequence: null,
      }).reports[0]!.binding.workerBootId,
    ).toBe(oldBoot);
    expect(
      computeAcknowledgeUsageRequestSchema.parse({
        protocolVersion: 1,
        binding,
        throughSequence: parsed.sourceSequence,
      }).throughSequence,
    ).toBe("9007199254740993");
  });
  it("does not permit a meter report to assign money or contradict terminal facts", () => {
    expect(computeUsageReportSchema.parse(sample).cumulativeElapsedNanoseconds).toBe("1200000000");
    for (const invalid of [
      { ...sample, payerId: id },
      { ...sample, price: "0" },
      { ...sample, sourceSequence: 2 },
      { ...sample, eventType: "started" },
      { ...sample, eventType: "stopped" },
      { ...sample, exitCode: 0 },
    ])
      expect(computeUsageReportSchema.safeParse(invalid).success).toBe(false);
  });
  it("bounds log bytes and excludes customer attribution", () => {
    const log = {
      protocolVersion: 1,
      binding,
      sourceSequence: "1",
      observedAt: lease.issuedAt,
      stream: "stdout",
      message: "hello",
      truncated: false,
      requestId: null,
    };
    expect(computeLogEnvelopeSchema.safeParse(log).success).toBe(true);
    expect(computeLogEnvelopeSchema.safeParse({ ...log, app_id: "forged" }).success).toBe(false);
    expect(computeLogEnvelopeSchema.safeParse({ ...log, message: "🚀".repeat(5000) }).success).toBe(false);
    const tenantClaim = { ...log, message: JSON.stringify({ terminationReason: "timeout" }) };
    expect(computeLogEnvelopeSchema.parse(tenantClaim)).toEqual(tenantClaim);
    expect(computeLogEnvelopeSchema.safeParse({ ...log, terminationReason: "timeout" }).success).toBe(false);
    // A gap names only the app's own quota as its cause; anything else is platform loss.
    const gap = { binding, from: lease.issuedAt, to: lease.issuedAt, droppedLines: "3" };
    expect(
      computeLogBatchSchema
        .parse({ lines: [], gaps: [gap, { ...gap, reason: "quota" }] })
        .gaps.map((item) => item.reason),
    ).toEqual([undefined, "quota"]);
    expect(computeLogBatchSchema.safeParse({ lines: [], gaps: [{ ...gap, reason: "platform" }] }).success).toBe(false);
  });
  it("requires conserved byte allowances and fenced close before refund", () => {
    const receipt = {
      protocolVersion: 1,
      binding,
      sourceSequence: "2",
      allowanceId: id,
      grantedBytes: "1000",
      consumedBytes: "300",
      remainingBytes: "700",
      expiresAt: lease.expiresAt,
      observedAt: lease.expiresAt,
      closedAt: null,
      closeReason: null,
      fenceConfirmed: false,
    };
    expect(computeNetworkUsageObservationSchema.parse(receipt)).toEqual(receipt);
    expect(computeNetworkUsageObservationSchema.parse({ ...receipt, accounting: "measured" })).toEqual({
      ...receipt,
      accounting: "measured",
    });
    expect(computeNetworkUsageObservationSchema.safeParse({ ...receipt, remainingBytes: "1000" }).success).toBe(false);
    expect(computeNetworkUsageObservationSchema.safeParse({ ...receipt, closedAt: lease.expiresAt }).success).toBe(
      false,
    );
    expect(
      computeNetworkUsageObservationSchema.safeParse({
        ...receipt,
        closedAt: lease.expiresAt,
        closeReason: "expired",
        fenceConfirmed: true,
      }).success,
    ).toBe(true);
    expect(
      computeNetworkUsageObservationSchema.safeParse({ ...receipt, consumedBytes: "not-an-integer" }).success,
    ).toBe(false);
  });
  it("closes a retired allowance with unknown counters and a separate full quota forfeiture", () => {
    const previous = {
      protocolVersion: 1,
      binding,
      sourceSequence: "2",
      allowanceId: id,
      grantedBytes: "1000",
      consumedBytes: "300",
      remainingBytes: "700",
      expiresAt: lease.expiresAt,
      observedAt: lease.issuedAt,
      closedAt: null,
      closeReason: null,
      fenceConfirmed: false,
    };
    const terminal = {
      ...previous,
      sourceSequence: "3",
      observedAt: lease.expiresAt,
      accounting: "forfeited",
      consumedBytes: null,
      remainingBytes: null,
      quotaForfeitedBytes: "1000",
      closedAt: lease.expiresAt,
      closeReason: "counter_lost",
      fenceConfirmed: true,
      fenceEvidence: "retired_allowance",
    };
    expect(computeNetworkUsageObservationSchema.parse(terminal)).toEqual(terminal);
    expect(
      computeNetworkUsagePageSchema.parse({ observations: [previous, terminal], nextAfterSequence: "3" }).observations,
    ).toEqual([previous, terminal]);
    expect(computeNetworkUsageObservationSchema.parse(JSON.parse(JSON.stringify(terminal)))).toEqual(terminal);
    for (const invalid of [
      { ...terminal, accounting: undefined },
      { ...terminal, accounting: "measured" },
      { ...terminal, consumedBytes: "0" },
      { ...terminal, consumedBytes: "1000" },
      { ...terminal, remainingBytes: "0" },
      { ...terminal, quotaForfeitedBytes: "700" },
      { ...terminal, quotaForfeitedBytes: "bad" },
      { ...terminal, closedAt: null },
      { ...terminal, closeReason: "stopped" },
      { ...terminal, fenceConfirmed: false },
      { ...terminal, fenceEvidence: undefined },
      { ...terminal, fenceEvidence: "lost" },
      { ...previous, consumedBytes: null, remainingBytes: null },
      { ...previous, quotaForfeitedBytes: "1000" },
    ])
      expect(computeNetworkUsageObservationSchema.safeParse(invalid).success).toBe(false);
  });
  it("distinguishes a proven never-started allowance from measured and lost counters", () => {
    const receipt = {
      protocolVersion: 1,
      binding,
      sourceSequence: "1",
      allowanceId: id,
      grantedBytes: "1000",
      accounting: "unused",
      consumedBytes: "0",
      remainingBytes: "1000",
      expiresAt: lease.expiresAt,
      observedAt: lease.expiresAt,
      closedAt: lease.expiresAt,
      closeReason: "never_started",
      fenceConfirmed: true,
      fenceEvidence: "durable_no_start",
    };
    expect(computeNetworkUsageObservationSchema.parse(receipt)).toEqual(receipt);
    expect(
      computeNetworkUsagePageSchema.parse({ observations: [receipt], nextAfterSequence: "1" }).observations,
    ).toEqual([receipt]);
    for (const invalid of [
      { ...receipt, accounting: undefined },
      { ...receipt, accounting: "measured" },
      { ...receipt, accounting: "forfeited" },
      { ...receipt, consumedBytes: "1" },
      { ...receipt, consumedBytes: null },
      { ...receipt, remainingBytes: null },
      { ...receipt, remainingBytes: "999" },
      { ...receipt, remainingBytes: "bad" },
      { ...receipt, closedAt: null },
      { ...receipt, closeReason: "stopped" },
      { ...receipt, closeReason: "counter_lost" },
      { ...receipt, fenceConfirmed: false },
      { ...receipt, fenceEvidence: undefined },
      { ...receipt, fenceEvidence: "retired_allowance" },
      { ...receipt, quotaForfeitedBytes: "1000" },
    ])
      expect(computeNetworkUsageObservationSchema.safeParse(invalid).success).toBe(false);
  });
  it("keeps per-grant non-admission distinct from whole-instance no-start evidence", () => {
    const receipt = {
      protocolVersion: 1,
      binding,
      sourceSequence: "4",
      allowanceId: id,
      grantedBytes: "1000",
      accounting: "unused",
      consumedBytes: "0",
      remainingBytes: "1000",
      expiresAt: lease.expiresAt,
      observedAt: lease.expiresAt,
      closedAt: lease.expiresAt,
      closeReason: "never_admitted",
      fenceConfirmed: true,
      fenceEvidence: "durable_grant_non_admission",
    };
    expect(computeNetworkUsageObservationSchema.parse(receipt)).toEqual(receipt);
    expect(computeNetworkUsageObservationSchema.parse(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    expect(
      computeNetworkUsagePageSchema.parse({ observations: [receipt], nextAfterSequence: "4" }).observations,
    ).toEqual([receipt]);
    for (const invalid of [
      { ...receipt, accounting: undefined },
      { ...receipt, accounting: "measured" },
      { ...receipt, accounting: "forfeited" },
      { ...receipt, consumedBytes: "1" },
      { ...receipt, consumedBytes: null },
      { ...receipt, remainingBytes: "999" },
      { ...receipt, remainingBytes: null },
      { ...receipt, closedAt: null },
      { ...receipt, fenceConfirmed: false },
      { ...receipt, fenceEvidence: undefined },
      { ...receipt, fenceEvidence: "durable_no_start" },
      { ...receipt, closeReason: "never_started" },
      { ...receipt, closeReason: "counter_unavailable" },
      { ...receipt, quotaForfeitedBytes: "1000" },
    ])
      expect(computeNetworkUsageObservationSchema.safeParse(invalid).success).toBe(false);
  });
  it("requires a distinct terminal instance fence for unknown retained-grant counters", () => {
    const previous = {
      protocolVersion: 1,
      binding,
      sourceSequence: "2",
      allowanceId: id,
      grantedBytes: "1000",
      consumedBytes: "300",
      remainingBytes: "700",
      expiresAt: lease.expiresAt,
      observedAt: lease.issuedAt,
      closedAt: null,
      closeReason: null,
      fenceConfirmed: false,
    };
    const terminal = {
      ...previous,
      sourceSequence: "3",
      observedAt: lease.expiresAt,
      accounting: "forfeited",
      consumedBytes: null,
      remainingBytes: null,
      quotaForfeitedBytes: "1000",
      closedAt: lease.expiresAt,
      closeReason: "counter_unavailable",
      fenceConfirmed: true,
      fenceEvidence: "stopped_instance",
    };
    expect(computeNetworkUsageObservationSchema.parse(terminal)).toEqual(terminal);
    expect(computeNetworkUsageObservationSchema.parse(JSON.parse(JSON.stringify(terminal)))).toEqual(terminal);
    expect(
      computeNetworkUsagePageSchema.parse({ observations: [previous, terminal], nextAfterSequence: "3" }).observations,
    ).toEqual([previous, terminal]);
    for (const invalid of [
      { ...terminal, accounting: undefined },
      { ...terminal, accounting: "measured" },
      { ...terminal, accounting: "unused" },
      { ...terminal, consumedBytes: "0" },
      { ...terminal, consumedBytes: "300" },
      { ...terminal, remainingBytes: "0" },
      { ...terminal, quotaForfeitedBytes: "700" },
      { ...terminal, quotaForfeitedBytes: undefined },
      { ...terminal, closedAt: null },
      { ...terminal, fenceConfirmed: false },
      { ...terminal, fenceEvidence: undefined },
      { ...terminal, fenceEvidence: "retired_allowance" },
      { ...terminal, closeReason: "counter_lost" },
      { ...terminal, closeReason: "never_admitted" },
    ])
      expect(computeNetworkUsageObservationSchema.safeParse(invalid).success).toBe(false);
  });
  it("rejects malformed integer byte counts without throwing during validation", () => {
    expect(
      computePrepareImageResponseSchema.safeParse({
        imageDigest: launch.imageDigest,
        compressedBytes: "bad",
        unpackedBytes: "1",
        os: "linux",
        architecture: "amd64",
      }).success,
    ).toBe(false);
    expect(
      computePrepareImageResponseSchema.safeParse({
        imageDigest: launch.imageDigest,
        compressedBytes: "1",
        unpackedBytes: "10737418241",
        os: "linux",
        architecture: "amd64",
      }).success,
    ).toBe(false);
  });
  it("accepts only bounded capability rotation on an authenticated lease renewal", () => {
    expect(
      computeLeaseRenewRequestSchema.safeParse({ protocolVersion: 1, binding, lease, capabilityToken: "x".repeat(64) })
        .success,
    ).toBe(true);
    expect(
      computeLeaseRenewRequestSchema.safeParse({ protocolVersion: 1, binding, lease, capabilityToken: "short" })
        .success,
    ).toBe(false);
    expect(CONTAINER_RUNTIME_ENV.capabilityFile).toBe("OPENCLOUD_CONTAINER_CAPABILITY_FILE");
    expect(CONTAINER_RUNTIME_ENV.executionId).toBe("OPENCLOUD_EXECUTION_ID");
    expect(CONTAINER_RUNTIME_ENV.executionAttempt).toBe("OPENCLOUD_EXECUTION_ATTEMPT");
  });
  it("signs only leases, network allowances and route grants, each under its own purpose", () => {
    const payload = { protocolVersion: 1, routeGeneration: 1, signature: "x".repeat(64) };
    const signed = (purpose: string) => canonicalComputeSignaturePayload(purpose as never, binding, payload);
    const purposes = ["opencloud.compute.v1.lease", "opencloud.compute.v1.network", "opencloud.compute.v1.route-grant"];
    expect(new Set(purposes.map(signed)).size).toBe(3);
    // The slot-era purposes are retired.
    for (const retired of ["opencloud.compute.v1.ingress", "opencloud.compute.v1.ingress-close"])
      expect(() => signed(retired)).toThrow("Unsupported compute signature purpose");
  });
  it("refuses host registration with degraded isolation or clock bounds", () => {
    const hello = {
      protocolVersions: [1],
      installationId: id,
      workerId: id,
      workerBootId: id,
      observedAt: lease.issuedAt,
      clockUncertaintyMilliseconds: 50,
      capabilities: {
        operatingSystem: "linux",
        architecture: "amd64",
        sandbox: "runsc",
        policyVersion: 1,
        scratchQuota: true,
        egressGuard: true,
        independentWatchdog: true,
      },
      capacity: { cpu: 8, memoryGiB: 16, scratchGiB: 100, instances: 10 },
    };
    expect(computeWorkerHelloSchema.safeParse(hello).success).toBe(true);
    expect(computeWorkerHelloSchema.safeParse({ ...hello, clockUncertaintyMilliseconds: 5001 }).success).toBe(false);
    expect(
      computeWorkerHelloSchema.safeParse({ ...hello, capabilities: { ...hello.capabilities, sandbox: "runc" } })
        .success,
    ).toBe(false);
  });
  it("keeps unobserved kernel and directional network counters unknown", () => {
    expect(
      computeResourceObservationSchema.parse({
        protocolVersion: 1,
        binding,
        observedAt: lease.issuedAt,
        cpuUsageNs: null,
        memoryBytes: null,
        peakMemoryBytes: null,
        scratchBytes: null,
        network: { ingressBytes: null, egressBytes: null, coverage: "unavailable" },
      }).memoryBytes,
    ).toBeNull();
  });
  it("preserves retained counter times in terminal diagnostics without restamping them", () => {
    const observation = {
      protocolVersion: 1,
      binding,
      observedAt: lease.expiresAt,
      cpuUsageNs: "9007199254740993",
      memoryBytes: "1024",
      peakMemoryBytes: "2048",
      scratchBytes: "4096",
      network: { ingressBytes: null, egressBytes: null, coverage: "unavailable" },
      sampling: {
        phase: "terminal",
        cpuObservedAt: lease.issuedAt,
        memoryObservedAt: lease.issuedAt,
        peakMemoryObservedAt: lease.issuedAt,
        scratchObservedAt: lease.expiresAt,
        networkObservedAt: null,
      },
    };
    expect(computeResourceObservationSchema.parse(observation)).toEqual(observation);
    expect(computeResourceObservationSchema.parse(observation).sampling?.cpuObservedAt).not.toBe(
      observation.observedAt,
    );
    const partialNetwork = {
      ...observation,
      network: { ingressBytes: "0", egressBytes: null, coverage: "partial" },
      sampling: { ...observation.sampling, networkObservedAt: lease.issuedAt },
    };
    expect(computeResourceObservationSchema.safeParse(partialNetwork).success).toBe(true);
    for (const sampling of [
      { ...observation.sampling, phase: "stopped" },
      { ...observation.sampling, cpuObservedAt: null },
      { ...observation.sampling, cpuObservedAt: lease.killAfter },
      { ...observation.sampling, networkObservedAt: lease.issuedAt },
      { ...observation.sampling, scratchObservedAt: undefined },
      { ...observation.sampling, futureAuthority: true },
    ])
      expect(computeResourceObservationSchema.safeParse({ ...observation, sampling }).success).toBe(false);
    expect(computeResourceObservationSchema.safeParse({ ...observation, memoryBytes: null }).success).toBe(false);
    expect(
      computeResourceObservationSchema.safeParse({
        ...observation,
        memoryBytes: null,
        sampling: { ...observation.sampling, memoryObservedAt: null },
      }).success,
    ).toBe(true);
  });
});
describe("batched HTTP observations", () => {
  it("bounds batches and answers each item on its own", async () => {
    const { COMPUTE_BATCH_LIMIT, computeBatchResultSchema, computeHttpObservationBatchOperation } = await import(
      "./index.js"
    );
    for (const [operation, field] of [[computeHttpObservationBatchOperation, "observations"]] as const) {
      const batch = (count: number) => ({ protocolVersion: 1, [field]: Array.from({ length: count }, () => ({})) });
      expect(operation.input.safeParse(batch(1)).success).toBe(true);
      expect(operation.input.safeParse(batch(COMPUTE_BATCH_LIMIT)).success).toBe(true);
      expect(operation.input.safeParse(batch(COMPUTE_BATCH_LIMIT + 1)).success).toBe(false);
      expect(operation.input.safeParse(batch(0)).success).toBe(false);
      expect(operation.input.safeParse({ ...batch(1), extra: true }).success).toBe(false);
    }
    expect(
      computeBatchResultSchema.safeParse({
        results: [
          { outcome: "accepted" },
          { outcome: "rejected", code: "COMPUTE_AUTHORITY_REVOKED" },
          { outcome: "retry" },
        ],
      }).success,
    ).toBe(true);
    for (const result of [
      { outcome: "dropped" },
      { outcome: "retry", code: "not a code" },
      { outcome: "retry", extra: 1 },
    ])
      expect(computeBatchResultSchema.safeParse({ results: [result] }).success).toBe(false);
  });
});
describe("ingress protocol 1: route intents, route grants and the route table", () => {
  const binding = {
    installationId: "00000000-0000-4000-8000-000000000001",
    workerId: "00000000-0000-4000-8000-000000000002",
    workerBootId: "00000000-0000-4000-8000-000000000003",
    appId: "00000000-0000-4000-8000-000000000004",
    revisionId: "00000000-0000-4000-8000-000000000005",
    instanceId: "00000000-0000-4000-8000-000000000006",
    generation: 1,
    policyVersion: 1 as const,
    launchId: "compute:fixture:1",
    environment: "production" as const,
    developmentSessionId: null,
  };
  const at = (seconds: number) => new Date(Date.parse("2026-11-18T10:00:00.000Z") + seconds * 1000).toISOString();
  const intent = (changes: Record<string, unknown> = {}) => ({
    purpose: "opencloud.compute.v1.route",
    ingressProtocol: 1,
    appId: binding.appId,
    environment: "production",
    developmentSessionId: null,
    revisionId: binding.revisionId,
    sourceId: "00000000-0000-4000-8000-000000000007",
    workloadName: "web",
    routeGeneration: 3,
    candidate: false,
    method: "GET",
    uri: "/",
    caller: { kind: "anonymous", userId: null, functionName: null },
    forwardAuthorization: false,
    authority: { retained: { kind: "grant" } },
    nonce: "00000000-0000-4000-8000-000000000008",
    issuedAt: at(0),
    expiresAt: at(30),
    requestDeadline: at(60),
    ...changes,
  });
  it("bounds a route intent's admission window and request deadline", async () => {
    const { computeRouteIntentSchema, splitComputeToken } = await import("./index.js");
    expect(computeRouteIntentSchema.safeParse(intent()).success).toBe(true);
    for (const changes of [
      { expiresAt: at(0) },
      { expiresAt: at(61), requestDeadline: at(120) },
      { requestDeadline: at(10) },
      { requestDeadline: at(3_601) },
      { uri: "//elsewhere" },
      { nonce: "replayable" },
      { ingressProtocol: 2 },
      { extra: true },
    ])
      expect(computeRouteIntentSchema.safeParse(intent(changes)).success).toBe(false);
    expect(splitComputeToken("Ym9keQ.c2ln")).toEqual({ body: "Ym9keQ", signature: "c2ln" });
    for (const token of ["only-body", "a.b.c", "a b.c", ".sig", `${"a".repeat(16_385)}.b`])
      expect(splitComputeToken(token)).toBeNull();
  });
  it("grants a route for at most two minutes and lists ready and draining copies", async () => {
    const { computeRouteGrantSchema, computeRouteTableOperation, canonicalComputeSignaturePayload } = await import(
      "./index.js"
    );
    const grant = {
      protocolVersion: 1,
      binding,
      workloadName: "web",
      routeGeneration: 3,
      candidate: false,
      concurrency: 20,
      issuedAt: at(0),
      expiresAt: at(30),
      signature: "s".repeat(86),
    };
    expect(computeRouteGrantSchema.safeParse(grant).success).toBe(true);
    expect(computeRouteGrantSchema.safeParse({ ...grant, expiresAt: at(121) }).success).toBe(false);
    const { candidate: _candidate, ...unflagged } = grant;
    expect(computeRouteGrantSchema.safeParse(unflagged).success).toBe(false);
    expect(() => canonicalComputeSignaturePayload("opencloud.compute.v1.route-grant", binding, grant)).not.toThrow();
    // A route intent's purpose is not a signature purpose: grants can't pass for intents.
    expect(() => canonicalComputeSignaturePayload("opencloud.compute.v1.route" as never, binding, grant)).toThrow();
    const table = {
      protocolVersion: 1,
      signal: 7,
      generatedAt: at(0),
      signingKeys: ["-----BEGIN PUBLIC KEY-----"],
      revisions: [
        {
          revisionId: binding.revisionId,
          appId: binding.appId,
          environment: "production",
          developmentSessionId: null,
          workloadName: "web",
          routeGeneration: 3,
          serving: "active",
          paused: false,
          concurrency: 20,
          instances: [
            { state: "ready", endpoint: "https://compute-host:9445/", ingressProtocols: [1], grant },
            { state: "draining", endpoint: "https://compute-host:9445/", ingressProtocols: [1], grant },
          ],
        },
      ],
    };
    expect(computeRouteTableOperation.output.safeParse(table).success).toBe(true);
    const retired = { ...table.revisions[0]!, serving: "retired", instances: [table.revisions[0]!.instances[1]!] };
    expect(computeRouteTableOperation.output.safeParse({ ...table, revisions: [retired] }).success).toBe(true);
    const stopped = {
      ...table.revisions[0]!,
      instances: [{ ...table.revisions[0]!.instances[0]!, state: "stopping" }],
    };
    expect(computeRouteTableOperation.output.safeParse({ ...table, revisions: [stopped] }).success).toBe(false);
  });
  it("reports demand per revision and checks streams in bounded batches", async () => {
    const { computeIngressDemandOperation, computeStreamCheckOperation, computeWorkerHelloSchema } = await import(
      "./index.js"
    );
    const revision = { revisionId: binding.revisionId, active: 2, waiting: 1, wakeups: 1 };
    expect(computeIngressDemandOperation.input.safeParse({ protocolVersion: 1, revisions: [revision] }).success).toBe(
      true,
    );
    expect(
      computeIngressDemandOperation.input.safeParse({ protocolVersion: 1, revisions: [{ ...revision, active: -1 }] })
        .success,
    ).toBe(false);
    expect(computeStreamCheckOperation.input.safeParse({ protocolVersion: 1, intents: [] }).success).toBe(false);
    expect(
      computeStreamCheckOperation.input.safeParse({ protocolVersion: 1, intents: Array(101).fill("a.b") }).success,
    ).toBe(false);
    // A worker from before ingress versioning omits the list; it serves no current protocol.
    const shape = computeWorkerHelloSchema.shape.capabilities;
    const capabilities = {
      operatingSystem: "linux",
      architecture: "amd64",
      sandbox: "runsc",
      policyVersion: 1,
      scratchQuota: true,
      egressGuard: true,
      independentWatchdog: true,
    };
    expect(shape.safeParse(capabilities).success).toBe(true);
    expect(shape.safeParse({ ...capabilities, ingressProtocols: [1] }).success).toBe(true);
    expect(shape.safeParse({ ...capabilities, ingressProtocols: [] }).success).toBe(false);
  });
  it("routes, waits for or refuses an intent the way every gateway does", async () => {
    const { computeRouteDecision, computeRouteIntentSchema } = await import("./index.js");
    const parsed = computeRouteIntentSchema.parse(intent());
    const grant = {
      protocolVersion: 1 as const,
      binding,
      workloadName: "web",
      routeGeneration: 3,
      candidate: false,
      concurrency: 20,
      issuedAt: at(0),
      expiresAt: at(30),
      signature: "s".repeat(86),
    };
    const ready = { state: "ready" as const, endpoint: "https://compute-host:9445/", ingressProtocols: [1], grant };
    const revision = {
      revisionId: binding.revisionId,
      appId: binding.appId,
      environment: "production" as const,
      developmentSessionId: null,
      workloadName: "web",
      routeGeneration: 3,
      serving: "active" as const,
      paused: false,
      concurrency: 20,
      instances: [ready, { ...ready, state: "draining" as const }],
    };
    const fresh = { generatedAt: at(1) },
      stale = { generatedAt: at(-1) };
    expect(computeRouteDecision(fresh, revision, parsed)).toEqual({ kind: "route", copies: [ready] });
    expect(computeRouteDecision(stale, undefined, parsed)).toEqual({ kind: "wait", reason: "stale" });
    expect(computeRouteDecision(fresh, undefined, parsed)).toMatchObject({ code: "COMPUTE_REVISION_UNAVAILABLE" });
    expect(computeRouteDecision(fresh, { ...revision, instances: [] }, parsed)).toEqual({
      kind: "wait",
      reason: "starting",
    });
    // A newer route generation (a pause, resume or publication) retires the intent; an older table waits.
    expect(computeRouteDecision(fresh, { ...revision, routeGeneration: 4 }, parsed)).toMatchObject({ kind: "refuse" });
    expect(computeRouteDecision(fresh, { ...revision, routeGeneration: 2 }, parsed)).toEqual({
      kind: "wait",
      reason: "stale",
    });
    expect(computeRouteDecision(fresh, { ...revision, paused: true }, parsed)).toMatchObject({
      code: "COMPUTE_SERVICE_UNAVAILABLE",
    });
    expect(computeRouteDecision(fresh, { ...revision, serving: "retired" }, parsed)).toMatchObject({ kind: "refuse" });
    expect(computeRouteDecision(fresh, { ...revision, serving: "candidate" }, parsed)).toMatchObject({
      kind: "refuse",
    });
    expect(computeRouteDecision(fresh, { ...revision, workloadName: "other" }, parsed)).toMatchObject({
      code: "COMPUTE_AUTHORITY_REVOKED",
    });
    // Candidate copies take only candidate intents; a host must serve the gateway's protocol.
    const candidate = { ...ready, grant: { ...grant, candidate: true } };
    expect(computeRouteDecision(fresh, { ...revision, instances: [candidate] }, parsed).kind).toBe("wait");
    expect(
      computeRouteDecision(
        fresh,
        { ...revision, serving: "candidate", instances: [candidate] },
        {
          ...parsed,
          candidate: true,
        },
      ).kind,
    ).toBe("route");
    expect(
      computeRouteDecision(fresh, { ...revision, instances: [{ ...ready, ingressProtocols: [] }] }, parsed),
    ).toEqual({ kind: "wait", reason: "starting" });
  });
});
