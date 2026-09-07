import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpenCloudClient } from "./api-client.js";
import { followOperation } from "./owner-parity.js";
import { runtimeSessionTokenProvider } from "./runtime-session-token.js";
import { loadSession, type OpenCloudSession, type RuntimeAppOwnerReadyAgentSession } from "./session-store.js";

const initial: RuntimeAppOwnerReadyAgentSession = {
  schemaVersion: 2, state: "ready", authorityMode: "app_owner_v1",
  apiUrl: "https://api.example.test", appId: "11111111-1111-4111-8111-111111111111",
  rootRunId: "22222222-2222-4222-8222-222222222222",
  familyId: "33333333-3333-4333-8333-333333333333",
  token: "synthetic-old-token", credentialExpiresAt: "2099-01-01T00:00:00Z",
};

describe("runtime session rotation", () => {
  it("follows one accepted operation using the atomically replaced credential", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencloud-rotation-"));
    const file = path.join(directory, "session.json");
    const requests: { method: string; token: string | null }[] = [];
    try {
      await writeFile(file, JSON.stringify(initial), { mode: 0o600 });
      const operation = { id: "44444444-4444-4444-8444-444444444444", state: "queued" };
      const client = new OpenCloudClient({
        apiUrl: initial.apiUrl,
        tokenProvider: runtimeSessionTokenProvider(initial, () => loadSession(file)),
        fetch: async (_url, options) => {
          const token = new Headers(options?.headers).get("authorization");
          requests.push({ method: options?.method ?? "GET", token });
          if (options?.method === "POST") {
            await writeFile(`${file}.next`, JSON.stringify({ ...initial, token: "synthetic-new-token" }), { mode: 0o600 });
            await rename(`${file}.next`, file);
            return Response.json({ operation });
          }
          if (token !== "Bearer synthetic-new-token") return Response.json({}, { status: 401 });
          return Response.json({ operation: { ...operation, state: "succeeded" } });
        },
      });
      const started = await client.post(`/v1/apps/${initial.appId}/verify`, {}, "synthetic-rotation-key");
      const result = await followOperation({ client, started, options: { follow: true, interval: "15", timeout: "60" }, sleep: async () => {} });
      expect(result).toMatchObject({ operation: { id: operation.id, state: "succeeded" } });
      expect(requests).toEqual([
        { method: "POST", token: "Bearer synthetic-old-token" },
        { method: "GET", token: "Bearer synthetic-new-token" },
      ]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([
    null,
    { ...initial, appId: "55555555-5555-4555-8555-555555555555" },
    { ...initial, rootRunId: "55555555-5555-4555-8555-555555555555" },
    { ...initial, familyId: "55555555-5555-4555-8555-555555555555" },
    { ...initial, apiUrl: "https://other.example.test" },
    { schemaVersion: 1, state: "ready", apiUrl: initial.apiUrl, appId: initial.appId, token: "synthetic-other-token", credentialExpiresAt: initial.credentialExpiresAt, appUrl: "https://example.test" },
  ] as (OpenCloudSession | null)[])("rejects a missing or replaced authority before sending", async current => {
    let sent = false;
    const client = new OpenCloudClient({ apiUrl: initial.apiUrl,
      tokenProvider: runtimeSessionTokenProvider(initial, () => current),
      fetch: async () => { sent = true; return Response.json({}); },
    });
    await expect(client.get("/v1/operations/synthetic")).rejects.toThrow("Runtime session authority changed");
    expect(sent).toBe(false);
  });
});
