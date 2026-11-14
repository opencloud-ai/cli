import { afterEach, describe, expect, it, vi } from "vitest";
import { developmentReadinessTimeoutMs } from "@opencloud/contracts/control-plane";
import { ApiError, type OpenCloudClient } from "./api-client.js";
import type { SafeMutationCheckpoint } from "./mutation-journal.js";
import { applyDevRevisionOnce, resumeDevApply } from "./dev-readiness.js";

const appId = "11111111-1111-4111-8111-111111111111";
const draftId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const activeRevisionId = "44444444-4444-4444-8444-444444444444";
const target = { appId, draftId, sessionId, revision: 3, artifactSha256: "a".repeat(64),
  serverArtifactSha256: "b".repeat(64), baseDeploymentId: null };
const active = { id: activeRevisionId, draftRevision: 3, artifactSha256: target.serverArtifactSha256 };
const session = (ready = true) => ({ id: sessionId, appId, draftId, baseDeploymentId: null, status: "active", activeRevision: ready ? active : null });
const draft = () => ({ id: draftId, appId, revision: 3 });
const app = () => ({ id: appId, activeDeploymentId: null, desiredDeploymentId: null });
function checkpoint(): SafeMutationCheckpoint {
  return { stage: "dev_apply_dispatched", artifactSha256: target.artifactSha256, serverArtifactSha256: target.serverArtifactSha256,
    draftId, sessionId, revision: 3, baseDeploymentId: null, devApplyDeadline: new Date(Date.now() + developmentReadinessTimeoutMs).toISOString() };
}
function journal(initial: SafeMutationCheckpoint | null = null) {
  let retained = initial;
  return {
    get checkpoint() { return retained; },
    checkpointStage: vi.fn(async (value: SafeMutationCheckpoint) => { retained = structuredClone(value); }),
    markAttempted: vi.fn(async () => {}),
    markUnknown: vi.fn(async (code: string): Promise<never> => { throw new Error(code); }),
  };
}
function control(responder?: (operation: string, input: unknown, options: unknown) => unknown) {
  const call = vi.fn(async (operation: string, input: unknown, options: unknown) => {
    const custom = responder?.(operation, input, options);
    if (custom !== undefined) return custom;
    if (operation === "getDevSession" || operation === "applyDevRevision") return session();
    if (operation === "getDraft") return draft();
    if (operation === "getApp") return app();
    throw new Error(`Unexpected operation ${operation}`);
  });
  return { client: { call } as unknown as OpenCloudClient, call };
}
const resumeInput = { appId, artifactSha256: target.artifactSha256, sessionId, draftId };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("development readiness without apply replay", () => {
  it("checkpoints the exact server identity before one apply lasting beyond 30, 120 and 300 seconds", async () => {
    vi.useFakeTimers();
    const run = journal();
    let applied = false;
    const c = control((operation, _input, options) => {
      if (operation === "getDevSession") return session(applied);
      if (operation !== "applyDevRevision") return;
      expect(run.checkpoint).toEqual(checkpoint());
      expect(run.markAttempted).toHaveBeenCalledOnce();
      expect(options).toEqual({ idempotencyKey: "exact-apply-key", timeoutMs: 900_000 });
      return new Promise(resolve => setTimeout(() => { applied = true; resolve(session()); }, 601_000));
    });
    const pending = applyDevRevisionOnce(c.client, run, target, "exact-apply-key");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run.checkpoint?.stage).toBe("dev_apply_dispatched");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual(session());
    expect(c.call.mock.calls.filter(([name]) => name === "applyDevRevision")).toHaveLength(1);
    expect(run.checkpoint).toMatchObject({ stage: "dev_apply_ready", activeRevisionId, serverArtifactSha256: target.serverArtifactSha256 });
  });

  it("uses only exact reads after a lost apply reply and tolerates a lost read reply", async () => {
    vi.useFakeTimers();
    const run = journal();
    let applied = false, readLost = false;
    const c = control(operation => {
      if (operation === "applyDevRevision") { applied = true; throw new TypeError("reply lost"); }
      if (operation === "getDevSession") {
        if (applied && !readLost) { readLost = true; throw new TypeError("read reply lost"); }
        return session(applied);
      }
    });
    const pending = applyDevRevisionOnce(c.client, run, target, "same-key");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual(session());
    const names = c.call.mock.calls.map(([name]) => name);
    expect(names.slice(names.indexOf("applyDevRevision") + 1).every(name => name.startsWith("get"))).toBe(true);
    expect(names.filter(name => name === "applyDevRevision")).toHaveLength(1);
  });

  it("resumes a retained dispatch without another validation or apply and without extending its deadline", async () => {
    vi.useFakeTimers();
    const saved = checkpoint(), run = journal(saved);
    vi.setSystemTime(Date.now() + 899_000);
    const c = control(operation => operation === "getDevSession" ? session(false) : undefined);
    const pending = resumeDevApply(c.client, run, resumeInput);
    const rejected = expect(pending).rejects.toThrow("DEV_APPLY_OUTCOME_UNKNOWN");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(c.call.mock.calls.map(([name]) => name)).toEqual(["getDevSession", "getDraft", "getApp"]);
    expect(run.checkpoint).toEqual(saved);
    expect(run.checkpointStage).not.toHaveBeenCalled();
    await expect(resumeDevApply(c.client, run, resumeInput)).rejects.toThrow("DEV_APPLY_OUTCOME_UNKNOWN");
    expect(c.call).toHaveBeenCalledTimes(3);
  });

  it("stops without dispatch when the original budget expires while persisting the intent", async () => {
    vi.useFakeTimers();
    const run = journal(), c = control();
    run.markAttempted.mockImplementation(async () => { vi.setSystemTime(Date.now() + 900_000); });
    await expect(applyDevRevisionOnce(c.client, run, target, "key")).rejects.toThrow("DEV_APPLY_OUTCOME_UNKNOWN");
    expect(c.call.mock.calls.some(([name]) => name === "applyDevRevision")).toBe(false);
  });

  it("rechecks a previously confirmed receipt once after the pending budget, without renewing it", async () => {
    vi.useFakeTimers();
    const saved = { ...checkpoint(), stage: "dev_apply_ready", activeRevisionId }, run = journal(saved), c = control();
    vi.setSystemTime(Date.now() + 3_600_000);
    await expect(resumeDevApply(c.client, run, resumeInput)).resolves.toEqual(session());
    expect(c.call.mock.calls.map(([name]) => name)).toEqual(["getDevSession", "getDraft", "getApp"]);
    expect(c.call.mock.calls.every(([, , options]) => options.timeoutMs === 30_000)).toBe(true);
    expect(run.checkpoint).toEqual(saved);
    expect(run.checkpointStage).not.toHaveBeenCalled();
    const changed = control(operation => operation === "getDevSession" ? { ...session(), activeRevision: { ...active, id: draftId } } : undefined);
    await expect(resumeDevApply(changed.client, run, resumeInput)).rejects.toMatchObject({ code: "MUTATION_REPLAY_MISMATCH" });
  });

  it.each([
    ["different session", { ...session(), id: draftId }, undefined, undefined],
    ["different draft", { ...session(), draftId: appId }, undefined, undefined],
    ["stopped", { ...session(), status: "stopped" }, undefined, undefined],
    ["stale", { ...session(), status: "stale" }, undefined, undefined],
    ["different session base", { ...session(), baseDeploymentId: appId }, undefined, undefined],
    ["different active revision", { ...session(), activeRevision: { ...active, draftRevision: 4 } }, undefined, undefined],
    ["different server artifact", { ...session(), activeRevision: { ...active, artifactSha256: "c".repeat(64) } }, undefined, undefined],
    ["edited draft", undefined, { ...draft(), revision: 4 }, undefined],
    ["different app base", undefined, undefined, { ...app(), activeDeploymentId: appId }],
    ["new release preparing", undefined, undefined, { ...app(), desiredDeploymentId: appId }],
  ])("refuses %s as success and never reapplies", async (_label, observedSession, observedDraft, observedApp) => {
    const run = journal(checkpoint());
    const c = control(operation => ({ getDevSession: observedSession, getDraft: observedDraft, getApp: observedApp })[operation]);
    await expect(resumeDevApply(c.client, run, resumeInput)).rejects.toMatchObject({ code: "MUTATION_REPLAY_MISMATCH" });
    expect(c.call.mock.calls.every(([name]) => name.startsWith("get"))).toBe(true);
    expect(run.checkpointStage).not.toHaveBeenCalled();
  });

  it.each([new ApiError(403, { code: "forbidden" }), new ApiError(409, { code: "ACTIVE_DEPLOYMENT_CHANGED" })])(
    "keeps explicit API refusal visible and never converts revoked authority into success", async error => {
      const run = journal(checkpoint()), c = control(() => { throw error; });
      await expect(resumeDevApply(c.client, run, resumeInput)).rejects.toBe(error);
      expect(c.call).toHaveBeenCalledOnce();
      expect(run.checkpointStage).not.toHaveBeenCalled();
    });

  it("retains explicit apply diagnostics but subsequent recovery remains read-only", async () => {
    const run = journal();
    const error = new ApiError(409, { code: "DEV_REVISION_FAILED", details: { phase: "readiness" } });
    const c = control(operation => { if (operation === "applyDevRevision") throw error; });
    await expect(applyDevRevisionOnce(c.client, run, target, "key")).rejects.toBe(error);
    expect(run.checkpoint?.stage).toBe("dev_apply_dispatched");
    const recovered = control();
    await expect(resumeDevApply(recovered.client, run, resumeInput)).resolves.toEqual(session());
    expect(recovered.call.mock.calls.every(([name]) => name.startsWith("get"))).toBe(true);
  });

  it("rejects changed local identity and missing or forged recovery coordinates before any request", async () => {
    vi.useFakeTimers();
    for (const saved of [
      { ...checkpoint(), artifactSha256: "c".repeat(64) },
      { ...checkpoint(), serverArtifactSha256: undefined },
      { ...checkpoint(), devApplyDeadline: new Date(Date.now() + 900_001).toISOString() },
      { ...checkpoint(), sessionId: draftId },
    ]) {
      const c = control();
      await expect(resumeDevApply(c.client, journal(saved), resumeInput)).rejects.toMatchObject({ code: "MUTATION_REPLAY_MISMATCH" });
      expect(c.call).not.toHaveBeenCalled();
    }
  });
});
