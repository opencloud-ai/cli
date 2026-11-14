import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors.js";
import { draftValidationWaitTimeoutMs, waitForDraftValidation } from "./draft-validation.js";
import type { ControlPlaneTransport } from "./transport.js";

const appId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const draftId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const input = { appId, draftId, body: { expectedRevision: 2 } };
const result = { draftId, revision: 2, passed: true };
const busyBody = { code: "DRAFT_VALIDATION_IN_PROGRESS", retryable: true,
  details: { appId, draftId, revision: 2, retryAfterSeconds: 2 } };
const busy = () => new ApiError(429, busyBody);
const client = (call: ReturnType<typeof vi.fn>) => ({ call }) as unknown as Pick<ControlPlaneTransport, "call">;
afterEach(() => vi.useRealTimers());

describe("explicit draft validation waiting", () => {
  it("pins an unknown revision with a normal read and serially joins only explicit busy responses", async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockResolvedValueOnce({ revision: 2 }).mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy()).mockResolvedValueOnce(result);
    const progress = vi.fn();
    const promise = waitForDraftValidation(client(call), { appId, draftId, body: { version: "legacy" } },
      { idempotencyKey: "same-key", onProgress: progress });
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(promise).resolves.toBe(result);
    expect(call.mock.calls.map(value => value[0])).toEqual(["getDraft", "validateDraft", "validateDraft", "validateDraft"]);
    for (const [, sent, options] of call.mock.calls.slice(1)) {
      expect(sent).toEqual({ appId, draftId, body: { version: "legacy", expectedRevision: 2 } });
      expect(options).toMatchObject({ timeoutMs: 30_000, idempotencyKey: "same-key" });
    }
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it.each([
    new DOMException("response lost", "TimeoutError"),
    new TypeError("fetch failed"),
    new ApiError(401, { code: "unauthorized" }),
    new ApiError(429, { code: "rate_limited", retryable: true }),
    new ApiError(429, { ...busyBody, retryable: false }),
    new ApiError(429, { ...busyBody, details: { ...busyBody.details, revision: 3 } }),
    new ApiError(429, { ...busyBody, details: { ...busyBody.details, appId: draftId } }),
    new ApiError(429, { ...busyBody, details: { ...busyBody.details, retryAfterSeconds: 0 } }),
    new ApiError(429, { code: "DRAFT_VALIDATION_IN_PROGRESS" }),
    new ApiError(409, { code: "DRAFT_REVISION_CHANGED", retryable: false }),
  ])("does not retry uncertain, unrelated, malformed or changed-coordinate responses", async error => {
    const call = vi.fn().mockRejectedValue(error);
    await expect(waitForDraftValidation(client(call), input)).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("stops at the total budget without starting a request which cannot finish", async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 25_000)); throw busy(); });
    const promise = waitForDraftValidation(client(call), input, { timeoutMs: 30_000 });
    const assertion = expect(promise).rejects.toMatchObject({ code: "DRAFT_VALIDATION_WAIT_TIMEOUT", revision: 2 });
    await vi.advanceTimersByTimeAsync(25_000);
    await assertion;
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("stops a caller cancellation during the delay without another POST", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("caller stopped waiting");
    const call = vi.fn().mockRejectedValue(busy());
    const promise = waitForDraftValidation(client(call), input, { signal: controller.signal });
    const assertion = expect(promise).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    await assertion;
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects success for another revision and preserves a definite validation failure", async () => {
    const changed = vi.fn().mockResolvedValue({ ...result, revision: 3 });
    await expect(waitForDraftValidation(client(changed), input)).rejects.toThrow("different draft revision");
    const failed = { ...result, passed: false };
    await expect(waitForDraftValidation(client(vi.fn().mockResolvedValue(failed)), input)).resolves.toBe(failed);
  });

  it("derives total budgets from the actual workload count without deduplicating images", () => {
    expect(draftValidationWaitTimeoutMs({ containerCount: 1, frontendBuild: false })).toBe(360_000);
    expect(draftValidationWaitTimeoutMs({ containerCount: 10, frontendBuild: false })).toBe(3_060_000);
    expect(draftValidationWaitTimeoutMs({ containerCount: 10, frontendBuild: true })).toBe(3_600_000);
    expect(draftValidationWaitTimeoutMs()).toBe(3_600_000);
    expect(() => draftValidationWaitTimeoutMs({ containerCount: 11, frontendBuild: false })).toThrow(RangeError);
  });
});
