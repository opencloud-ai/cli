import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type OpenCloudClient } from "./api-client.js";
import { hintOf } from "./cli-contract-error.js";
import { validateDraftWithProgress } from "./draft-validation.js";
import type { PendingMutation, SafeMutationCheckpoint, SafeValidationCheckpoint } from "./mutation-journal.js";

const appId = "11111111-1111-4111-8111-111111111111", draftId = "22222222-2222-4222-8222-222222222222";
const busy = new ApiError(429, { code: "DRAFT_VALIDATION_IN_PROGRESS", retryable: true,
  details: { appId, draftId, revision: 3, retryAfterSeconds: 2 } });
const admissionBusy = new ApiError(503, { code: "APP_LOCK_BUSY", retryable: true,
  message: "Validation admission is busy; this request did not start validation" });
const result = { id: "33333333-3333-4333-8333-333333333333", draftId, revision: 3, passed: true, artifactSha256: "a".repeat(64) };
const settledPending: PendingMutation = { command: "opencloud deploy", idempotencyKey: "journal-key-1", generatedKey: false,
  state: "completed", appId, draftId, revision: 3 };
function journal(checkpoint: SafeMutationCheckpoint | null = null) {
  let retained = checkpoint;
  return {
    get checkpoint() { return retained; },
    checkpointValidation: vi.fn(async (validation: SafeValidationCheckpoint) => {
      retained = { ...(retained ?? { stage: "validating" }), validation };
    }),
    markAttempted: vi.fn(async () => {}),
    failIfUnknown: vi.fn(() => {}),
    settleValidation: vi.fn(async (outcome: "waiting" | "refused") => {
      retained = { ...(retained ?? { stage: "validating" }), stage: outcome === "waiting" ? "validation_waiting" : "validation_refused" };
      return settledPending;
    }),
  };
}
/** The same run's journal as the next process reads it. */
const reopen = (previous: ReturnType<typeof journal>) => journal(structuredClone(previous.checkpoint));
const plain = { containerCount: 0, frontendBuild: false };
const input = (manifest = { containerCount: 10, frontendBuild: false }) => ({ appId, draftId, revision: 3,
  idempotencyKey: "journal-key-1", manifest, journal: journal() });
const states = (request: ReturnType<typeof input>) => request.journal.checkpointValidation.mock.calls.map(([value]) => value.state);
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
    expect(request.journal.settleValidation).not.toHaveBeenCalled();
    expect(states(request)).toEqual(["dispatched", "progress", "dispatched", "progress", "dispatched", "result"]);
    const deadlines = request.journal.checkpointValidation.mock.calls.map(([value]) => value.deadline);
    expect(new Set(deadlines).size).toBe(1);
    expect(request.journal.checkpoint?.validation).toMatchObject({ state: "result", validationId: result.id, passed: true, artifactSha256: result.artifactSha256 });
  });

  it("writes dispatch before transport, and sends a request whose reply never came again on the next run", async () => {
    const request = input();
    const call = vi.fn(async () => {
      expect(request.journal.checkpoint?.validation?.state).toBe("dispatched");
      throw new TypeError("reply lost");
    });
    const lost = await validateDraftWithProgress({ call } as unknown as OpenCloudClient, request).catch((error: unknown) => error);
    expect(lost).toBeInstanceOf(TypeError);
    expect(hintOf(lost)).toBe(`OpenCloud may still be validating draft ${draftId}, revision 3. Run the same command again: it validates that revision again and waits for the result.`);
    // Settled, not unknown: it holds nothing back, and the same request rejoins it.
    expect(request.journal.settleValidation).toHaveBeenCalledExactlyOnceWith("waiting");
    const reopened = { ...request, journal: reopen(request.journal) };
    const retry = vi.fn().mockResolvedValue(result);
    await expect(validateDraftWithProgress({ call: retry } as unknown as OpenCloudClient, reopened)).resolves.toEqual(result);
    expect(retry).toHaveBeenCalledExactlyOnceWith("validateDraft", { appId, draftId, body: { expectedRevision: 3 } },
      { idempotencyKey: "journal-key-1", timeoutMs: 30_000 });
    expect(reopened.journal.checkpoint?.validation).toMatchObject({ state: "result", validationId: result.id });
  });

  it("resumes acknowledged progress after its delay, and opens a fresh window once the kept one has passed", async () => {
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
    // Time was left in the kept window, so it was kept.
    expect(resumed.journal.checkpoint?.validation?.deadline).toBe(progress.deadline);
    const mismatch = { ...request, version: "changed", journal: journal({ stage: "draft_ready", validation: progress }) };
    await expect(validateDraftWithProgress({ call: retry } as unknown as OpenCloudClient, mismatch)).rejects.toMatchObject({ code: "MUTATION_REPLAY_MISMATCH" });
    // K4: once the kept deadline has passed, the same revision gets a fresh window.
    vi.setSystemTime(Date.parse(progress.deadline) + 1);
    const expired = { ...request, journal: journal({ stage: "validation_waiting", validation: progress }) };
    await expect(validateDraftWithProgress({ call: retry } as unknown as OpenCloudClient, expired)).resolves.toEqual(result);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(Date.parse(expired.journal.checkpoint!.validation!.deadline)).toBeGreaterThan(Date.parse(progress.deadline));
  });

  it("gives a plain app about 90 seconds, then settles the entry with a hint to rejoin", async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const request = input(plain);
    const call = vi.fn().mockRejectedValueOnce(busy).mockRejectedValueOnce(busy).mockResolvedValue(result);
    const joined = validateDraftWithProgress({ call } as unknown as OpenCloudClient, request);
    await vi.advanceTimersByTimeAsync(4_000);
    // 3.21's first plain-app budget was 30 seconds: one busy answer ended it.
    await expect(joined).resolves.toEqual(result);
    const slow = input(plain), still = vi.fn().mockRejectedValue(busy);
    const waiting = validateDraftWithProgress({ call: still } as unknown as OpenCloudClient, slow).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(90_000);
    const timedOut = await waiting;
    expect(timedOut).toMatchObject({ code: "DRAFT_VALIDATION_WAIT_TIMEOUT", retryable: true, pending: settledPending });
    expect(still.mock.calls.length).toBeGreaterThanOrEqual(20);
    expect(slow.journal.settleValidation).toHaveBeenCalledExactlyOnceWith("waiting");
    expect(slow.journal.checkpoint?.validation?.state).toBe("progress");
  });

  it("sends a validation OpenCloud's busy admission did not start again while time allows", async () => {
    vi.useFakeTimers();
    const request = input(plain), call = vi.fn().mockRejectedValueOnce(admissionBusy).mockResolvedValue(result);
    const pending = validateDraftWithProgress({ call } as unknown as OpenCloudClient, request);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual(result);
    expect(call).toHaveBeenCalledTimes(2);
    expect(states(request)).toEqual(["dispatched", "refused", "dispatched", "result"]);
    // Busy to the end: nothing started, and the next run sends it again.
    const stuck = input(plain), always = vi.fn().mockRejectedValue(admissionBusy);
    const ended = validateDraftWithProgress({ call: always } as unknown as OpenCloudClient, stuck).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await ended).toBe(admissionBusy);
    expect(hintOf(admissionBusy)).toMatch(/^OpenCloud was too busy to start validating draft/);
    expect(stuck.journal.settleValidation).toHaveBeenCalledExactlyOnceWith("waiting");
  });

  it.each([new DOMException("Timed out", "TimeoutError"), new TypeError("fetch failed"), new Error("Malformed successful response")])(
    "settles an uncertain reply as waiting, never unknown, without repeating it in the same run", async error => {
      const call = vi.fn().mockRejectedValue(error), request = input();
      await expect(validateDraftWithProgress({ call } as unknown as OpenCloudClient, request)).rejects.toBe(error);
      expect(call).toHaveBeenCalledOnce();
      expect(request.journal.checkpoint?.validation?.state).toBe("dispatched");
      expect(request.journal.settleValidation).toHaveBeenCalledExactlyOnceWith("waiting");
    });

  it.each([
    ...[408, 500, 502, 503, 504].map(status => new ApiError(status, { code: "internal_error" })),
    new ApiError(504, { code: "DRAFT_REVISION_CHANGED", retryable: false }),
    new ApiError(429, { code: "FRONTEND_BUILD_BUSY", retryable: true }),
    new ApiError(429, { code: "RATE_LIMITED" }),
    new ApiError(429, { ...busy.body as object, details: { appId, draftId, revision: 4, retryAfterSeconds: 2 } }),
    new ApiError(404, "<html>proxy</html>"),
    new ApiError(403, { code: "forbidden", retryable: true }),
  ])("settles an HTTP failure that proves nothing as waiting, and the next run sends it again", async error => {
    const call = vi.fn().mockRejectedValue(error), request = input();
    await expect(validateDraftWithProgress({ call } as unknown as OpenCloudClient, request)).rejects.toBe(error);
    expect(call).toHaveBeenCalledOnce();
    expect(request.journal.checkpoint?.validation?.state).toBe("dispatched");
    expect(request.journal.settleValidation).toHaveBeenCalledExactlyOnceWith("waiting");
    const retry = vi.fn().mockResolvedValue(result);
    await expect(validateDraftWithProgress({ call: retry } as unknown as OpenCloudClient,
      { ...request, journal: reopen(request.journal) })).resolves.toEqual(result);
    expect(retry).toHaveBeenCalledOnce();
  });

  it.each([
    [400, "invalid_request"], [400, "bad_request"], [401, "unauthorized"], [403, "forbidden"],
    [404, "not_found"], [405, "method_not_allowed"], [409, "DRAFT_REVISION_CHANGED"],
    [413, "payload_too_large"], [415, "unsupported_media_type"], [409, "conflict"], [422, "COMPUTE_NOT_OFFERED"],
  ] as const)("records the refusal %s/%s, settles the entry and does not retry it", async (status, code) => {
    const error = new ApiError(status, { code });
    const call = vi.fn().mockRejectedValue(error), request = input();
    await expect(validateDraftWithProgress({ call } as unknown as OpenCloudClient, request)).rejects.toBe(error);
    expect(call).toHaveBeenCalledOnce();
    expect(request.journal.checkpoint?.validation?.state).toBe("refused");
    expect(request.journal.settleValidation).toHaveBeenCalledExactlyOnceWith("refused");
  });
});
