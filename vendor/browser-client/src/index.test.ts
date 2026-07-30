import { describe, expect, it, vi } from "vitest";
import {
  createOpenCloudClient,
  type OpenCloudRuntimeConfig,
} from "./index.js";

const origin = "https://tasks.opencloud.ai";
const initialNow = Date.parse("2026-01-01T00:00:00.000Z");

const runtimeConfig: OpenCloudRuntimeConfig = {
  appId: "11111111-1111-4111-8111-111111111111",
  deploymentVersion: "v1",
  visibility: "private",
  supabaseUrl: origin,
  supabaseAnonKey: "anon-project-key",
  storageBucket: "app-11111111-1111-4111-8111-111111111111",
  functionsBasePath: "/functions/v1",
  javascriptSdk: {
    package: "@opencloud/js",
    version: "0.2.2",
    module: "/_opencloud/sdk/js/v0.2.2/index.js",
    types: "/_opencloud/sdk/js/v0.2.2/index.d.ts",
    docs: "https://docs.opencloud.ai/sdk/javascript/",
  },
  browserClient: "/_opencloud/sdk/js/v0.2.2/index.js",
  environment: "prod",
};

function wireSession(
  accessToken: string,
  refreshAfter = "2026-01-01T00:30:00.000Z",
) {
  return {
    appId: runtimeConfig.appId,
    userId: "22222222-2222-4222-8222-222222222222",
    profile: {
      email: "person@example.test",
      displayName: "Test Person",
      avatarUrl: null,
    },
    accessToken,
    accessTokenExpiresAt: "2026-01-01T00:31:00.000Z",
    refreshAfter,
    sessionExpiresAt: "2026-01-31T00:00:00.000Z",
  };
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: Record<string, unknown>[] = [];
  readonly url: string;
  readyState = 0;
  private readonly listeners = new Map<string, Set<(event: never) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(source: string): void {
    const message = JSON.parse(source) as Record<string, unknown>;
    this.sent.push(message);
    if (message.event === "phx_join") {
      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify({
            event: "phx_reply",
            ref: message.ref,
            payload: { status: "ok" },
          }),
        });
      });
    }
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", {});
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as never);
    }
  }
}

function fakeWebSocket(): typeof WebSocket {
  return FakeWebSocket as unknown as typeof WebSocket;
}

describe("@opencloud/js", () => {
  it("keeps access tokens private while owning REST and Storage headers", async () => {
    const runtimeRequests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(
      async (source: URL | RequestInfo, init?: RequestInit) => {
        const url = String(source);
        if (url.endsWith("/_opencloud/config")) {
          return Response.json(runtimeConfig);
        }
        if (url.endsWith("/_opencloud/session/v2")) {
          return Response.json({
            session: wireSession("private-access-token"),
          });
        }
        runtimeRequests.push({ url, init });
        return Response.json({ ok: true });
      },
    ) as unknown as typeof fetch;
    const client = createOpenCloudClient({
      baseUrl: origin,
      fetch: fetchMock,
      WebSocket: fakeWebSocket(),
      automaticSessionRefresh: false,
      now: () => initialNow,
    });

    const session = await client.session();
    expect(session).toMatchObject({
      userId: "22222222-2222-4222-8222-222222222222",
      profile: { displayName: "Test Person" },
      accessTokenExpiresAt: "2026-01-01T00:31:00.000Z",
    });
    expect(session).not.toHaveProperty("accessToken");
    expect(JSON.stringify(session)).not.toContain("private-access-token");

    await client.rest.request("todos?select=*", {
      headers: { authorization: "Bearer attacker-controlled" },
    });
    await client.storage.request(
      `object/${runtimeConfig.storageBucket}/person/file.txt`,
      { method: "POST", body: "contents" },
    );

    expect(runtimeRequests).toHaveLength(2);
    for (const request of runtimeRequests) {
      const headers = new Headers(request.init?.headers);
      expect(headers.get("apikey")).toBe("anon-project-key");
      expect(headers.get("authorization")).toBe(
        "Bearer private-access-token",
      );
      expect(request.init?.credentials).toBe("same-origin");
    }
  });

  it("returns null from a successful public signed-out session envelope", async () => {
    const fetchMock = vi.fn(async (source: URL | RequestInfo) => {
      const url = String(source);
      if (url.endsWith("/_opencloud/session/v2")) {
        return Response.json({ session: null });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const client = createOpenCloudClient({
      baseUrl: origin,
      fetch: fetchMock,
      WebSocket: fakeWebSocket(),
      automaticSessionRefresh: false,
    });

    await expect(client.session()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${origin}/_opencloud/session/v2`,
    );
  });

  it("refreshes through the broker before using an expired cache entry", async () => {
    let now = initialNow;
    let sessionRequests = 0;
    const runtimeAuthorizations: string[] = [];
    const fetchMock = vi.fn(
      async (source: URL | RequestInfo, init?: RequestInit) => {
        const url = String(source);
        if (url.endsWith("/_opencloud/config")) {
          return Response.json(runtimeConfig);
        }
        if (url.endsWith("/_opencloud/session/v2")) {
          sessionRequests += 1;
          return Response.json({
            session: wireSession(
              `access-token-${sessionRequests}`,
              sessionRequests === 1
                ? "2026-01-01T00:00:10.000Z"
                : "2026-01-01T00:30:00.000Z",
            ),
          });
        }
        runtimeAuthorizations.push(
          new Headers(init?.headers).get("authorization") ?? "",
        );
        return new Response(null, { status: 204 });
      },
    ) as unknown as typeof fetch;
    const client = createOpenCloudClient({
      baseUrl: origin,
      fetch: fetchMock,
      WebSocket: fakeWebSocket(),
      automaticSessionRefresh: false,
      now: () => now,
    });

    await client.session();
    now += 11_000;
    await client.rest.request("todos");

    expect(sessionRequests).toBe(2);
    expect(runtimeAuthorizations).toEqual(["Bearer access-token-2"]);
  });

  it("uses anonymous identity for public functions and user identity for JWT functions", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchMock = vi.fn(
      async (source: URL | RequestInfo, init?: RequestInit) => {
        const url = String(source);
        if (url.endsWith("/_opencloud/config")) {
          return Response.json(runtimeConfig);
        }
        if (url.endsWith("/_opencloud/session/v2")) {
          return Response.json({
            session: wireSession("signed-in-user-token"),
          });
        }
        calls.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ ok: true });
      },
    ) as unknown as typeof fetch;
    const client = createOpenCloudClient({
      baseUrl: origin,
      fetch: fetchMock,
      WebSocket: fakeWebSocket(),
      automaticSessionRefresh: false,
      now: () => initialNow,
    });

    await client.functions.invokePublic("status-probe", { method: "POST" });
    await client.functions.invoke("private-probe", { method: "POST" });

    expect(calls).toEqual([
      {
        url: `${origin}/functions/v1/status-probe`,
        authorization: "Bearer anon-project-key",
      },
      {
        url: `${origin}/functions/v1/private-probe`,
        authorization: "Bearer signed-in-user-token",
      },
    ]);
  });

  it("reads the host-bound aggregate telemetry summary without runtime credentials", async () => {
    const fetchMock = vi.fn(
      async (source: URL | RequestInfo, init?: RequestInit) => {
        expect(String(source)).toBe(
          `${origin}/_opencloud/telemetry/summary`,
        );
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return Response.json({
          appId: runtimeConfig.appId,
          asOf: "2026-01-01T00:00:00.000Z",
          usage: null,
          activity: {
            window: {
              from: "2025-12-31T00:00:00.000Z",
              to: "2026-01-01T00:00:00.000Z",
              seconds: 86400,
            },
            telemetry: {
              status: "available",
              latestIngestedAt: "2025-12-31T23:59:59.000Z",
              ingestionLagSeconds: 0.2,
              sampledEntries: 12,
              truncated: false,
            },
            surfaces: Object.fromEntries(
              [
                "page",
                "rest",
                "storage",
                "realtime",
                "function",
                "cron",
              ].map((surface) => [
                surface,
                {
                  lastActivityAt: null,
                  requests24h: 0,
                  errors24h: 0,
                  lastStatus: null,
                },
              ]),
            ),
          },
        });
      },
    ) as unknown as typeof fetch;
    const client = createOpenCloudClient({
      baseUrl: origin,
      fetch: fetchMock,
      WebSocket: fakeWebSocket(),
      automaticSessionRefresh: false,
    });

    await expect(client.telemetry.summary()).resolves.toMatchObject({
      appId: runtimeConfig.appId,
      activity: {
        telemetry: {
          status: "available",
          sampledEntries: 12,
        },
        surfaces: {
          rest: {
            requests24h: 0,
            errors24h: 0,
          },
        },
      },
    });
  });

  it("emits declared counters and gauges through the same-origin telemetry endpoint", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(
      async (source: URL | RequestInfo, init?: RequestInit) => {
        requests.push({ url: String(source), init });
        return Response.json({
          accepted: 1,
          duplicates: 0,
          recordedAt: "2026-01-01T00:00:00.000Z",
        });
      },
    ) as unknown as typeof fetch;
    const client = createOpenCloudClient({
      baseUrl: origin,
      fetch: fetchMock,
      WebSocket: fakeWebSocket(),
      automaticSessionRefresh: false,
    });

    await client.telemetry.increment("tasks_created", 1, {
      dimensions: { assignee_type: "child" },
      idempotencyKey: "task-created:123",
    });
    await client.telemetry.gauge("overdue_tasks", 7);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(
      `${origin}/_opencloud/telemetry/metrics`,
    );
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.credentials).toBe("same-origin");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      measurements: [
        {
          name: "tasks_created",
          value: 1,
          dimensions: { assignee_type: "child" },
          idempotencyKey: "task-created:123",
        },
      ],
    });
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      measurements: [
        {
          name: "overdue_tasks",
          value: 7,
          dimensions: {},
        },
      ],
    });
  });

  it("joins, broadcasts, and reconnects private app-prefixed channels with a fresh session", async () => {
    FakeWebSocket.instances = [];
    let sessionRequests = 0;
    const fetchMock = vi.fn(async (source: URL | RequestInfo) => {
      const url = String(source);
      if (url.endsWith("/_opencloud/config")) {
        return Response.json(runtimeConfig);
      }
      if (url.endsWith("/_opencloud/session/v2")) {
        sessionRequests += 1;
        return Response.json({
          session: wireSession(`socket-token-${sessionRequests}`),
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const client = createOpenCloudClient({
      baseUrl: origin,
      fetch: fetchMock,
      WebSocket: fakeWebSocket(),
      automaticSessionRefresh: false,
      now: () => initialNow,
    });
    const channel = client.realtime.channel("updates", {
      reconnect: { initialDelayMs: 10, maxDelayMs: 10 },
    });

    await channel.connect();
    await channel.broadcast("changed", { id: 1 });
    const first = FakeWebSocket.instances[0]!;
    expect(first.url).toContain(
      "wss://tasks.opencloud.ai/realtime/v1/websocket?",
    );
    expect(first.sent[0]).toMatchObject({
      topic: `realtime:app:${runtimeConfig.appId}:updates`,
      event: "phx_join",
      payload: { access_token: "socket-token-1" },
    });
    expect(first.sent[1]).toMatchObject({
      event: "broadcast",
      payload: { event: "changed", payload: { id: 1 } },
    });

    first.close();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    await vi.waitFor(() =>
      expect(FakeWebSocket.instances[1]?.sent[0]).toMatchObject({
        event: "phx_join",
        payload: { access_token: "socket-token-2" },
      }),
    );
    expect(channel.state).toBe("joined");
    channel.close();
  });
});
