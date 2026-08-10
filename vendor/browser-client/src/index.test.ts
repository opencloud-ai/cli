import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sdk from "./index.js";
import {
  OPEN_CLOUD_SDK_VERSION,
  OpenCloudError,
  isOpenCloudError,
  opencloud,
  type OpenCloudTelemetrySurface,
} from "./index.js";

const origin = "https://tasks.opencloud.test";
const appId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const fileId = "33333333-3333-4333-8333-333333333333";

const runtimeConfig = {
  appId,
  deploymentVersion: "release-7",
  visibility: "private",
  environment: "production",
  sdk: {
    package: "@opencloud/js",
    version: "1.0.0",
    module: "/_opencloud/sdk.js",
    types: "/_opencloud/sdk.d.ts",
    docs: "https://docs.opencloud.ai/sdk/javascript/",
  },
  capabilities: {
    auth: true,
    data: true,
    files: true,
    functions: true,
    realtime: true,
    telemetry: true,
  },
  files: { access: "user", maxUploadBytes: 10_000 },
  functions: [
    { name: "private-probe", access: "user" },
    { name: "public-probe", access: "public" },
    { name: "stream-probe", access: "user" },
    { name: "cron-probe", access: "system" },
  ],
};

function wireSession(token = "private-access-token") {
  return {
    appId,
    userId,
    profile: {
      email: "person@example.test",
      displayName: "Test Person",
      avatarUrl: null,
    },
    accessToken: token,
    accessTokenExpiresAt: "2099-01-01T00:31:00.000Z",
    refreshAfter: "2099-01-01T00:30:00.000Z",
    sessionExpiresAt: "2099-01-31T00:00:00.000Z",
  };
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, init);
}

function requestUrl(source: URL | RequestInfo): URL {
  return new URL(String(source));
}

function installFetch(
  handler: (url: URL, init: RequestInit) => Promise<Response> | Response,
) {
  const mock = vi.fn((source: URL | RequestInfo, init: RequestInit = {}) =>
    handler(requestUrl(source), init),
  ) as unknown as typeof fetch;
  vi.stubGlobal("fetch", mock);
  return mock;
}

function standardFetch(
  handler?: (url: URL, init: RequestInit) => Promise<Response> | Response | undefined,
) {
  return installFetch(async (url, init) => {
    if (url.pathname === "/_opencloud/config") return json(runtimeConfig);
    if (url.pathname === "/_opencloud/session") {
      return json({ session: wireSession() });
    }
    const result = await handler?.(url, init);
    if (result) return result;
    throw new Error(`Unexpected request ${init.method ?? "GET"} ${url}`);
  });
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

  broadcast(event: string, payload: unknown): void {
    this.emit("message", {
      data: JSON.stringify({
        event: "broadcast",
        payload: { event, payload },
      }),
    });
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

beforeEach(() => {
  opencloud.dispose();
  vi.stubGlobal("location", { origin });
  FakeWebSocket.instances = [];
});

afterEach(() => {
  opencloud.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("@opencloud/js v1", () => {
  it("exports one stable singleton contract without legacy factories or raw namespaces", () => {
    expect(OPEN_CLOUD_SDK_VERSION).toBe("1.0.0");
    expect("OPEN_CLOUD_JS_VERSION" in sdk).toBe(false);
    expect(opencloud).toMatchObject({
      app: { info: expect.any(Function) },
      auth: {
        currentUser: expect.any(Function),
        requireUser: expect.any(Function),
        signInUrl: expect.any(Function),
      },
      data: { table: expect.any(Function) },
      files: {
        upload: expect.any(Function),
        download: expect.any(Function),
        save: expect.any(Function),
        replace: expect.any(Function),
        remove: expect.any(Function),
        attach: expect.any(Function),
      },
      functions: {
        call: expect.any(Function),
        stream: expect.any(Function),
      },
      realtime: {
        subscribe: expect.any(Function),
        publish: expect.any(Function),
      },
      telemetry: {
        summary: expect.any(Function),
        increment: expect.any(Function),
        gauge: expect.any(Function),
      },
    });
    expect("createOpenCloudClient" in sdk).toBe(false);
    expect("OpenCloudBrowserClient" in sdk).toBe(false);
    expect(opencloud).not.toHaveProperty("rest");
    expect(opencloud).not.toHaveProperty("storage");
    expect(opencloud).not.toHaveProperty("config");
    expect(opencloud).not.toHaveProperty("session");
  });

  it("creates a safe same-origin sign-in URL that returns to the current page", () => {
    vi.stubGlobal("location", {
      origin,
      pathname: "/cases/claim-7",
      search: "?tab=files",
      hash: "#latest",
    });

    const target = new URL(opencloud.auth.signInUrl());

    expect(target.origin).toBe(origin);
    expect(target.pathname).toBe("/_opencloud/sign-in");
    expect(target.searchParams.get("return_to")).toBe(
      "/cases/claim-7?tab=files#latest",
    );
  });

  it("loads app info and current user without exposing token or requiring WebSocket", async () => {
    standardFetch();
    vi.stubGlobal("WebSocket", undefined);

    await expect(opencloud.app.info()).resolves.toEqual({
      id: appId,
      version: "release-7",
      environment: "production",
      visibility: "private",
      capabilities: runtimeConfig.capabilities,
    });
    const user = await opencloud.auth.requireUser();
    expect(user).toEqual({
      id: userId,
      email: "person@example.test",
      displayName: "Test Person",
      avatarUrl: null,
    });
    expect(JSON.stringify(user)).not.toContain("private-access-token");
  });

  it("rejects non-v1 runtime config shapes instead of interpreting compatibility aliases", async () => {
    const incompatibleConfigs = [
      { ...runtimeConfig, sdk: undefined, javascriptSdk: runtimeConfig.sdk },
      { ...runtimeConfig, environment: "prod" },
      { ...runtimeConfig, supabaseUrl: origin },
      { ...runtimeConfig, publicKey: "browser-key" },
      { ...runtimeConfig, supabaseAnonKey: "browser-key" },
      { ...runtimeConfig, functionsBasePath: "/custom/functions" },
      { ...runtimeConfig, storageAuthorization: "owner-prefix" },
      { ...runtimeConfig, storage: { authorization: "owner-prefix" } },
      {
        ...runtimeConfig,
        capabilities: { ...runtimeConfig.capabilities, database: true },
      },
      {
        ...runtimeConfig,
        functions: [{ name: "public-probe", verifyJwt: false }],
      },
    ];

    for (const config of incompatibleConfigs) {
      opencloud.dispose();
      installFetch((url) => {
        if (url.pathname === "/_opencloud/config") return json(config);
        throw new Error(`Unexpected request ${url}`);
      });
      await expect(opencloud.app.info()).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
        surface: "app",
      });
    }
  });

  it("returns null for a signed-out visitor and throws a typed auth error when required", async () => {
    installFetch((url) => {
      if (url.pathname === "/_opencloud/config") return json(runtimeConfig);
      if (url.pathname === "/_opencloud/session") return json({ session: null });
      throw new Error(`Unexpected request ${url}`);
    });

    await expect(opencloud.auth.currentUser()).resolves.toBeNull();
    await expect(opencloud.auth.requireUser()).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      surface: "auth",
      status: 401,
    });
  });

  it("builds safe data reads and owns auth, projection, filters, ordering and pagination", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    standardFetch((url, init) => {
      calls.push({ url, init });
      return json([{ id: "task-1", title: "Ship", done: false }]);
    });

    const rows = await opencloud.data.table("tasks").list({
      select: ["id", "title", "done"],
      where: { done: false, status: "open" },
      orderBy: { column: "created_at", direction: "desc" },
      limit: 25,
      offset: 5,
    });

    expect(rows).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/rest/v1/tasks");
    expect(calls[0]?.url.searchParams.get("select")).toBe("id,title,done");
    expect(calls[0]?.url.searchParams.get("done")).toBe("eq.false");
    expect(calls[0]?.url.searchParams.get("status")).toBe("eq.open");
    expect(calls[0]?.url.searchParams.get("order")).toBe("created_at.desc");
    expect(calls[0]?.url.searchParams.get("limit")).toBe("25");
    expect(calls[0]?.url.searchParams.get("offset")).toBe("5");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer private-access-token",
    );
    expect(new Headers(calls[0]?.init.headers).has("apikey")).toBe(false);
  });

  it("creates, updates and deletes rows with JSON handling and narrow id filters", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    standardFetch((url, init) => {
      calls.push({ url, init });
      if (init.method === "POST") return json([{ id: "task-1", title: "Ship" }], { status: 201 });
      if (init.method === "PATCH") return json([{ id: "task-1", done: true }]);
      if (init.method === "DELETE") return json([{ id: "task-1" }]);
      return undefined;
    });
    const tasks = opencloud.data.table<{ id: string; title?: string; done?: boolean }>("tasks");

    await expect(tasks.create({ title: "Ship" })).resolves.toMatchObject({ id: "task-1" });
    await expect(tasks.updateById("task-1", { done: true })).resolves.toMatchObject({ done: true });
    await expect(tasks.deleteById("task-1")).resolves.toBe(true);

    expect(calls.map((call) => call.init.method)).toEqual(["POST", "PATCH", "DELETE"]);
    expect(calls[1]?.url.searchParams.get("id")).toBe("eq.task-1");
    expect(calls[2]?.url.searchParams.get("id")).toBe("eq.task-1");
    for (const call of calls) {
      expect(new Headers(call.init.headers).get("authorization")).toBe(
        "Bearer private-access-token",
      );
      expect(new Headers(call.init.headers).get("prefer")).toBe("return=representation");
    }
  });

  it("rejects malformed identifiers and broad mutations before a runtime request", async () => {
    const fetchMock = standardFetch();
    expect(() => opencloud.data.table("tasks?delete=all")).toThrow(/identifier/);
    await expect(opencloud.data.table("tasks").updateById("", { title: "x" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(opencloud.data.table("tasks").updateById("task-1", {})).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the managed opaque file gateway without buckets, object paths or bearer headers", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    standardFetch((url, init) => {
      calls.push({ url, init });
      if (url.pathname === "/_opencloud/files" && init.method === "POST") {
        return json({
          id: fileId,
          name: "résumé.pdf",
          contentType: "application/pdf",
          size: 7,
        }, { status: 201 });
      }
      if (url.pathname === `/_opencloud/files/${fileId}` && !init.method) {
        return new Response("content", {
          headers: {
            "content-type": "application/pdf",
            "x-opencloud-file-name": encodeURIComponent("résumé.pdf"),
          },
        });
      }
      if (url.pathname === `/_opencloud/files/${fileId}` && init.method === "PUT") {
        return json({
          id: fileId,
          name: "new.pdf",
          contentType: "application/pdf",
          size: 3,
        });
      }
      if (url.pathname === `/_opencloud/files/${fileId}` && init.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return undefined;
    });

    const file = await opencloud.files.upload(
      new Blob(["content"], { type: "application/pdf" }),
      { name: "résumé.pdf" },
    );
    const downloaded = await opencloud.files.download(file.id);
    const replaced = await opencloud.files.replace(
      file,
      new Blob(["new"], { type: "application/pdf" }),
      { name: "new.pdf" },
    );
    await opencloud.files.remove(file.id);

    expect(file.id).toBe(fileId);
    expect(await downloaded.blob.text()).toBe("content");
    expect(downloaded.name).toBe("résumé.pdf");
    expect(replaced).toMatchObject({ id: fileId, name: "new.pdf", size: 3 });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/_opencloud/files",
      `/_opencloud/files/${fileId}`,
      `/_opencloud/files/${fileId}`,
      `/_opencloud/files/${fileId}`,
    ]);
    expect(new Headers(calls[0]?.init.headers).get("x-opencloud-file-name")).toBe(
      encodeURIComponent("résumé.pdf"),
    );
    expect(new Headers(calls[0]?.init.headers).get("idempotency-key")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(new Headers(calls[2]?.init.headers).get("idempotency-key")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    for (const call of calls) {
      expect(call.url.pathname).not.toContain("storage");
      expect(new Headers(call.init.headers).has("authorization")).toBe(false);
      expect(new Headers(call.init.headers).has("apikey")).toBe(false);
      expect(call.init.credentials).toBe("same-origin");
    }
  });

  it("reports upload progress and safely retries once with the same private idempotency key", async () => {
    const progress: number[] = [];
    const idempotencyKeys: string[] = [];
    let attempts = 0;
    standardFetch((url, init) => {
      if (url.pathname !== "/_opencloud/files") return undefined;
      attempts += 1;
      idempotencyKeys.push(
        new Headers(init.headers).get("idempotency-key") ?? "",
      );
      if (attempts === 1) throw new TypeError("connection reset after commit");
      return json({
        id: fileId,
        name: "proof.txt",
        contentType: "text/plain",
        size: 5,
      });
    });

    await expect(
      opencloud.files.upload(new Blob(["proof"], { type: "text/plain" }), {
        name: "proof.txt",
        onProgress: ({ percent }) => progress.push(percent),
      }),
    ).resolves.toMatchObject({ id: fileId, name: "proof.txt" });

    expect(attempts).toBe(2);
    expect(idempotencyKeys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
    expect(progress.at(0)).toBe(0);
    expect(progress.at(-1)).toBe(100);
  });

  it("rejects oversized files before contacting the managed gateway", async () => {
    const fetchMock = standardFetch();
    await expect(
      opencloud.files.upload(new Blob(["123456"]), { maxBytes: 5 }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE", surface: "files" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invented file option fields instead of silently ignoring them", async () => {
    const fetchMock = standardFetch();

    await expect(
      opencloud.files.upload(new Blob(["proof"]), {
        clientKey: "guessed-retry-key",
      } as never),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      surface: "files",
    });
    await expect(
      opencloud.files.attach(new Blob(["proof"]), {
        table: "evidence",
        row: { case_id: "claim-1" },
      } as never),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      surface: "files",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("attaches a file and writes conventional metadata", async () => {
    const writes: Record<string, unknown>[] = [];
    standardFetch((url, init) => {
      if (url.pathname === "/_opencloud/files") {
        return json({ id: fileId, name: "proof.txt", contentType: "text/plain", size: 5 });
      }
      if (url.pathname === "/rest/v1/evidence" && init.method === "POST") {
        const value = JSON.parse(String(init.body)) as Record<string, unknown>;
        writes.push(value);
        return json([{ id: "evidence-1", ...value }], { status: 201 });
      }
      return undefined;
    });

    const result = await opencloud.files.attach<{ id: string }>(
      new Blob(["proof"], { type: "text/plain" }),
      {
        table: "evidence",
        values: { claim_id: "claim-1" },
        upload: { name: "proof.txt" },
      },
    );

    expect(result.record.id).toBe("evidence-1");
    expect(writes).toEqual([{
      claim_id: "claim-1",
      file_id: fileId,
      file_name: "proof.txt",
      file_type: "text/plain",
      file_size: 5,
    }]);
  });

  it("reconciles an ambiguous metadata write by stable file id", async () => {
    let metadataWrites = 0;
    let deletes = 0;
    standardFetch((url, init) => {
      if (url.pathname === "/_opencloud/files") {
        return json({ id: fileId, name: "proof.txt", contentType: "text/plain", size: 5 });
      }
      if (url.pathname === "/rest/v1/evidence" && init.method === "POST") {
        metadataWrites += 1;
        throw new TypeError("connection reset after commit");
      }
      if (url.pathname === "/rest/v1/evidence" && !init.method) {
        expect(url.searchParams.get("file_id")).toBe(`eq.${fileId}`);
        return json([{ id: "evidence-1", file_id: fileId }]);
      }
      if (url.pathname === `/_opencloud/files/${fileId}` && init.method === "DELETE") {
        deletes += 1;
        return new Response(null, { status: 204 });
      }
      return undefined;
    });

    await expect(opencloud.files.attach(
      new Blob(["proof"], { type: "text/plain" }),
      { table: "evidence", upload: { name: "proof.txt" } },
    )).resolves.toMatchObject({ record: { id: "evidence-1" } });
    expect(metadataWrites).toBe(1);
    expect(deletes).toBe(0);
  });

  it("cleans up a definite attachment failure and reports unconfirmed cleanup", async () => {
    standardFetch((url, init) => {
      if (url.pathname === "/_opencloud/files") {
        return json({ id: fileId, name: "proof.txt", contentType: "text/plain", size: 5 });
      }
      if (url.pathname === "/rest/v1/evidence") {
        return json({ message: "claim does not exist" }, { status: 400 });
      }
      if (url.pathname === `/_opencloud/files/${fileId}` && init.method === "DELETE") {
        return json({ message: "storage unavailable" }, { status: 503 });
      }
      return undefined;
    });

    const promise = opencloud.files.attach(
      new Blob(["proof"], { type: "text/plain" }),
      { table: "evidence", upload: { name: "proof.txt" } },
    );
    await expect(promise).rejects.toMatchObject({
      code: "FILE_ATTACHMENT_INCOMPLETE",
      surface: "files",
      retryable: true,
      details: { file: { id: fileId }, cleanupRequired: true },
    });
  });

  it("selects declared Function access and parses JSON, empty and streaming responses", async () => {
    const calls: Array<{
      path: string;
      authorization: string | null;
      apiKey: string | null;
      body: unknown;
    }> = [];
    const fetchMock = standardFetch((url, init) => {
      if (!url.pathname.includes("probe")) return undefined;
      calls.push({
        path: url.pathname,
        authorization: new Headers(init.headers).get("authorization"),
        apiKey: new Headers(init.headers).get("apikey"),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.pathname.endsWith("stream-probe")) return new Response("streamed");
      if (url.pathname.endsWith("public-probe")) return new Response(null, { status: 204 });
      return json({ ok: true });
    });

    await expect(opencloud.functions.call("cron-probe")).rejects.toMatchObject({
      code: "FUNCTION_SYSTEM_ONLY",
      surface: "functions",
      details: { name: "cron-probe" },
    });
    await expect(opencloud.functions.stream("cron-probe")).rejects.toMatchObject({
      code: "FUNCTION_SYSTEM_ONLY",
      surface: "functions",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(opencloud.functions.call("private-probe", { id: 1 })).resolves.toEqual({ ok: true });
    await expect(opencloud.functions.call("public-probe")).resolves.toBeUndefined();
    const stream = await opencloud.functions.stream("stream-probe", { id: 2 });
    expect(await new Response(stream).text()).toBe("streamed");

    expect(calls).toEqual([
      {
        path: "/functions/v1/private-probe",
        authorization: "Bearer private-access-token",
        apiKey: null,
        body: { id: 1 },
      },
      {
        path: "/functions/v1/public-probe",
        authorization: null,
        apiKey: null,
        body: undefined,
      },
      {
        path: "/functions/v1/stream-probe",
        authorization: "Bearer private-access-token",
        apiKey: null,
        body: { id: 2 },
      },
    ]);
    await expect(opencloud.functions.call("invented-method")).rejects.toMatchObject({
      code: "FUNCTION_NOT_DECLARED",
    });
    expect(calls).toHaveLength(3);
  });

  it("normalizes backend and network errors into bounded typed failures", async () => {
    installFetch((url) => {
      if (url.pathname === "/_opencloud/config") return json(runtimeConfig);
      if (url.pathname === "/_opencloud/session") return json({ session: wireSession() });
      return json(
        { code: "23505", message: "duplicate task", details: "private database detail" },
        { status: 409, headers: { "x-request-id": "request-7" } },
      );
    });
    const conflict = opencloud.data.table("tasks").create({ title: "Duplicate" });
    await expect(conflict).rejects.toMatchObject({
      code: "CONFLICT",
      surface: "data",
      status: 409,
      requestId: "request-7",
      retryable: false,
      message: "duplicate task",
    });
    await conflict.catch((error: unknown) => {
      expect(isOpenCloudError(error)).toBe(true);
      expect(error).toBeInstanceOf(OpenCloudError);
    });

    opencloud.dispose();
    installFetch(() => {
      throw new TypeError("offline");
    });
    await expect(opencloud.app.info()).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      surface: "app",
      retryable: true,
    });
  });

  it("subscribes and publishes on one managed private channel, then closes on unsubscribe", async () => {
    standardFetch();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const messages: unknown[] = [];

    const unsubscribe = await opencloud.realtime.subscribe("tasks", (message) => {
      messages.push(message);
    });
    await opencloud.realtime.publish("tasks", "changed", { id: "task-1" });
    const socket = FakeWebSocket.instances[0]!;
    socket.broadcast("changed", { id: "task-2" });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.url).toContain("wss://tasks.opencloud.test/realtime/v1/websocket");
    expect(new URL(socket.url).searchParams.has("apikey")).toBe(false);
    expect(socket.sent[0]).toMatchObject({
      topic: `realtime:app:${appId}:tasks`,
      event: "phx_join",
      payload: { access_token: "private-access-token" },
    });
    expect(socket.sent[1]).toMatchObject({
      event: "broadcast",
      payload: { event: "changed", payload: { id: "task-1" } },
    });
    expect(messages).toEqual([{ event: "changed", payload: { id: "task-2" } }]);
    unsubscribe();
    expect(socket.readyState).toBe(3);
  });

  it("fails locally when a declared capability is unavailable", async () => {
    const fetchMock = installFetch((url) => {
      if (url.pathname === "/_opencloud/config") {
        return json({
          ...runtimeConfig,
          environment: "dev",
          capabilities: { ...runtimeConfig.capabilities, files: false },
          files: undefined,
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    await expect(opencloud.files.upload(new Blob(["x"]))).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      surface: "files",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reads telemetry and writes declared metrics through cookie-bound host endpoints", async () => {
    const surfaces = Object.fromEntries(
      (["page", "rest", "storage", "realtime", "function", "cron"] as OpenCloudTelemetrySurface[])
        .map((surface) => [surface, {
          lastActivityAt: null,
          requests24h: 0,
          errors24h: 0,
          lastStatus: null,
        }]),
    );
    const calls: Array<{ path: string; init: RequestInit }> = [];
    standardFetch((url, init) => {
      calls.push({ path: url.pathname, init });
      if (url.pathname.endsWith("summary")) {
        return json({
          appId,
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
              ingestionLagSeconds: 1,
              sampledEntries: 2,
              truncated: false,
            },
            surfaces,
          },
        });
      }
      return json({ accepted: 1, duplicates: 0, recordedAt: "2026-01-01T00:00:00.000Z" }, { status: 202 });
    });

    await expect(opencloud.telemetry.summary()).resolves.toMatchObject({ appId });
    await opencloud.telemetry.increment("tasks_created", 1, {
      dimensions: { actor: "member" },
      idempotencyKey: "task:1",
    });
    await opencloud.telemetry.gauge("tasks_open", 7);
    expect(calls.map((call) => call.path)).toEqual([
      "/_opencloud/telemetry/summary",
      "/_opencloud/telemetry/metrics",
      "/_opencloud/telemetry/metrics",
    ]);
    expect(calls.every((call) => call.init.credentials === "same-origin")).toBe(true);
  });
});
