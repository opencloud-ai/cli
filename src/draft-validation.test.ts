import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type OpenCloudClient } from "./api-client.js";
import { validateDraftWithProgress } from "./draft-validation.js";
import type { SafeMutationCheckpoint, SafeValidationCheckpoint } from "./mutation-journal.js";

const appId = "11111111-1111-4111-8111-111111111111", draftId = "22222222-2222-4222-8222-222222222222";
const busy = new ApiError(429, { code: "DRAFT_VALIDATION_IN_PROGRESS", retryable: true,
  details: { appId, draftId, revision: 3, retryAfterSeconds: 2 } });
const result = { id: "33333333-3333-4333-8333-333333333333", draftId, revision: 3, passed: true, artifactSha256: "a".repeat(64) };
function journal(checkpoint: SafeMutationCheckpoint | null = null) {
  let retained = checkpoint;
  return {
    get checkpoint() { return retained; },
    checkpointValidation: vi.fn(async (validation: SafeValidationCheckpoint) => { retained = { stage: "validating", validation }; }),
    markAttempted: vi.fn(async () => {}),
    failIfUnknown: vi.fn(() => {
      if (retained?.validation?.state === "dispatched") throw new Error("unacknowledged validation dispatch");
    }),
    markUnknown: vi.fn(async (): Promise<never> => { throw new Error("journal outcome is uncertain"); }),
  };
}
const input = () => ({ appId, draftId, revision: 3, idempotencyKey: "journal-key-1", manifest: { containerCount: 10, frontendBuild: false },
  journal: journal() });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("CLI authoritative validation", () => {
  it("waits visibly through exact busy responses and preserves the revision and key", async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const call = vi.fn().mockRejectedValueOnce(busy).mockRejectedValueOnce(busy).mockResolvedValue(result), request = input();
    const pending = validateDraftWithProgress({ call } as unknown as OpenCloudClient, request);
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(pending).resolves.toEqual(result);
    expect(call).toHaveBeenCalledTimes(3);
    for (const args of call.mock.calls) expect(args).toEqual(["validateDraft", { appId, draftId, body: { expectedRevision: 3 } },
      { idempotencyKey: "journal-key-1", timeoutMs: 30_000 }]);
    expect(stderr).toHaveBeenCalledOnce();
    expect(String(stderr.mock.calls[0]![0])).toContain(`draft ${draftId}, revision 3`);
    expect(request.journal.markUnknown).not.toHaveBeenCalled();
    expect(request.journal.checkpointValidation.mock.calls.map(([value]) => value.state)).toEqual([
      "dispatched", "progress", "dispatched", "progress", "dispatched", "result",
    ]);
    const deadlines = request.journal.checkpointValidation.mock.calls.map(([value]) => value.deadline);
    expect(new Set(deadlines).size).toBe(1);
    expect(request.journal.checkpoint?.validation).toMatchObject({ state: "result", validationId: result.id, passed: true, artifactSha256: result.artifactSha256 });
  });

  it("writes dispatch before transport and refuses reopening it without any request", async () => {
    const request = input();
    const call = vi.fn(async () => {
      expect(request.journal.checkpoint?.validation?.state).toBe("dispatched");
      throw new TypeError("reply lost");
    });
    await expect(validateDraftWithProgress({ call } as unknown as OpenCloudClient, request)).rejects.toThrow("journal outcome is uncertain");
    const reopened = { ...request, journal: journal(structuredClone(request.journal.checkpoint)) };
    const retry = vi.fn();
    await expect(validateDraftWithProgress({ call: retry } as unknown as OpenCloudClient, reopened)).rejects.toThrow("unacknowledged validation dispatch");
    expect(retry).not.toHaveBeenCalled();
  });

  it("resumes only acknowledged progress with its original delay, request and total deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const request = input(), call = vi.fn().mockRejectedValueOnce(busy).mockResolvedValue(result);
    const first = validateDraftWithProgress({ call } as unknown as OpenCloudClient, request);
    await vi.advanceTimersByTimeAsync(2_000);
    await first;
    const progress = request.journal.checkpointValidation.mock.calls.find(([value]) => value.state === "progress")![0];
    vi.setSystemTime(Date.parse((progress as { retryNotBefore: string }).retryNotBefore) - 1_000);
    const resumed = { ...request, journal: journal({ stage: "draft_ready", validation: progress }) };
    const retry = vi.fn().mockResolvedValue(result);
    const pending = validateDraftWithProgress({ call: retry } as unknown as OpenCloudClient, resumed);
    await vi.advanceTimersByTimeAsync(999);
    expect(retry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(result);
    expect(retry).toHaveBeenCalledOnce();
    expect(resumed.journal.checkpoint?.validation?.deadline).toBe(progress.deadline);
    const mismatch = { ...request, version: "changed", journal: journal({ stage: "draft_ready", validation: progress }) };
    await expect(validateDraftWithProgress({ call: retry } as unknown as OpenCloudClient, mismatch)).rejects.toMatchObject({ code: "MUTATION_REPLAY_MISMATCH" });
    vi.setSystemTime(Date.parse(progress.deadline));
    await expect(validateDraftWithProgress({ call: retry } as unknown as OpenCloudClient,
      { ...request, journal: journal({ stage: "draft_ready", validation: progress }) })).rejects.toMatchObject({ code: "DRAFT_VALIDATION_WAIT_TIMEOUT" });
    expect(retry).toHaveBeenCalledOnce();
  });

  it.each([new DOMException("Timed out", "TimeoutError"), new TypeError("fetch failed"), new Error("Malformed successful response")])(
    "records an uncertain reply and never issues another request", async error => {
      const call = vi.fn().mockRejectedValue(error), request = input();
      await expect(validateDraftWithProgress({ call } as unknown as OpenCloudClient, request)).rejects.toThrow("journal outcome is uncertain");
      expect(call).toHaveBeenCalledOnce();
      expect(request.journal.markUnknown).toHaveBeenCalledExactlyOnceWith("DRAFT_VALIDATION_OUTCOME_UNKNOWN");
    });

  it.each([new ApiError(429, { code: "FRONTEND_BUILD_BUSY", retryable: true }), new ApiError(429, { code: "RATE_LIMITED" }),
    new ApiError(409, { code: "DRAFT_REVISION_CHANGED" }), new ApiError(403, { code: "forbidden" })])(
    "stops on unrelated rate limits, old busy responses, changed revisions and revoked access", async error => {
      const call = vi.fn().mockRejectedValue(error), request = input();
      await expect(validateDraftWithProgress({ call } as unknown as OpenCloudClient, request)).rejects.toBe(error);
      expect(call).toHaveBeenCalledOnce();
      expect(request.journal.markUnknown).not.toHaveBeenCalled();
    });
});
