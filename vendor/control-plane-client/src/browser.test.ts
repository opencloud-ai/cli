import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  OpenCloudClient,
  type BrowserClientOptions,
} from "./browser.js";

function browser(fetcher: typeof fetch): OpenCloudClient {
  vi.stubGlobal("location", { origin: "https://dashboard.opencloud.test" });
  return new OpenCloudClient({ fetch: fetcher });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("browser OpenCloudClient", () => {
  it("binds the native fetch default to the browser global", async () => {
    vi.stubGlobal("location", { origin: "https://dashboard.opencloud.test" });
    let receiver: unknown;
    const receiverSensitiveFetch = function (
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      receiver = this;
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json([]));
    };
    vi.stubGlobal("fetch", receiverSensitiveFetch as typeof fetch);
    const client = new OpenCloudClient();

    await expect(client.call("listApps", {})).resolves.toEqual([]);
    expect(receiver).toBe(globalThis);
  });

  it("uses same-origin cookies and validates successful payloads", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ signedIn: true, ignored: "removed" }),
    );
    const client = browser(fetcher as typeof fetch);

    await expect(
      client.get("/v1/browser-session", {
        schema: z.object({ signedIn: z.boolean() }),
      }),
    ).resolves.toEqual({ signedIn: true });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://dashboard.opencloud.test/v1/browser-session");
    expect(init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-opencloud-mcp-internal")).toBe(false);
  });

  it("ignores undeclared runtime transport overrides", async () => {
    vi.stubGlobal("location", { origin: "https://dashboard.opencloud.test" });
    vi.stubGlobal("crypto", {
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
    });
    const fetcher = vi.fn(async () => Response.json({ accepted: true }));
    const runtimeOptions: Record<string, unknown> = {
      fetch: fetcher,
      apiUrl: "https://attacker.invalid",
      credentials: "omit",
      token: "attacker-token",
      internalMcpSecret: "attacker-secret",
      createIdempotencyKey: () => "attacker-key",
    };
    const client = new OpenCloudClient(
      runtimeOptions as unknown as BrowserClientOptions,
    );

    await client.post("/v1/apps", { name: "Example" });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://dashboard.opencloud.test/v1/apps");
    expect(init?.credentials).toBe("same-origin");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-opencloud-mcp-internal")).toBeNull();
    expect(headers.get("idempotency-key")).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it("validates registered operation output with the shared contracts", async () => {
    const client = browser(
      vi.fn(async () => Response.json({ invalid: true })) as typeof fetch,
    );

    await expect(client.call("listApps", {})).rejects.toMatchObject({
      name: "ZodError",
    });
  });

  it("retains typed request and operation evidence from JSON errors", async () => {
    const body = {
      statusCode: 409,
      code: "deployment_conflict",
      message: "A deployment is already active",
      requestId: "request-body",
      retryable: false,
      details: {
        operation: { id: "operation-123", state: "running" },
      },
    };
    const client = browser(
      vi.fn(async () =>
        Response.json(body, {
          status: 409,
          headers: { "x-request-id": "request-header" },
        }),
      ) as typeof fetch,
    );

    const request = client.get("/v1/conflict");
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      status: 409,
      body,
      code: "deployment_conflict",
      requestId: "request-body",
      retryable: false,
      details: body.details,
      operation: body.details.operation,
    });
  });

  it("uses header evidence and status retryability for non-JSON errors", async () => {
    const client = browser(
      vi.fn(
        async () =>
          new Response("Temporarily unavailable", {
            status: 503,
            headers: { "x-request-id": "request-header" },
          }),
      ) as typeof fetch,
    );

    await expect(client.get("/v1/unavailable")).rejects.toMatchObject({
      status: 503,
      body: "Temporarily unavailable",
      code: null,
      requestId: "request-header",
      retryable: true,
      details: null,
      operation: null,
    });
  });

  it("propagates caller cancellation through the fetch signal", async () => {
    const reason = new DOMException("Route changed", "AbortError");
    const fetcher = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("Expected a request signal");
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const client = browser(fetcher as typeof fetch);
    const controller = new AbortController();

    const request = client.get("/v1/slow", { signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("aborts at the per-request timeout with a TimeoutError", async () => {
    vi.useFakeTimers();
    const client = browser(
      vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error("Expected a request signal");
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      ) as typeof fetch,
    );

    const assertion = expect(
      client.get("/v1/slow", { timeoutMs: 25 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });

  it("creates idempotency keys without Node crypto", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
    });
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    const client = browser(fetcher as typeof fetch);

    await client.post("/v1/apps", { name: "Example" });

    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("idempotency-key"),
    ).toBe("00000000-0000-4000-8000-000000000001");
  });
});
