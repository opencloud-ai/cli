import { describe, expect, it, vi } from "vitest";
import { OpenCloudClient } from "./index.js";

describe("OpenCloudClient", () => {
  it("sends only request headers required by the operation", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push(init ?? {});
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new OpenCloudClient({
      apiUrl: "https://api.opencloud.ai",
      token: "test-token",
      fetch: fetcher,
    });

    await client.get("/v1/apps");

    const init = requests[0];
    const headers = new Headers(init?.headers);
    expect(headers.has("x-opencloud-client-capabilities")).toBe(false);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(init?.credentials).toBeUndefined();
  });

  it("preserves the legacy mutation and deployment upload surface", async () => {
    const fetcher = vi.fn(async () => Response.json({ accepted: true }));
    const client = new OpenCloudClient({
      apiUrl: "https://api.opencloud.ai/",
      token: "test-token",
      fetch: fetcher as typeof fetch,
    });

    await client.post("/v1/apps", { name: "Example" }, "post-key");
    await client.uploadDeployment(
      "11111111-1111-4111-8111-111111111111",
      { schemaVersion: 3 },
      Buffer.from("archive"),
      "upload-key",
    );

    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.opencloud.ai/v1/apps");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ name: "Example" }),
    });
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("idempotency-key"),
    ).toBe("post-key");

    const upload = fetcher.mock.calls[1]?.[1];
    expect(upload?.body).toBeInstanceOf(FormData);
    expect(new Headers(upload?.headers).get("authorization")).toBe(
      "Bearer test-token",
    );
    expect(new Headers(upload?.headers).get("idempotency-key")).toBe(
      "upload-key",
    );
    expect((upload?.body as FormData).get("manifest")).toBe(
      JSON.stringify({ schemaVersion: 3 }),
    );
  });

  it("retains the deployment upload credential gate", async () => {
    const fetcher = vi.fn(async () => Response.json({ accepted: true }));
    const client = new OpenCloudClient({
      apiUrl: "https://api.opencloud.ai",
      fetch: fetcher as typeof fetch,
    });

    await expect(
      client.uploadDeployment(
        "11111111-1111-4111-8111-111111111111",
        { schemaVersion: 3 },
        Buffer.from("archive"),
      ),
    ).rejects.toThrow("An OpenCloud credential is required");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects deployment upload when the token provider resolves no credential", async () => {
    const fetcher = vi.fn(async () => Response.json({ accepted: true }));
    const tokenProvider = vi.fn(async () => undefined);
    const client = new OpenCloudClient({
      apiUrl: "https://api.opencloud.ai",
      tokenProvider,
      fetch: fetcher as typeof fetch,
    });

    await expect(
      client.uploadDeployment(
        "11111111-1111-4111-8111-111111111111",
        { schemaVersion: 3 },
        Buffer.from("archive"),
      ),
    ).rejects.toThrow("An OpenCloud credential is required");
    expect(tokenProvider).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("adapts typed Web Push history list and detail operations", async () => {
    const appId = "22222222-2222-4222-8222-222222222222";
    const messageId = "33333333-3333-4333-8333-333333333333";
    const requests: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      const detail = url.endsWith(`/messages/${messageId}`);
      return new Response(
        JSON.stringify(
          detail
            ? {
                schemaVersion: 1,
                id: messageId,
                appId,
                deploymentId: null,
                userId: "11111111-1111-4111-8111-111111111111",
                title: "Report ready",
                body: null,
                path: "/reports/latest",
                icon: "/_opencloud/notification-icon.png",
                status: "accepted",
                recipientCount: 1,
                acceptedCount: 1,
                failedCount: 0,
                deliveryAttempts: [],
                createdAt: "2026-08-23T00:00:00.000Z",
                updatedAt: "2026-08-23T00:00:01.000Z",
                completedAt: "2026-08-23T00:00:01.000Z",
              }
            : {
                schemaVersion: 1,
                retentionDays: 30,
                messages: [],
                nextCursor: "next-page",
              },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = new OpenCloudClient({
      apiUrl: "https://api.opencloud.ai/",
      token: "test-token",
      fetch: fetcher,
    });

    await expect(
      client.call("listWebPushMessages", {
        appId,
        query: {
          limit: 25,
          userId: "11111111-1111-4111-8111-111111111111",
          status: "accepted",
        },
      }),
    ).resolves.toMatchObject({ retentionDays: 30, nextCursor: "next-page" });
    await expect(
      client.call("getWebPushMessage", { appId, messageId }),
    ).resolves.toMatchObject({ id: messageId, title: "Report ready" });

    expect(requests[0]).toBe(
      `https://api.opencloud.ai/v1/apps/${appId}/notifications/web-push/messages?limit=25&userId=11111111-1111-4111-8111-111111111111&status=accepted`,
    );
    expect(requests[1]).toBe(
      `https://api.opencloud.ai/v1/apps/${appId}/notifications/web-push/messages/${messageId}`,
    );
  });
  it("generates or preserves stable keys for newly registered replay-safe mutations", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = async (
      input: string | URL | Request,
      init: RequestInit = {},
    ) => {
      const url = String(input);
      requests.push({ url, init });
      const body = url.includes("/generate")
        ? { name: "SIGNING_SECRET", stored: true, generatedBytes: 32 }
        : url.includes("/secrets/")
          ? { name: "API_TOKEN", stored: true }
          : {
              approvalUrl:
                "https://auth.opencloud.ai/app-access-token/approve?token=opaque",
              expiresAt: "2026-09-02T12:15:00.000Z",
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new OpenCloudClient({
      apiUrl: "https://api.opencloud.ai",
      token: "test-token",
      fetch: fetcher,
    });
    const appId = "11111111-1111-4111-8111-111111111111";

    await client.call("generateSecret", {
      appId,
      name: "SIGNING_SECRET",
      body: { bytes: 32, encoding: "base64url" },
    });
    await client.call(
      "putSecret",
      { appId, name: "API_TOKEN", body: { value: "synthetic-secret" } },
      { idempotencyKey: "secret-put-request-1" },
    );
    await client.call(
      "requestAppAccessTokenApproval",
      {
        appId,
        body: { name: "Importer", expiresInDays: 90 },
      },
      { idempotencyKey: "approval-request-1" },
    );

    const generatedKey = new Headers(requests[0]?.init.headers).get(
      "idempotency-key",
    );
    expect(generatedKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(new Headers(requests[1]?.init.headers).get("idempotency-key")).toBe(
      "secret-put-request-1",
    );
    expect(new Headers(requests[2]?.init.headers).get("idempotency-key")).toBe(
      "approval-request-1",
    );
  });

  it("can force compatibility-marker revalidation", async () => {
    let request: RequestInit | undefined;
    const client = new OpenCloudClient({
      apiUrl: "https://api.opencloud.ai",
      fetch: async (_input, init) => {
        request = init;
        return new Response(
          JSON.stringify({
            version: "1.2.3",
            commit: "abc123",
            builtAt: "2026-09-02T00:00:00Z",
            releaseId: "platform-v1.2.3",
            contracts: { cliMutationJournal: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await client.call("getPlatformVersion", {}, { cacheControl: "no-cache" });

    expect(new Headers(request?.headers).get("cache-control")).toBe("no-cache");
  });
});
