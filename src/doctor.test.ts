import { describe, expect, it, vi } from "vitest";
import { doctorDiagnostics } from "./doctor.js";

const base = {
  apiUrl: "http://agent-service:3010/_internal/opencloud/user/app/run",
  token: "oc_run_private-test-token",
  cliVersion: "1.0.0",
  currentDirectory: "/workspace",
  sessionFile: "/run/opencloud/authority/session.json",
  identitySource: "session-file" as const,
  sessionState: "ready",
  appId: "22222222-2222-4222-8222-222222222222",
  credentialExpiresAt: "2026-08-04T21:30:00.000Z",
};

describe("doctor diagnostics", () => {
  it("authenticates the version probe for a brokered run session", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${base.token}`,
      );
      return new Response(JSON.stringify({ version: "staging-test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await doctorDiagnostics(base, request as typeof fetch);
    expect(result).toMatchObject({
      passed: true,
      api: { reachable: true, platform: { version: "staging-test" } },
      identity: { tokenPresent: true, appId: base.appId },
    });
    expect(JSON.stringify(result)).not.toContain(base.token);
    expect(request).toHaveBeenCalledOnce();
  });

  it("never includes a missing credential in the probe or diagnostics", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response(JSON.stringify({ version: "public-test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await doctorDiagnostics(
      { ...base, token: null, identitySource: "none", sessionState: null },
      request as typeof fetch,
    );
    expect(result).toMatchObject({
      passed: false,
      identity: { tokenPresent: false },
    });
    expect(JSON.stringify(result)).not.toContain(base.token);
  });
});
