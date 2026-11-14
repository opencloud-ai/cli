import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type OpenCloudClient } from "./api-client.js";
import { validateDraftWithProgress } from "./draft-validation.js";

const appId = "11111111-1111-4111-8111-111111111111", draftId = "22222222-2222-4222-8222-222222222222";
const busy = new ApiError(429, { code: "DRAFT_VALIDATION_IN_PROGRESS", retryable: true,
  details: { appId, draftId, revision: 3, retryAfterSeconds: 2 } });
const result = { draftId, revision: 3, passed: true };
const input = () => ({ appId, draftId, revision: 3, idempotencyKey: "journal-key-1", manifest: { containerCount: 10, frontendBuild: false },
  journal: { markUnknown: vi.fn(async () => { throw new Error("journal outcome is uncertain"); }) } });
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
