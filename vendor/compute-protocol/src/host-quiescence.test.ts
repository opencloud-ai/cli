import { describe, expect, it } from "vitest";
import {
  computeProveHostQuiescenceRequestSchema,
  computeProveHostQuiescenceResponseSchema,
  computeWorkerOperations,
  validateComputeHostQuiescenceProof,
} from "./index.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const hash = "a".repeat(64);
const request = { protocolVersion: 1, installationId: id, workerId: id, workerBootId: id, challengeId: id };
const proof = {
  ...request,
  hostBootId: otherId,
  observedAt: "2026-11-13T12:00:00Z",
  expiresAt: "2026-11-13T12:00:05Z",
  configSha256: hash,
  sourceRevision: "b".repeat(40),
  journal: { sha256: hash, headHash: hash, records: 20, cleanedInstances: 2, droppedInstances: 0 },
  daemon: { id: "dedicated-daemon", inventoryScope: "all_containers_in_dedicated_daemon", containers: [] },
  guard: {
    revision: 0,
    policySha256: hash,
    receiptSha256: hash,
    hostBootId: otherId,
    workerBootId: id,
    activeInstances: 0,
    unacknowledgedRetiredAllowances: 0,
    remainingAllowanceRecords: 0,
  },
  safety: { watchdogObservedMonotonicNs: "123456789000", workerPid: 100, workerStartTicks: "123" },
  preparationCount: 0,
  tails: { usage: 0, network: 0, resources: 0, ingressClose: 0, liveSlotReservations: 0 },
  logs: { pendingBatches: 0, pendingGaps: 0, historicalCoverageLost: null },
};

describe("host quiescence proof contract", () => {
  it("exposes a bounded controller evidence operation without mutation authority", () => {
    expect(computeWorkerOperations.proveHostQuiescence).toMatchObject({
      method: "POST",
      path: "/v1/host/quiescence-proof",
      input: computeProveHostQuiescenceRequestSchema,
      output: computeProveHostQuiescenceResponseSchema,
    });
    expect(computeProveHostQuiescenceRequestSchema.parse(request)).toEqual(request);
    for (const invalid of [
      { ...request, protocolVersion: 2 },
      { ...request, challengeId: undefined },
      { ...request, workerBootId: "old" },
      { ...request, force: true },
      { ...request, lease: {} },
    ]) {
      expect(computeProveHostQuiescenceRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("keeps historical proof replay deterministic and log coverage diagnostic", () => {
    expect(computeProveHostQuiescenceResponseSchema.parse(proof)).toEqual(proof);
    for (const historicalCoverageLost of [true, false, null]) {
      const value = { ...proof, logs: { ...proof.logs, historicalCoverageLost } };
      expect(computeProveHostQuiescenceResponseSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    }
    expect(
      computeProveHostQuiescenceResponseSchema.safeParse({
        ...proof,
        journal: { ...proof.journal, records: 1_000_000, cleanedInstances: 10_000 },
      }).success,
    ).toBe(true);
    // A long-lived host counts every instance it ever ran; most were dropped
    // from the journal after their retention window.
    expect(
      computeProveHostQuiescenceResponseSchema.safeParse({
        ...proof,
        journal: { ...proof.journal, records: 20, cleanedInstances: 50_000, droppedInstances: 49_990 },
      }).success,
    ).toBe(true);
    // An earlier worker's proof without the field drops nothing.
    const { droppedInstances: _dropped, ...legacy } = proof.journal;
    expect(computeProveHostQuiescenceResponseSchema.parse({ ...proof, journal: legacy }).journal.droppedInstances).toBe(
      0,
    );
  });

  it("refuses pending physical and delivery obligations rather than accepting partial proof", () => {
    const invalid = [
      { ...proof, preparationCount: 1 },
      { ...proof, daemon: { ...proof.daemon, containers: [{}] } },
      { ...proof, daemon: { ...proof.daemon, inventoryScope: "managed_instances" } },
      ...["activeInstances", "unacknowledgedRetiredAllowances", "remainingAllowanceRecords"].map((field) => ({
        ...proof,
        guard: { ...proof.guard, [field]: 1 },
      })),
      ...Object.keys(proof.tails).map((field) => ({ ...proof, tails: { ...proof.tails, [field]: 1 } })),
      { ...proof, logs: { ...proof.logs, pendingBatches: 1 } },
      { ...proof, logs: { ...proof.logs, pendingGaps: 1 } },
    ];
    for (const value of invalid) expect(computeProveHostQuiescenceResponseSchema.safeParse(value).success).toBe(false);
  });

  it("accepts a preview's uncommitted build revision marked dirty", () => {
    expect(
      computeProveHostQuiescenceResponseSchema.safeParse({ ...proof, sourceRevision: `${"b".repeat(40)}-dirty` })
        .success,
    ).toBe(true);
  });

  it("rejects missing, unknown, malformed and contradictory evidence", () => {
    for (const value of [
      { ...proof, tails: undefined },
      { ...proof, authoritative: true },
      { ...proof, safety: { ...proof.safety, token: "secret" } },
      { ...proof, sourceRevision: "B".repeat(40) },
      { ...proof, sourceRevision: `${"b".repeat(40)}-modified` },
      { ...proof, sourceRevision: `${"b".repeat(39)}-dirty` },
      { ...proof, configSha256: "a".repeat(63) },
      { ...proof, journal: { ...proof.journal, records: 1_000_001 } },
      { ...proof, journal: { ...proof.journal, records: 20, cleanedInstances: 30, droppedInstances: 5 } },
      { ...proof, journal: { ...proof.journal, cleanedInstances: 2, droppedInstances: 3 } },
      { ...proof, journal: { ...proof.journal, droppedInstances: -1 } },
      { ...proof, journal: { ...proof.journal, records: 1 } },
      { ...proof, daemon: { ...proof.daemon, id: "line\nbreak" } },
      { ...proof, daemon: { ...proof.daemon, id: "a".repeat(201) } },
      { ...proof, guard: { ...proof.guard, revision: -1 } },
      { ...proof, guard: { ...proof.guard, revision: Number.MAX_SAFE_INTEGER + 1 } },
      { ...proof, guard: { ...proof.guard, hostBootId: id } },
      { ...proof, guard: { ...proof.guard, workerBootId: otherId } },
      { ...proof, safety: { ...proof.safety, workerPid: 0 } },
      { ...proof, safety: { ...proof.safety, workerStartTicks: "01" } },
      { ...proof, safety: { ...proof.safety, watchdogObservedMonotonicNs: -1 } },
      { ...proof, logs: { ...proof.logs, historicalCoverageLost: undefined } },
      { ...proof, expiresAt: proof.observedAt },
      { ...proof, expiresAt: "2026-11-13T12:00:05.001Z" },
    ])
      expect(computeProveHostQuiescenceResponseSchema.safeParse(value).success).toBe(false);
  });

  it("requires exact live challenge and identity with no freshness tolerance", () => {
    const observed = Date.parse(proof.observedAt),
      expires = Date.parse(proof.expiresAt);
    expect(validateComputeHostQuiescenceProof(request, proof, observed)).toEqual(proof);
    expect(validateComputeHostQuiescenceProof(request, proof, expires - 1)).toEqual(proof);
    for (const now of [observed - 1, expires, expires + 1, NaN, Infinity, -Infinity]) {
      expect(() => validateComputeHostQuiescenceProof(request, proof, now)).toThrow();
    }
    for (const field of ["installationId", "workerId", "workerBootId", "challengeId"] as const) {
      expect(() => validateComputeHostQuiescenceProof({ ...request, [field]: otherId }, proof, observed)).toThrow();
    }
  });
});
