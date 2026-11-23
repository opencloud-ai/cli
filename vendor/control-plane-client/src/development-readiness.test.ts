import { afterEach, describe, expect, it, vi } from "vitest";
import { developmentReadinessTimeoutMs } from "@opencloud/contracts/control-plane";
import { OpenCloudClient } from "./index.js";

const appId = "11111111-1111-4111-8111-111111111111";
const draftId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const now = "2026-11-14T00:00:00.000Z";
const session = {
  id: sessionId, appId, draftId, status: "active", baseDeploymentId: null,
  previewUrl: "https://dev.example.test", browserPreviewUrl: "https://example.test/dev/review",
  activeRevision: { id: draftId, draftRevision: 3, artifactSha256: "a".repeat(64), migrationDigest: "b".repeat(64) },
  verification: null, capabilities: { frontend: true, database: true, functions: true, jobs: true, files: true,
    productionSecrets: false, cron: false, syntheticAuth: true, emailCapture: true, emailInboundInjection: true, notificationCapture: true },
  createdAt: now, updatedAt: now, lastActivityAt: now, expiresAt: "2026-11-15T00:00:00.000Z",
};
afterEach(() => vi.useRealTimers());

function slowTransport() {
  return vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json(session)), 601_000);
    init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
  }));
}

describe("explicit development readiness allowance", () => {
  it.each(["startDevSession", "applyDevRevision"] as const)("allows %s past 30, 120 and 300 seconds with a caller-supplied long-response transport", async operation => {
    vi.useFakeTimers();
    const fetcher = slowTransport();
    const client = new OpenCloudClient({ apiUrl: "https://api.example.test", token: "test-token", fetch: fetcher });
    const input = operation === "startDevSession" ? { appId, draftId, body: { apply: true } } : { appId, sessionId };
    const pending = client.call(operation, input, { timeoutMs: developmentReadinessTimeoutMs });
    await vi.advanceTimersByTimeAsync(301_000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(300_000);
    await expect(pending).resolves.toEqual(session);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("preserves the generic 30-second default and never retries a timed-out write", async () => {
    vi.useFakeTimers();
    const fetcher = slowTransport();
    const client = new OpenCloudClient({ apiUrl: "https://api.example.test", token: "test-token", fetch: fetcher });
    const rejected = expect(client.call("applyDevRevision", { appId, sessionId })).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
