import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPEN_CLOUD_SDK_VERSION,
  OpenCloudError,
  defineFunction,
  errors,
  schema,
} from "./index.js";

const originalDeno = (globalThis as { Deno?: unknown }).Deno;
const appId = "00000000-0000-4000-8000-000000000001";
const devSessionId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const fileId = "00000000-0000-4000-8000-000000000004";
const idempotencyKey = "00000000-0000-4000-8000-000000000005";

describe("container types", () => {
  it("name every container error code and wait reason the platform answers with", async () => {
    const { computeErrorCatalog, computeExecutionWaitReasonSchema } = await import("@opencloud/contracts");
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    const union = (name: string) =>
      [...(source.match(new RegExp(`export type ${name} =([^;]+);`))?.[1] ?? "").matchAll(/"([A-Za-z_]+)"/g)]
        .map((match) => match[1])
        .sort();
    expect(union("OpenCloudContainerErrorCode")).toEqual(Object.keys(computeErrorCatalog).sort());
    expect(union("OpenCloudContainerWaitReason")).toEqual([...computeExecutionWaitReasonSchema.options].sort());
    expect(source).toContain("waitReason: OpenCloudContainerWaitReason | null;");
  });
});

describe("container Function client", () => {
  const scoped = () => installRuntime("production", {
    OPENCLOUD_CONTAINERS_URL: "http://control-plane.test",
    OPENCLOUD_CONTAINERS_TOKEN: "signed-compute-runtime-purpose-token",
  });
  it("uses runtime purpose authority and the Files grant for a declared job submission", async () => {
    const runtime = scoped();
    const fetch = vi.fn(async () => Response.json({ executionId: fileId, state: "queued", outputFileIds: [] }));
    vi.stubGlobal("fetch", fetch);
    defineFunction({ input: schema.object({}), handler: ({ containers }) => containers.run("transcode", { format: "mp4" }, {
      idempotencyKey: "transcode:source-1", inputFileIds: [fileId],
    }) });
    const response = await runtime.invoke();
    expect(response.status).toBe(200);
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/_opencloud/containers/run");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer signed-compute-runtime-purpose-token");
    expect(new Headers(init.headers).get("x-opencloud-function-grant")).toBeTruthy();
    expect(new Headers(init.headers).has("x-opencloud-user-id")).toBe(false);
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toEqual({ name: "transcode", input: { format: "mp4" }, inputFileIds: [fileId], idempotencyKey: "transcode:source-1" });
  });

  it("round-trips binary service bodies and explicit cancellation keys", async () => {
    const runtime = scoped();
    const fetch = vi.fn(async (url: URL) => url.pathname.endsWith("/request")
      ? Response.json({ status: 201, headers: { "content-type": "application/octet-stream" }, bodyBase64: "AP+A" })
      : Response.json({ executionId: fileId, state: "cancelled" }));
    vi.stubGlobal("fetch", fetch);
    defineFunction({ input: schema.object({}), handler: async ({ containers }) => {
      const result = await containers.request("image-api", { path: "/render?size=small", method: "POST", body: new Uint8Array([0, 255, 128]) });
      await containers.cancel(fileId, { idempotencyKey: "cancel:source-1" });
      return { status: result.status, bytes: [...result.body] };
    } });
    await expect((await runtime.invoke()).json()).resolves.toEqual({ status: 201, bytes: [0, 255, 128] });
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string).bodyBase64).toBe("AP+A");
    expect(JSON.parse((fetch.mock.calls[1] as unknown as [URL, RequestInit])[1].body as string)).toEqual({ executionId: fileId, idempotencyKey: "cancel:source-1" });
  });

  it("rejects invalid submissions before fetching and never automatically retries", async () => {
    const fetch = vi.fn(async () => { throw new Error("lost response"); });
    vi.stubGlobal("fetch", fetch);
    const invalid = scoped();
    defineFunction({ input: schema.object({}), handler: ({ containers }) => containers.run("transcode", {}, { idempotencyKey: "" }) });
    expect((await invalid.invoke()).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    const ambiguous = scoped();
    defineFunction({ input: schema.object({}), handler: ({ containers }) => containers.run("transcode", {}, { idempotencyKey: "transcode:source-1" }) });
    expect((await ambiguous.invoke()).status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds a service request body at 4 MiB before fetching", async () => {
    const fetch = vi.fn(async () => Response.json({ status: 200, headers: {}, bodyBase64: "" }));
    vi.stubGlobal("fetch", fetch);
    const oversized = scoped();
    defineFunction({ input: schema.object({}), handler: async ({ containers }) => {
      await containers.request("image-api", { path: "/render", method: "POST", body: new Uint8Array(4 * 1024 * 1024 + 1) });
      return {};
    } });
    expect((await oversized.invoke()).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    const largest = scoped();
    defineFunction({ input: schema.object({}), handler: async ({ containers }) => {
      const result = await containers.request("image-api", { path: "/render", method: "POST", body: new Uint8Array(4 * 1024 * 1024) });
      return { status: result.status };
    } });
    expect((await largest.invoke()).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("resumable managed File inputs", () => {
  it("uses opaque sessions and bounded chunks while keeping the whole input out of memory", async () => {
    const runtime = installRuntime();
    const session = { uploadSessionId: idempotencyKey, fileId, path: "source.bin", sizeBytes: "1073741824",
      sha256: "a".repeat(64), offsetBytes: "0", chunkBytes: 8 * 1024 ** 2, state: "uploading", expiresAt: "2099-01-01T00:00:00Z" };
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(session));
    vi.stubGlobal("fetch", fetch);
    defineFunction({ input: schema.object({}), handler: async ({ files }) => {
      const created = await files.beginUpload({ workloadName: "transcode", name: "source.bin", contentType: "application/octet-stream",
        sizeBytes: session.sizeBytes, sha256: session.sha256, idempotencyKey });
      await files.uploadChunk(created.uploadSessionId, { data: new Uint8Array([1, 2, 3]), offsetBytes: "0", sha256: "b".repeat(64) });
      await files.uploadStatus(created.uploadSessionId);
      await files.abortUpload(created.uploadSessionId);
      return { fileId: created.fileId };
    } });
    await expect((await runtime.invoke()).json()).resolves.toEqual({ fileId });
    const calls = fetch.mock.calls as unknown as [URL, RequestInit][];
    expect(calls[0]![0].pathname).toBe("/_opencloud/files/uploads");
    expect(calls[1]![0].pathname).toBe(`/_opencloud/files/uploads/${idempotencyKey}/chunks`);
    expect(calls[1]![1].body).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Headers(calls[1]![1].headers).get("content-length")).toBe("3");
    expect(new Headers(calls[1]![1].headers).get("x-opencloud-function-grant")).toBeTruthy();
  });
});

const searchBinding = {
  name: "chunks", rpcName: `oc_search_${"a".repeat(48)}`,
  declaration: { name: "chunks", table: "chunks", select: ["id", "content"], filterColumns: ["document_id"],
    fullText: { column: "search_text", language: "english" },
    vector: { column: "embedding", dimensions: 2, metric: "cosine", model: "model-v1" } },
};
const searchResult = { hits: [{ record: { id: "one", content: "evidence" }, fullTextScore: null,
  fullTextRank: null, vectorDistance: 0.1, vectorSimilarity: 0.9, vectorRank: 1, fusionScore: null }] };

describe("integration provider context", () => {
  const connectionId = "00000000-0000-4000-8000-000000000010";
  const consumerAppId = "00000000-0000-4000-8000-000000000011";
  const scoped = (overrides: Record<string, string | undefined> = {}) =>
    installRuntime("production", {
      OPENCLOUD_INTEGRATION_CONNECTION_ID: connectionId,
      OPENCLOUD_INTEGRATION_TRIGGER: "operation",
      OPENCLOUD_INTEGRATION_OPERATION: "orders.list",
      OPENCLOUD_INTEGRATION_CONSUMER_APP_ID: consumerAppId,
      OPENCLOUD_INTEGRATION_EVENTS_URL: "http://control-plane.test/_opencloud/integrations/events",
      OPENCLOUD_INTEGRATION_EVENTS_GRANT: "events-grant",
      ...overrides,
    });

  it("is null outside an integration invocation", async () => {
    const runtime = installRuntime();
    defineFunction({ input: schema.object({}), handler: ({ integration }) => ({ integration }) });
    await expect((await runtime.invoke()).json()).resolves.toEqual({ integration: null });
  });

  it("names the connection and emits declared events with the runtime grant", async () => {
    const runtime = scoped();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ accepted: true, deliveries: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    defineFunction({
      input: schema.object({}),
      handler: async ({ integration }) => ({
        connectionId: integration?.connectionId,
        trigger: integration?.trigger,
        operation: integration?.operation,
        consumerAppId: integration?.consumerAppId,
        emitted: await integration!.emit({
          type: "orders.created",
          id: "order-42",
          data: { total: 12 },
          occurredAt: new Date("2026-09-30T10:00:00.000Z"),
        }),
      }),
    });
    const response = await runtime.invoke(jsonRequest({}, { "x-request-id": "req-emit" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connectionId,
      trigger: "operation",
      operation: "orders.list",
      consumerAppId,
      emitted: { deliveries: 2 },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://control-plane.test/_opencloud/integrations/events");
    const headers = new Headers(init.headers);
    expect(headers.get("x-opencloud-integration-events-grant")).toBe("events-grant");
    expect(headers.get("x-request-id")).toBe("req-emit");
    expect(JSON.parse(init.body)).toEqual({
      type: "orders.created",
      id: "order-42",
      data: { total: 12 },
      occurredAt: "2026-09-30T10:00:00.000Z",
    });
  });

  it("rejects malformed events and emits unavailable during OAuth exchange", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const invalid = scoped();
    defineFunction({
      input: schema.object({}),
      handler: ({ integration }) => integration!.emit({ type: "Orders Created", id: "x" }),
    });
    const rejected = await invalid.invoke();
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.code).toBe("INVALID_INTEGRATION_EVENT");

    const oauth = scoped({
      OPENCLOUD_INTEGRATION_TRIGGER: "oauth",
      OPENCLOUD_INTEGRATION_OPERATION: undefined,
      OPENCLOUD_INTEGRATION_CONSUMER_APP_ID: undefined,
      OPENCLOUD_INTEGRATION_EVENTS_URL: undefined,
      OPENCLOUD_INTEGRATION_EVENTS_GRANT: undefined,
    });
    defineFunction({
      input: schema.object({}),
      handler: ({ integration }) => integration!.emit({ type: "orders.created", id: "x" }),
    });
    const unavailable = await oauth.invoke();
    expect(unavailable.status).toBe(409);
    expect((await unavailable.json()).error.code).toBe("INTEGRATION_EVENTS_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes the platform's details on integration failures", async () => {
    const connectUrl = "https://opencloud.test/integrations/custom/provider?appId=app&integration=crm";
    const failure = () =>
      Response.json(
        { code: "INTEGRATION_CONNECTION_REQUIRED", message: "Connect Acme CRM to continue", details: { connectUrl } },
        { status: 409 },
      );
    const caught = installRuntime("production");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => failure()));
    defineFunction({
      input: schema.object({}),
      handler: async ({ integrations }) => {
        try {
          await integrations.use("crm").call("profile.whoami", {});
          return { ok: true };
        } catch (error) {
          const known = error as OpenCloudError;
          return { code: known.code, status: known.status, details: known.details };
        }
      },
    });
    await expect((await caught.invoke()).json()).resolves.toEqual({
      code: "INTEGRATION_CONNECTION_REQUIRED",
      status: 409,
      details: { connectUrl },
    });

    // Uncaught, the same details reach the browser in the Function error.
    const uncaught = installRuntime("production");
    defineFunction({
      input: schema.object({}),
      handler: ({ integrations }) => integrations.use("crm").call("profile.whoami", {}),
    });
    const response = await uncaught.invoke();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({
      code: "INTEGRATION_CONNECTION_REQUIRED",
      details: { connectUrl },
    });
  });

  it("fails closed on forged integration bindings", async () => {
    const runtime = scoped({ OPENCLOUD_INTEGRATION_TRIGGER: "admin" });
    defineFunction({ input: schema.object({}), handler: () => ({}) });
    const response = await runtime.invoke();
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("RUNTIME_BINDING_INVALID");
  });
});

describe("declared PostgreSQL search", () => {
  it.each(["fullText", "hybrid"] as const)("normalizes %s options and retains anonymous authority", async mode => {
    const runtime = installRuntime("dev", { OPENCLOUD_DATA_SEARCH: JSON.stringify([searchBinding]) });
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ hits: [] })); vi.stubGlobal("fetch", fetchMock);
    defineFunction({ input: schema.object({}), handler: ({ data }) => data.search("chunks", mode === "fullText"
      ? { mode, query: "  words  " } : { mode, query: "  words  ", vector: [1, 0], model: "model-v1" }) });
    expect((await runtime.invoke()).status).toBe(200);
    const init = fetchMock.mock.calls[0]![1];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer anon");
    expect(JSON.parse(init.body).request).toMatchObject({ mode, query: "words", limit: 10, where: {} });
  });

  it.each(["production", "dev"] as const)("retains actual caller and trusted %s profile", async environment => {
    const runtime = installRuntime(environment, { OPENCLOUD_DATA_SEARCH: JSON.stringify([searchBinding]) });
    const fetchMock = vi.fn().mockResolvedValue(Response.json(searchResult)); vi.stubGlobal("fetch", fetchMock);
    defineFunction({ input: schema.object({}), handler: ({ data }) => data.search("chunks", {
      mode: "vector", vector: [1, 0], model: "model-v1", where: { document_id: null },
    }) });
    const response = await runtime.invoke(jsonRequest({}, { authorization: "Bearer actual-caller" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(searchResult);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(`/rpc/${searchBinding.rpcName}`);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer actual-caller");
    expect(headers.get("content-profile")).toBe(environment === "dev" ? "oc_dev_00000000000040008000000000000002" : "app_00000000000040008000000000000001");
    expect(headers.get("x-opencloud-dev-session-id")).toBe(environment === "dev" ? devSessionId : null);
    expect(JSON.parse(init.body)).toEqual({ request: { mode: "vector", vector: [1, 0], model: "model-v1", where: { document_id: null }, limit: 10 } });
  });

  it.each([
    [{ mode: "vector", vector: [1, 0], model: "wrong" }, "SEARCH_MODEL_MISMATCH"],
    [{ mode: "vector", vector: [1], model: "model-v1" }, "SEARCH_DIMENSION_MISMATCH"],
    [{ mode: "vector", vector: [0, 0], model: "model-v1" }, "SEARCH_INPUT_INVALID"],
    [{ mode: "vector", vector: [Number.MAX_VALUE, 0], model: "model-v1" }, "SEARCH_INPUT_INVALID"],
    [{ mode: "vector", vector: [NaN, 0], model: "model-v1" }, "SEARCH_INPUT_INVALID"],
    [{ mode: "fullText", query: "hello", vector: [1, 0] }, "SEARCH_INPUT_INVALID"],
    [{ mode: "fullText", query: " ", limit: 5 }, "SEARCH_INPUT_INVALID"],
    [{ mode: "fullText", query: "hello", where: { foreign: "x" } }, "SEARCH_INPUT_INVALID"],
    [{ mode: "fullText", query: "hello", where: { document_id: {} } }, "SEARCH_INPUT_INVALID"],
    [{ mode: "fullText", query: "hello", limit: 51 }, "SEARCH_INPUT_INVALID"],
  ])("rejects invalid search input before network", async (options, code) => {
    const runtime = installRuntime("dev", { OPENCLOUD_DATA_SEARCH: JSON.stringify([searchBinding]) });
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    defineFunction({ input: schema.object({}), handler: ({ data }) => data.search("chunks", options as never) });
    const response = await runtime.invoke();
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe(code);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defaults absent bindings to no declared searches while keeping CRUD available", async () => {
    const runtime = installRuntime();
    defineFunction({ input: schema.object({}), handler: ({ data }) => data.search("chunks", { mode: "fullText", query: "hello" }) });
    const response = await runtime.invoke();
    expect((await response.json()).error.code).toBe("SEARCH_NOT_DECLARED");
  });

  it.each(["bad-json", JSON.stringify([{ ...searchBinding, rpcName: "../../another-schema" }]), JSON.stringify([searchBinding, searchBinding])])("rejects unsafe runtime bindings", async raw => {
    const runtime = installRuntime("dev", { OPENCLOUD_DATA_SEARCH: raw });
    defineFunction({ input: schema.object({}), handler: () => ({}) });
    const response = await runtime.invoke();
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("RUNTIME_BINDING_INVALID");
  });

  it.each([
    [400, { code: "PT400", message: "SEARCH_MODEL_MISMATCH", details: null, hint: null }, 400, "SEARCH_MODEL_MISMATCH"],
    [400, { code: "P0001", message: "raw SQL secret" }, 503, "SEARCH_UNAVAILABLE"],
    [400, { code: "PT400", message: "raw SQL secret" }, 503, "SEARCH_UNAVAILABLE"],
    [404, { code: "PGRST202", message: "raw SQL secret" }, 503, "SEARCH_UNAVAILABLE"],
    [503, { message: "raw SQL secret" }, 503, "SEARCH_UNAVAILABLE"],
    [401, { code: "PGRST301", message: "raw SQL secret" }, 401, "PGRST301"],
    [403, { code: "42501", message: "raw SQL secret" }, 403, "PLATFORM_REQUEST_FAILED"],
  ])("translates RPC errors without query or SQL disclosure", async (status, body, expectedStatus, code) => {
    const runtime = installRuntime("dev", { OPENCLOUD_DATA_SEARCH: JSON.stringify([searchBinding]) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status: status as number })));
    defineFunction({ input: schema.object({}), handler: ({ data }) => data.search("chunks", { mode: "fullText", query: "hello" }) });
    const response = await runtime.invoke(); const output = await response.text();
    expect(response.status).toBe(expectedStatus); expect(JSON.parse(output).error.code).toBe(code);
    expect(output).not.toContain("raw SQL secret");
    expect(JSON.parse(output).error.details).toBeUndefined();
  });

  it.each([
    [{ hits: [{ ...searchResult.hits[0], record: { id: "one", content: "x".repeat(16385) } }] }, "SEARCH_RESULT_TOO_LARGE"],
    [{ hits: [{ ...searchResult.hits[0], record: { id: "one", content: "ok", private: "hidden" } }] }, "SEARCH_UNAVAILABLE"],
    [{ hits: [{ ...searchResult.hits[0], vectorDistance: "0.1" }] }, "SEARCH_UNAVAILABLE"],
  ])("validates bounded selected evidence", async (result, code) => {
    const runtime = installRuntime("dev", { OPENCLOUD_DATA_SEARCH: JSON.stringify([searchBinding]) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(result)));
    defineFunction({ input: schema.object({}), handler: ({ data }) => data.search("chunks", { mode: "fullText", query: "hello" }) });
    const response = await runtime.invoke(); expect((await response.json()).error.code).toBe(code);
  });
});

describe("Function log", () => {
  it("keeps the call's message and level, and the call's fields apart under their own names", async () => {
    const runtime = installRuntime();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    defineFunction({ input: schema.object({}), handler: ({ log }) => {
      log.info("log probe", { message: "belt sensor recalibrated", level: "error", event: "signup",
        app_id: "forged", request_id: "upstream-7", count: 3, password: "pw-synthetic" });
      log.error("plain failure");
      return {};
    } });
    expect((await runtime.invoke()).status).toBe(200);
    const [record] = info.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(record).toMatchObject({ level: "info", event: "opencloud_function_log_v2", message: "log probe",
      app_id: appId, environment: "dev", dev_session_id: devSessionId });
    expect(record.fields).toEqual({ message: "belt sensor recalibrated", level: "error", event: "signup",
      app_id: "forged", request_id: "upstream-7", count: 3, password: "[redacted]" });
    const [failure] = error.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(failure).toMatchObject({ level: "error", message: "plain failure" });
    expect(failure).not.toHaveProperty("fields");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalDeno === undefined) {
    delete (globalThis as { Deno?: unknown }).Deno;
  } else {
    (globalThis as { Deno?: unknown }).Deno = originalDeno;
  }
});

function installRuntime(
  environment: "dev" | "production" = "dev",
  overrides: Record<string, string | undefined> = {},
) {
  let callback:
    ((request: Request) => Response | Promise<Response>) | undefined;
  const values: Record<string, string | undefined> = {
    OPENCLOUD_APP_ID: appId,
    OPENCLOUD_ENVIRONMENT: environment,
    OPENCLOUD_SCHEMA:
      environment === "dev"
        ? "oc_dev_00000000000040008000000000000002"
        : "app_00000000000040008000000000000001",
    OPENCLOUD_DEV_SESSION_ID: devSessionId,
    OPENCLOUD_FUNCTION_NAMESPACE: `dev_${devSessionId.replaceAll("-", "")}`,
    OPENCLOUD_SDK_VERSION: OPEN_CLOUD_SDK_VERSION,
    OPENCLOUD_DEPLOYMENT_VERSION: "00000000-0000-4000-8000-000000000005",
    OPENCLOUD_EMAIL_URL: "http://control.test/_internal/email/send",
    OPENCLOUD_EMAIL_TOKEN: "app-scoped-email-credential",
    OPENCLOUD_NOTIFICATIONS_URL:
      "http://control.test/_internal/notifications/send",
    OPENCLOUD_NOTIFICATIONS_TOKEN: "app-scoped-notifications-credential",
    OPENCLOUD_JOBS_URL: "http://control.test/_internal/jobs",
    OPENCLOUD_JOBS_TOKEN: "app-scoped-jobs-credential",
    SUPABASE_URL: "http://platform.test",
    SUPABASE_ANON_KEY: "anon",
    OPENCLOUD_REST_URL: "http://rest-dev.test/",
    OPENCLOUD_AI_BASE_URL: "http://ai-gateway.test/v1",
    OPENCLOUD_AI_API_KEY: "function_test_ai_grant_12345678901234567890",
    OPENCLOUD_AI_MODEL: "gpt-5.6-sol",
    OPENCLOUD_FILES_URL: "http://control.test/_opencloud/files",
    OPENCLOUD_FILES_GRANT: "signed-file-grant",
    OPENCLOUD_INTEGRATIONS_URL:
      "http://control.test/_opencloud/integrations/execute",
    OPENCLOUD_INTEGRATIONS_GRANT: "signed-integration-grant",
    OPENCLOUD_SECRET_NAMES: '["MAIL_API_TOKEN"]',
    OPENCLOUD_FUNCTION_REQUEST_ID: "function-request-id",
    OPENCLOUD_FUNCTION_EXECUTION_ID:
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    OPENCLOUD_FUNCTION_CORRELATION_ID: "function-correlation-id",
    OPENCLOUD_FUNCTION_NAME: "action",
    ...overrides,
  };
  (globalThis as { Deno?: unknown }).Deno = {
    env: { get: (name: string) => values[name] },
    serve: (handler: (request: Request) => Response | Promise<Response>) => {
      callback = handler;
    },
  };
  return {
    invoke(request = new Request("http://function.test")) {
      if (!callback) throw new Error("Function was not registered");
      return callback(request);
    },
  };
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://function.test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("@opencloud/server v2", () => {
  it("submits a declared agent task and reads status through opaque Function authority", async () => {
    const runtime = installRuntime("production", {
      OPENCLOUD_AGENT_TASKS_URL: "http://control.test/_internal/agent-tasks",
      OPENCLOUD_AGENT_TASKS_TOKEN: "signed-task-authority",
    });
    const fetcher = vi.fn(async (_url: URL | string, init?: RequestInit) => Response.json(
      init?.method === "POST" ? { runId: idempotencyKey } : { id: idempotencyKey, state: "queued" },
    ));
    vi.stubGlobal("fetch", fetcher);
    defineFunction({ input: schema.object({}), handler: async ({ agentTasks }) => {
      const run = await agentTasks.start("inspect", { assignments: [{ id: "forma", input: { url: "https://forma.test" } }] }, { idempotencyKey: "daily:2026-09-08" });
      return agentTasks.get(run.runId);
    } });
    expect((await runtime.invoke()).status).toBe(200);
    expect(String(fetcher.mock.calls[0]![0])).toBe("http://control.test/_internal/agent-tasks/");
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("x-opencloud-agent-tasks-token")).toBe("signed-task-authority");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ task: "inspect", idempotencyKey: "daily:2026-09-08" });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`http://control.test/_internal/agent-tasks/${idempotencyKey}`);
  });

  it("never falls back from development tasks to production", async () => {
    const runtime = installRuntime("dev", { OPENCLOUD_AGENT_TASKS_URL: "http://control.test/_internal/agent-tasks", OPENCLOUD_AGENT_TASKS_TOKEN: "unused" });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    defineFunction({ input: schema.object({}), handler: ({ agentTasks }) => agentTasks.start("inspect", { assignments: [] }, { idempotencyKey: "one" }) });
    expect((await runtime.invoke()).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("exposes immutable HTTP parameters and repeated query values only for routed requests", async () => {
    const runtime = installRuntime();
    defineFunction({ input: schema.object({}), handler: ({ http, input }) => {
      if (!http) return { http, input };
      expect(Object.isFrozen(http)).toBe(true);
      expect(Object.isFrozen(http.params)).toBe(true);
      expect(Object.isFrozen(http.params.path)).toBe(true);
      expect("set" in http.query).toBe(false);
      return { routeId: http.routeId, pathname: http.pathname, params: http.params,
        first: http.query.get("tag"), all: http.query.getAll("tag"), missing: http.query.get("missing"),
        empty: http.query.get("empty"), has: http.query.has("empty"), pairs: [...http.query.entries()], input };
    }});
    const http = { routeId: "files", method: "GET", pathname: "/files/%C3%A9/icon.png",
      params: { path: ["é", "icon.png"] }, query: [["tag", "one"], ["tag", "two"], ["empty", ""]] };
    const response = await runtime.invoke(new Request("http://function.test/internal", {
      headers: { "x-opencloud-route-context": Buffer.from(JSON.stringify(http)).toString("base64url") },
    }));
    expect(await response.json()).toEqual({ ...http, method: undefined, query: undefined,
      first: "one", all: ["one", "two"], missing: null, empty: "", has: true,
      pairs: http.query, input: {} });
    expect(await (await runtime.invoke()).json()).toEqual({ http: null, input: {} });
  });

  it("exposes only the gateway's sanitized client headers, read-only and case-insensitive", async () => {
    const runtime = installRuntime();
    defineFunction({ input: schema.object({}), handler: ({ headers }) => {
      if (!headers) return { headers };
      expect(Object.isFrozen(headers)).toBe(true);
      return { authorization: headers.get("Authorization"), apiKey: headers.get("x-api-key"),
        missing: headers.get("cookie"), has: headers.has("X-API-KEY"), pairs: [...headers.entries()] };
    }});
    const pairs = [["authorization", "Bearer app-token"], ["x-api-key", "k"]];
    const response = await runtime.invoke(new Request("http://function.test", { headers: {
      "x-opencloud-client-headers": Buffer.from(JSON.stringify(pairs)).toString("base64url"),
      // The raw worker request also carries platform headers; none of them leak.
      authorization: "Bearer platform-token", cookie: "oc_session=private",
    } }));
    expect(await response.json()).toEqual({ authorization: "Bearer app-token", apiKey: "k", missing: null,
      has: true, pairs });
    expect(await (await runtime.invoke()).json()).toEqual({ headers: null });
  });

  it.each(["not base64!", Buffer.from(JSON.stringify([["Upper", "v"]])).toString("base64url"),
    Buffer.from(JSON.stringify({ authorization: "x" })).toString("base64url")])(
    "rejects a malformed client header projection", async (encoded) => {
      const runtime = installRuntime();
      defineFunction({ input: schema.object({}), handler: () => ({ ok: true }) });
      const response = await runtime.invoke(new Request("http://function.test", {
        headers: { "x-opencloud-client-headers": encoded },
      }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST_HEADERS" } });
    },
  );

  it("acts as an app-managed user with one cached, execution-bound token per user", async () => {
    const runtime = installRuntime("production", {
      OPENCLOUD_APP_USERS_URL: "http://control.test/_internal/app-users/tokens",
      OPENCLOUD_APP_USERS_TOKEN: "signed-app-users-grant",
    });
    const minted: string[] = [];
    const fetcher = vi.fn(async (url: URL | string, init?: RequestInit) => {
      if (String(url).endsWith("/_internal/app-users/tokens")) {
        const { appUserId } = JSON.parse(String(init?.body));
        minted.push(appUserId);
        return Response.json({ accessToken: `h.${appUserId}.s`, expiresAt: new Date(Date.now() + 300_000).toISOString() });
      }
      return Response.json([{ id: 1 }]);
    });
    vi.stubGlobal("fetch", fetcher);
    defineFunction({ input: schema.object({}), handler: async ({ data }) => {
      const alice = data.asAppUser("usr_alice");
      await alice.table("notes").list();
      await alice.table("notes").list();
      await data.asAppUser("usr_bob").table("notes").list();
      await data.table("notes").list();
      return { appUserId: alice.appUserId };
    } });
    const response = await runtime.invoke(new Request("http://function.test", {
      headers: { authorization: "Bearer caller-token" },
    }));
    expect(await response.json()).toEqual({ appUserId: "usr_alice" });
    expect(minted).toEqual(["usr_alice", "usr_bob"]);
    const mintCall = fetcher.mock.calls.find(([url]) => String(url).endsWith("/tokens"))!;
    expect(new Headers(mintCall[1]?.headers).get("x-opencloud-app-users-token")).toBe("signed-app-users-grant");
    const dataAuth = fetcher.mock.calls.filter(([url]) => String(url).includes("/rest/v1/notes"))
      .map(([, init]) => new Headers(init?.headers).get("authorization"));
    expect(dataAuth).toEqual(["Bearer h.usr_alice.s", "Bearer h.usr_alice.s", "Bearer h.usr_bob.s", "Bearer caller-token"]);
  });

  it.each([
    [{}, "APP_USER_IDENTITY_UNAVAILABLE"],
    [{ OPENCLOUD_APP_USERS_URL: "http://control.test/_internal/app-users/tokens", OPENCLOUD_APP_USERS_TOKEN: "grant" },
      "APP_USER_IDENTITY_REQUIRES_PUBLIC_APP"],
  ])("surfaces app-user identity failures with their own codes", async (overrides, code) => {
    const runtime = installRuntime("production", overrides);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { code: "APP_USER_IDENTITY_REQUIRES_PUBLIC_APP", message: "App-managed users need a public app" }, { status: 409 },
    )));
    defineFunction({ input: schema.object({}), handler: ({ data }) => data.asAppUser("usr_alice").table("notes").list() });
    expect(await (await runtime.invoke()).json()).toMatchObject({ error: { code } });
  });

  it.each(["", "has space", "x".repeat(256), "é"])("rejects invalid app user ID %j before any request", async (id) => {
    const runtime = installRuntime();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    defineFunction({ input: schema.object({}), handler: ({ data }) => data.asAppUser(id) });
    expect(await (await runtime.invoke()).json()).toMatchObject({ error: { code: "INVALID_APP_USER_ID" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([200, 404])("preserves binary status/headers and suppresses HEAD bytes (%i)", async status => {
    const runtime = installRuntime();
    const pixel = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    defineFunction({ input: schema.object({}), handler: () => new Response(pixel, { status, headers: { "content-type": "image/png" } }) });
    const get = await runtime.invoke();
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(pixel);
    const head = await runtime.invoke(new Request("http://function.test", { method: "HEAD" }));
    expect(head.status).toBe(status);
    expect(head.headers.get("content-type")).toBe("image/png");
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(head.body).toBeNull();
  });

  it("keeps invalid-input HEAD failures bodyless", async () => {
    const runtime = installRuntime();
    defineFunction({ input: schema.object({ value: schema.string() }), handler: () => ({ ok: true }) });
    const result = await runtime.invoke(new Request("http://function.test", { method: "HEAD" }));
    expect(result.status).toBe(400);
    expect(result.body).toBeNull();
  });
  it("exposes only the high-level context and identifies every response", async () => {
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: (context) => ({
        keys: Object.keys(context).sort(),
        user: context.user,
        environment: context.environment,
      }),
    });

    const response = await runtime.invoke(
      new Request("http://function.test", {
        headers: { "x-opencloud-user-id": userId, "x-request-id": "req-test" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req-test");
    expect(response.headers.get("x-opencloud-sdk-version")).toBe("2.9.0");
    await expect(response.json()).resolves.toEqual({
      keys: [
        "agentTasks",
        "ai",
        "containers",
        "data",
        "email",
        "environment",
        "files",
        "headers",
        "http",
        "input",
        "integration",
        "integrations",
        "job",
        "jobs",
        "log",
        "notifications",
        "requestId",
        "secrets",
        "user",
      ],
      user: { id: userId },
      environment: "dev",
    });
  });

  it("does not expose malformed runtime user identities", async () => {
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: ({ user }) => ({ user }),
    });

    const response = await runtime.invoke(
      new Request("http://function.test", {
        headers: { "x-opencloud-user-id": "caller-controlled" },
      }),
    );

    await expect(response.json()).resolves.toEqual({ user: null });
  });

  it("parses input with dependency-free schemas and reports useful failures", async () => {
    const runtime = installRuntime();
    const inputSchema = schema.object({
      title: schema.string({ minLength: 2 }),
      count: schema.optional(schema.number({ integer: true, min: 1 })),
      tags: schema.array(schema.string(), { maxLength: 2 }),
      mode: schema.enum(["ship", "hold"]),
      note: schema.nullable(schema.string()),
      metadata: schema.record(),
    });
    defineFunction({ input: inputSchema, handler: async ({ input }) => input });

    const success = await runtime.invoke(
      jsonRequest({
        title: "Ship",
        tags: ["sdk"],
        mode: "ship",
        note: null,
        metadata: { source: "email", nested: { safe: true } },
      }),
    );
    await expect(success.json()).resolves.toEqual({
      title: "Ship",
      tags: ["sdk"],
      mode: "ship",
      note: null,
      metadata: { source: "email", nested: { safe: true } },
    });

    const failure = await runtime.invoke(
      jsonRequest({
        title: "x",
        tags: [],
        mode: "hold",
        note: null,
        metadata: {},
        typo: true,
      }),
    );
    expect(failure.status).toBe(400);
    await expect(failure.json()).resolves.toMatchObject({
      error: {
        code: "INVALID_INPUT",
        retryable: false,
        details: { message: expect.stringContaining("unknown field typo") },
      },
    });
  });

  it("provides bounded row methods without raw database access", async () => {
    const fetcher = vi.fn(async () =>
      Response.json([{ id: 1, state: "open" }]),
    );
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: async ({ data }) => {
        expect(Object.keys(data)).toEqual(["search", "table", "asAppUser"]);
        const items = data.table("items");
        await items.list({
          select: ["id", "state"],
          where: { state: "open" },
          orderBy: { column: "id", direction: "desc" },
          limit: 10,
        });
        await items.getById(1);
        await items.create({ state: "open" });
        await items.createMany([{ state: "open" }, { state: "closed" }]);
        await items.updateById(1, { state: "closed" });
        await items.deleteById(1);
        return items.compareAndSet(1, { state: "open" }, { state: "closed" });
      },
    });

    const response = await runtime.invoke();
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(7);
    const calls = fetcher.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit | undefined)?.method ?? "GET",
      headers: new Headers((init as RequestInit | undefined)?.headers),
    }));
    expect(calls[0]?.url).toContain(
      "items?select=id%2Cstate&state=eq.open&order=id.desc&limit=10",
    );
    expect(calls[1]?.url).toContain("items?select=*&id=eq.1&limit=1");
    expect(calls.map(({ method }) => method)).toEqual([
      "GET",
      "GET",
      "POST",
      "POST",
      "PATCH",
      "DELETE",
      "PATCH",
    ]);
    expect(calls[0]?.headers.get("x-opencloud-dev-session-id")).toBe(
      devSessionId,
    );
    expect(calls[6]?.url).toContain("id=eq.1&state=eq.open");
    await expect(response.json()).resolves.toEqual({
      updated: true,
      record: { id: 1, state: "open" },
    });
  });

  it("rejects empty bulk and update mutations before making requests", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: ({ data }) => data.table("items").createMany([]),
    });

    const response = await runtime.invoke();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_DATA_MUTATION" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uploads, inspects, downloads, replaces, and removes opaque files", async () => {
    const now = "2026-08-09T12:00:00.000Z";
    const file = {
      id: fileId,
      name: "report.txt",
      contentType: "text/plain",
      size: 5,
      createdAt: now,
      updatedAt: now,
    };
    const fetcher = vi.fn(async (url: URL | string, init?: RequestInit) => {
      if (String(url).endsWith("/content")) {
        return new Response(new TextEncoder().encode("hello"), {
          headers: {
            "content-type": "text/plain",
            "x-opencloud-file-name": "report.txt",
          },
        });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json(file);
    });
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: async ({ files }) => {
        expect(Object.keys(files).sort()).toEqual([
          "abortUpload",
          "beginUpload",
          "completeUpload",
          "download",
          "downloadStream",
          "info",
          "remove",
          "replace",
          "upload",
          "uploadChunk",
          "uploadStatus",
        ]);
        const uploaded = await files.upload({
          data: "hello",
          name: "report.txt",
          contentType: "text/plain",
        });
        const info = await files.info(uploaded);
        const downloaded = await files.download({ id: uploaded.id });
        const replaced = await files.replace(uploaded, {
          data: "world",
          name: "report.txt",
        });
        await files.remove(uploaded);
        return {
          info,
          replaced,
          text: new TextDecoder().decode(downloaded.data),
          downloadName: downloaded.name,
          downloadSize: downloaded.size,
        };
      },
    });

    const response = await runtime.invoke();
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(5);
    const calls = fetcher.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    }));
    expect(calls.map(({ url }) => url)).toEqual([
      "http://control.test/_opencloud/files",
      `http://control.test/_opencloud/files/${fileId}/metadata`,
      `http://control.test/_opencloud/files/${fileId}/content`,
      `http://control.test/_opencloud/files/${fileId}`,
      `http://control.test/_opencloud/files/${fileId}`,
    ]);
    expect(calls.map(({ method }) => method)).toEqual([
      "POST",
      "GET",
      "GET",
      "PUT",
      "DELETE",
    ]);
    for (const call of calls) {
      expect(call.headers.get("x-opencloud-function-grant")).toBe(
        "signed-file-grant",
      );
    }
    expect(calls[0]?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[3]?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]?.headers.get("x-opencloud-file-name")).toBe("report.txt");
    await expect(response.json()).resolves.toMatchObject({
      info: file,
      replaced: file,
      text: "hello",
      downloadName: "report.txt",
      downloadSize: 5,
    });
  });

  it("retries one transient Function upload with the same private key", async () => {
    const now = "2026-08-09T12:00:00.000Z";
    const file = {
      id: fileId,
      name: "report.txt",
      contentType: "text/plain",
      size: 5,
      createdAt: now,
      updatedAt: now,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "FILES_BUSY", message: "Try again" } },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(Response.json(file));
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: ({ files }) =>
        files.upload({ data: "hello", name: "report.txt" }),
    });

    const response = await runtime.invoke();
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const keys = fetcher.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("idempotency-key"),
    );
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it("generates text, objects, and images without provider plumbing", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ]);
    const streamEncoder = new TextEncoder();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: "Hello world" } }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              message: {
                content:
                  '{"title":"Ship","subtitle":null,"details":{"assignee":null,"note":null}}',
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                streamEncoder.encode(
                  'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\ndata: {"choices":[{"delta":{"content":"Hello "}}]}\n\ndata: {"choices":[{"delta":{"content":"wor',
                ),
              );
              controller.enqueue(
                streamEncoder.encode(
                  'ld"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                ),
              );
              controller.close();
            },
          }),
          {
            headers: { "content-type": "text/event-stream; charset=utf-8" },
          },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              b64_json: png.toString("base64"),
              revised_prompt: "A concise dodo illustration",
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: async ({ ai }) => {
        expect(Object.keys(ai)).toEqual([
          "generateText",
          "streamText",
          "generateObject",
          "generateImage",
        ]);
        expect("apiKey" in ai).toBe(false);
        expect("baseUrl" in ai).toBe(false);
        const text = await ai.generateText({
          prompt: "Say hello",
          instructions: "Be concise",
        });
        const object = await ai.generateObject({
          prompt: "Name the task",
          model: "claude-haiku-5-5",
          attachments: [
            {
              type: "image",
              data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
              contentType: "image/png",
              detail: "original",
            },
            {
              type: "file",
              file: { id: "00000000-0000-4000-8000-000000000099" },
              detail: "high",
            },
          ],
          schema: schema.object({
            title: schema.string(),
            subtitle: schema.optional(schema.string()),
            details: schema.object({
              assignee: schema.optional(schema.string()),
              note: schema.nullable(schema.string()),
            }),
          }),
        });
        expect(object).toEqual({
          title: "Ship",
          subtitle: undefined,
          details: { assignee: undefined, note: null },
        });
        const textStream = await ai.streamText({ prompt: "Say hello slowly" });
        const streamedText = await new Response(textStream).text();
        const image = await ai.generateImage({
          prompt: "Draw a friendly dodo",
        });
        return {
          text,
          streamedText,
          object,
          image: {
            bytes: Array.from(image.data),
            contentType: image.contentType,
            revisedPrompt: image.revisedPrompt,
          },
        };
      },
    });

    const response = await runtime.invoke();
    expect(response.status).toBe(200);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "http://ai-gateway.test/v1/chat/completions",
    );
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe(
      "Bearer function_test_ai_grant_12345678901234567890",
    );
    expect(headers.has("x-opencloud-files-grant")).toBe(false);
    expect(headers.has("x-opencloud-ai-model")).toBe(false);
    const firstBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(firstBody).toMatchObject({
      model: "gpt-5.6-sol",
      messages: [
        { role: "developer", content: "Be concise" },
        { role: "user", content: "Say hello" },
      ],
      response_format: { type: "text" },
    });
    const secondBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(secondBody.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Name the task" },
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,iVBORw==",
              detail: "original",
            },
          },
          {
            type: "opencloud_file",
            file_id: "00000000-0000-4000-8000-000000000099",
            detail: "high",
          },
        ],
      },
    ]);
    const secondHeaders = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(secondHeaders.get("x-opencloud-files-grant")).toBe(
      "signed-file-grant",
    );
    // The chosen model travels apart from the body's runtime default.
    expect(secondHeaders.get("x-opencloud-ai-model")).toBe("claude-haiku-5-5");
    expect(secondBody.model).toBe("gpt-5.6-sol");
    expect(secondBody.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "opencloud_result",
        strict: true,
        schema: {
          type: "object",
          required: ["title", "subtitle", "details"],
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            subtitle: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
            details: {
              type: "object",
              required: ["assignee", "note"],
              additionalProperties: false,
              properties: {
                assignee: {
                  anyOf: [{ type: "string" }, { type: "null" }],
                },
                note: {
                  anyOf: [{ type: "string" }, { type: "null" }],
                },
              },
            },
          },
        },
      },
    });
    const thirdBody = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body));
    expect(thirdBody).toMatchObject({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "Say hello slowly" }],
      response_format: { type: "text" },
      stream: true,
    });
    expect(String(fetcher.mock.calls[3]?.[0])).toBe(
      "http://ai-gateway.test/v1/images/generations",
    );
    const fourthBody = JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body));
    expect(fourthBody).toEqual({ prompt: "Draw a friendly dodo" });
    await expect(response.json()).resolves.toEqual({
      text: "Hello world",
      streamedText: "Hello world",
      object: { title: "Ship", details: { note: null } },
      image: {
        bytes: Array.from(png),
        contentType: "image/png",
        revisedPrompt: "A concise dodo illustration",
      },
    });
  });

  it("rejects an invalid model before calling the gateway", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: ({ ai }) => ai.generateText({ prompt: "Read this", model: "Claude Haiku" }),
    });

    const response = await runtime.invoke();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_AI_INPUT", retryable: false },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unsupported or oversized AI attachments before calling the gateway", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: ({ ai }) =>
        ai.generateText({
          prompt: "Read this",
          attachments: [
            {
              type: "image",
              data: new Uint8Array(15 * 1024 * 1024 + 1),
              contentType: "image/png",
            },
          ],
        }),
    });

    const response = await runtime.invoke();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_AI_ATTACHMENT", retryable: false },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("brokers Google Calendar calls without exposing credentials", async () => {
    const bindingId = "00000000-0000-4000-8000-000000000006";
    const event = {
      id: "google-event-1",
      summary: "Design review",
      description: null,
      start: "2026-08-20T10:00:00.000Z",
      end: "2026-08-20T10:30:00.000Z",
      status: "confirmed",
      htmlLink: null,
    };
    const fetcher = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.operation === "calendar.bindings.list") {
        return Response.json({
          bindings: [{ id: bindingId, label: "Primary" }],
        });
      }
      if (body.operation === "calendar.events.list") {
        return Response.json({ events: [event], nextPageToken: null });
      }
      return Response.json(event);
    });
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: async ({ integrations }) => {
        expect(Object.keys(integrations)).toEqual([
          "use",
          "calendar",
          "drive",
          "sheets",
          "docs",
          "slides",
          "bankAccountData",
          "receivedPayments",
          "sentTransfers",
          "slack",
          "telegram",
          "asana",
          "crm",
        ]);
        const calendar = integrations.calendar("team_calendar");
        expect(Object.keys(calendar).sort()).toEqual([
          "bindings",
          "createEvent",
          "listEvents",
        ]);
        const bindings = await calendar.bindings();
        const listed = await calendar.listEvents({
          bindingId,
          from: "2026-08-20T00:00:00.000Z",
          to: "2026-08-21T00:00:00.000Z",
        });
        const created = await calendar.createEvent({
          bindingId,
          summary: "Design review",
          start: event.start,
          end: event.end,
        });
        return { bindings, listed, created };
      },
    });

    const response = await runtime.invoke();
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toBe(
        "http://control.test/_opencloud/integrations/execute",
      );
      expect(new Headers(init?.headers).get("x-opencloud-function-grant")).toBe(
        "signed-integration-grant",
      );
      expect(String(init?.body)).not.toContain("token");
    }
    const bodies = fetcher.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(bodies).toMatchObject([
      {
        integration: "team_calendar",
        operation: "calendar.bindings.list",
        input: {},
      },
      {
        integration: "team_calendar",
        bindingId,
        operation: "calendar.events.list",
        input: {
          from: "2026-08-20T00:00:00.000Z",
          to: "2026-08-21T00:00:00.000Z",
        },
      },
      {
        integration: "team_calendar",
        bindingId,
        operation: "calendar.events.create",
        input: {
          summary: "Design review",
          start: event.start,
          end: event.end,
        },
      },
    ]);
    await expect(response.json()).resolves.toMatchObject({
      bindings: [{ id: bindingId }],
      listed: { events: [event] },
      created: event,
    });
  });

  it("brokers provider-independent integration calls through opaque bindings", async () => {
    const bindingId = "00000000-0000-4000-8000-000000000026";
    const fetcher = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (
        body.operation === "bindings.list" ||
        body.operation.endsWith(".bindings.list")
      ) {
        return Response.json({ bindings: [{ id: bindingId, label: "Exact resource" }] });
      }
      if (body.operation === "analytics.reports.run") {
        return Response.json({ rows: [], totals: { sessions: "42" }, rowCount: 0 });
      }
      if (body.operation === "searchConsole.performance.query") {
        return Response.json({ rows: [], aggregationType: "byProperty" });
      }
      return Response.json({ rows: [], nextPageToken: null });
    });
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: async ({ integrations }) => {
        const analytics = integrations.use("site_analytics");
        return {
          analyticsBindings: await analytics.bindings(),
          analytics: await analytics.call(
            "analytics.reports.run",
            {
              startDate: "2026-08-01",
              endDate: "2026-08-20",
              dimensions: ["date"],
              metrics: ["sessions"],
            },
            { bindingId },
          ),
          search: await integrations.use("site_search").call(
            "searchConsole.performance.query",
            {
              startDate: "2026-08-01",
              endDate: "2026-08-20",
              dimensions: ["query"],
            },
            { bindingId },
          ),
          ads: await integrations.use("site_ads").call(
            "googleAds.campaigns.report",
            {
              startDate: "2026-08-01",
              endDate: "2026-08-20",
              limit: 25,
            },
            { bindingId },
          ),
        };
      },
    });

    const response = await runtime.invoke();
    expect(response.status).toBe(200);
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      {
        integration: "site_analytics",
        operation: "bindings.list",
        input: {},
      },
      {
        integration: "site_analytics",
        bindingId,
        operation: "analytics.reports.run",
        input: {
          startDate: "2026-08-01",
          endDate: "2026-08-20",
          dimensions: ["date"],
          metrics: ["sessions"],
        },
      },
      {
        integration: "site_search",
        bindingId,
        operation: "searchConsole.performance.query",
        input: {
          startDate: "2026-08-01",
          endDate: "2026-08-20",
          dimensions: ["query"],
        },
      },
      {
        integration: "site_ads",
        bindingId,
        operation: "googleAds.campaigns.report",
        input: {
          startDate: "2026-08-01",
          endDate: "2026-08-20",
          limit: 25,
        },
      },
    ]);
    await expect(response.json()).resolves.toMatchObject({
      analytics: { totals: { sessions: "42" } },
      search: { aggregationType: "byProperty" },
      ads: { nextPageToken: null },
    });
  });

  it("accepts future bounded integration operations without an SDK change", async () => {
    const fetcher = vi.fn(async () => Response.json({ records: ["one"] }));
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: async ({ integrations }) => {
        const future = integrations.use("future_catalog");
        let invalidCode: string | null = null;
        try {
          await future.call("https://provider.test/raw", {});
        } catch (error) {
          invalidCode =
            error instanceof OpenCloudError ? error.code : "unknown";
        }
        const result = await future.call<{ records: string[] }>(
          "catalog.records.list",
          { limit: 10 },
        );
        return { invalidCode, result };
      },
    });

    const response = await runtime.invoke();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({
      integration: "future_catalog",
      operation: "catalog.records.list",
      input: { limit: 10 },
    });
    await expect(response.json()).resolves.toEqual({
      invalidCode: "INVALID_INTEGRATION_OPERATION",
      result: { records: ["one"] },
    });
  });

  it("sends Slack messages through an opaque channel binding", async () => {
    const bindingId = "00000000-0000-4000-8000-000000000022";
    const fetcher = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.operation === "slack.bindings.list") {
        return Response.json({
          bindings: [
            { id: bindingId, label: "#shipping", triggerMode: "mention" },
          ],
        });
      }
      return Response.json({
        bindingId,
        timestamp: "1770000000.000002",
        threadTimestamp: "1770000000.000001",
        appName: "Orders",
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: async ({ integrations }) => {
        const slack = integrations.slack("team_chat");
        return {
          bindings: await slack.bindings(),
          sent: await slack.sendMessage({
            bindingId,
            text: "Shipment dispatched",
            threadTimestamp: "1770000000.000001",
          }),
        };
      },
    });

    const response = await runtime.invoke();

    expect(response.status).toBe(200);
    const bodies = fetcher.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(bodies).toEqual([
      {
        integration: "team_chat",
        operation: "slack.bindings.list",
        input: {},
      },
      {
        integration: "team_chat",
        operation: "slack.messages.send",
        bindingId,
        input: {
          text: "Shipment dispatched",
          threadTimestamp: "1770000000.000001",
        },
      },
    ]);
    expect(JSON.stringify(bodies)).not.toContain("connectionId");
    await expect(response.json()).resolves.toMatchObject({
      bindings: [{ id: bindingId, triggerMode: "mention" }],
      sent: { appName: "Orders", bindingId },
    });
  });

  it("sends Telegram messages through an opaque chat binding", async () => {
    const bindingId = "00000000-0000-4000-8000-000000000023";
    const fetcher = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.operation === "telegram.bindings.list") {
        return Response.json({
          bindings: [
            {
              id: bindingId,
              label: "Shipping",
              triggerMode: "directed",
            },
          ],
        });
      }
      return Response.json({
        bindingId,
        messageId: 42,
        messageThreadId: 8,
        appName: "Orders",
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: async ({ integrations }) => {
        const telegram = integrations.telegram("team_chat");
        return {
          bindings: await telegram.bindings(),
          sent: await telegram.sendMessage({
            bindingId,
            text: "Shipment dispatched",
            messageThreadId: 8,
            replyToMessageId: 12,
          }),
        };
      },
    });

    const response = await runtime.invoke();

    expect(response.status).toBe(200);
    const bodies = fetcher.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(bodies).toEqual([
      {
        integration: "team_chat",
        operation: "telegram.bindings.list",
        input: {},
      },
      {
        integration: "team_chat",
        operation: "telegram.messages.send",
        bindingId,
        input: {
          text: "Shipment dispatched",
          messageThreadId: 8,
          replyToMessageId: 12,
        },
      },
    ]);
    expect(JSON.stringify(bodies)).not.toContain("chatId");
    await expect(response.json()).resolves.toMatchObject({
      bindings: [{ id: bindingId, triggerMode: "directed" }],
      sent: { appName: "Orders", bindingId, messageId: 42 },
    });
  });

  it("brokers typed HubSpot CRM actions through an opaque portal binding", async () => {
    const bindingId = "00000000-0000-4000-8000-000000000024";
    const record = {
      id: "101",
      properties: { email: "ada@example.test" },
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-17T00:00:00Z",
      archived: false,
      isNew: null,
    };
    const fetcher = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      switch (body.operation) {
        case "crm.bindings.list":
          return Response.json({
            bindings: [{ id: bindingId, label: "Example portal" }],
          });
        case "crm.contacts.search":
          return Response.json({
            records: [record],
            total: 1,
            nextAfter: null,
          });
        case "crm.owners.list":
          return Response.json({ owners: [], nextAfter: null });
        case "crm.dealPipelines.list":
          return Response.json({ pipelines: [] });
        case "crm.associations.create":
          return Response.json({ associated: true });
        default:
          return Response.json(record);
      }
    });
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: async ({ integrations }) => {
        const crm = integrations.crm("sales_crm");
        return {
          bindings: await crm.bindings(),
          contacts: await crm.contacts.search({
            bindingId,
            query: "ada@example.test",
            properties: ["email"],
            limit: 10,
          }),
          company: await crm.companies.update({
            bindingId,
            recordId: "202",
            properties: { name: "Analytical Engines" },
          }),
          deal: await crm.deals.upsert({
            bindingId,
            idProperty: "external_deal_id",
            id: "order-42",
            properties: { dealname: "Engine order" },
          }),
          owners: await crm.owners.list({ bindingId, limit: 25 }),
          pipelines: await crm.pipelines.listDeals({ bindingId }),
          note: await crm.notes.create({
            bindingId,
            body: "Qualified by the app",
          }),
          association: await crm.associations.create({
            bindingId,
            fromObjectType: "notes",
            fromRecordId: "301",
            toObjectType: "contacts",
            toRecordId: "101",
          }),
        };
      },
    });

    const response = await runtime.invoke();

    expect(response.status).toBe(200);
    const bodies = fetcher.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(bodies.map((body) => body.operation)).toEqual([
      "crm.bindings.list",
      "crm.contacts.search",
      "crm.companies.update",
      "crm.deals.upsert",
      "crm.owners.list",
      "crm.dealPipelines.list",
      "crm.notes.create",
      "crm.associations.create",
    ]);
    expect(bodies[1]).toMatchObject({
      integration: "sales_crm",
      bindingId,
      input: {
        query: "ada@example.test",
        properties: ["email"],
        limit: 10,
      },
    });
    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toContain("token");
      expect(JSON.stringify(body)).not.toContain("connectionId");
    }
    await expect(response.json()).resolves.toMatchObject({
      bindings: [{ id: bindingId }],
      contacts: { total: 1 },
      association: { associated: true },
    });
  });

  it("brokers typed Google Drive, Sheets, Docs, and Slides operations", async () => {
    const fetcher = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      switch (body.operation) {
        case "drive.files.list":
          return Response.json({
            files: [],
            nextPageToken: null,
            incompleteSearch: false,
          });
        case "drive.folders.create":
          return Response.json({ id: "folder-1", name: "Reports" });
        case "sheets.values.get":
          return Response.json({
            range: "Sheet1!A1:B2",
            majorDimension: "ROWS",
            values: [["A", 1]],
          });
        case "sheets.values.append":
          return Response.json({
            spreadsheetId: "sheet-1",
            updatedRange: "Sheet1!A3:B3",
            updatedRows: 1,
            updatedColumns: 2,
            updatedCells: 2,
            tableRange: "Sheet1!A1:B3",
          });
        case "docs.documents.get":
          return Response.json({
            id: "doc-1",
            title: "Plan",
            revisionId: "r1",
            text: "Plan\n",
            tabs: [],
          });
        case "docs.documents.appendText":
          return Response.json({ documentId: "doc-1", revisionId: "r2" });
        case "slides.presentations.get":
          return Response.json({ id: "slides-1", title: "Review", slides: [] });
        case "slides.presentations.addSlide":
          return Response.json({
            presentationId: "slides-1",
            slideId: "slide-1",
            title: "Status",
            body: "Green",
          });
        default:
          throw new Error(`Unexpected operation ${body.operation}`);
      }
    });
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: async ({ integrations }) => ({
        files: await integrations.drive("drive").listFiles({ pageSize: 25 }),
        folder: await integrations
          .drive("drive")
          .createFolder({ name: "Reports" }),
        values: await integrations.sheets("sheets").getValues({
          spreadsheetId: "sheet-1",
          range: "Sheet1!A1:B2",
        }),
        appended: await integrations.sheets("sheets").appendValues({
          spreadsheetId: "sheet-1",
          range: "Sheet1!A:B",
          values: [["B", 2]],
        }),
        document: await integrations.docs("docs").getDocument({
          documentId: "doc-1",
        }),
        documentUpdate: await integrations.docs("docs").appendText({
          documentId: "doc-1",
          text: "Next step\n",
        }),
        presentation: await integrations.slides("slides").getPresentation({
          presentationId: "slides-1",
        }),
        slide: await integrations.slides("slides").addSlide({
          presentationId: "slides-1",
          title: "Status",
          body: "Green",
        }),
      }),
    });

    const response = await runtime.invoke();

    expect(response.status).toBe(200);
    const bodies = fetcher.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(bodies.map((body) => body.operation)).toEqual([
      "drive.files.list",
      "drive.folders.create",
      "sheets.values.get",
      "sheets.values.append",
      "docs.documents.get",
      "docs.documents.appendText",
      "slides.presentations.get",
      "slides.presentations.addSlide",
    ]);
    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toContain("token");
      expect(JSON.stringify(body)).not.toContain("connectionId");
    }
    await expect(response.json()).resolves.toMatchObject({
      folder: { id: "folder-1" },
      values: { values: [["A", 1]] },
      document: { id: "doc-1" },
      slide: { slideId: "slide-1" },
    });
  });

  it("brokers typed Asana tasks, project resources, and attachment bytes", async () => {
    const bindingId = "00000000-0000-4000-8000-000000000026";
    const task = {
      id: "task-1",
      name: "Prepare launch",
      completed: false,
      memberships: [],
      customFields: [],
    };
    const attachment = {
      id: "attachment-1",
      name: "brief.txt",
      subtype: "asana",
      host: "asana",
      createdAt: null,
      viewUrl: null,
      downloadAvailable: true,
      parentId: "task-1",
    };
    const fetcher = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith("/asana/attachments/upload")) {
        return Response.json(attachment);
      }
      if (target.pathname.endsWith("/asana/attachments/download")) {
        return new Response(new TextEncoder().encode("attachment body"), {
          headers: {
            "content-type": "text/plain",
            "x-opencloud-file-name": encodeURIComponent("brief.txt"),
          },
        });
      }
      const body = JSON.parse(String(init?.body));
      switch (body.operation) {
        case "asana.bindings.list":
          return Response.json({
            bindings: [{ id: bindingId, label: "Launch" }],
          });
        case "asana.tasks.list":
          return Response.json({ tasks: [task], nextOffset: null });
        case "asana.assignees.list":
          return Response.json({
            users: [{ id: "user-1", name: "Taylor", email: null }],
            nextOffset: null,
          });
        case "asana.sections.list":
          return Response.json({
            sections: [{ id: "section-1", name: "In progress" }],
          });
        case "asana.customFields.list":
          return Response.json({
            customFields: [{ id: "field-1", name: "Priority", type: "enum" }],
          });
        case "asana.attachments.list":
          return Response.json({
            attachments: [attachment],
            nextOffset: null,
          });
        case "asana.attachments.createExternal":
          return Response.json({ ...attachment, subtype: "external" });
        case "asana.stories.list":
          return Response.json({ stories: [], nextOffset: null });
        case "asana.stories.createComment":
          return Response.json({
            id: "story-1",
            type: "comment_added",
            text: body.input.text,
          });
        default:
          return Response.json(task);
      }
    });
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: async ({ integrations }) => {
        const asana = integrations.asana("work");
        expect(Object.keys(asana).sort()).toEqual([
          "assignTask",
          "bindings",
          "createComment",
          "createExternalAttachment",
          "createTask",
          "downloadAttachment",
          "getTask",
          "listAssignees",
          "listAttachments",
          "listCustomFields",
          "listSections",
          "listStories",
          "listTasks",
          "moveTask",
          "updateCustomFields",
          "updateTask",
          "uploadAttachment",
        ]);
        return {
          bindings: await asana.bindings(),
          tasks: await asana.listTasks({ bindingId, limit: 25 }),
          created: await asana.createTask({
            bindingId,
            name: "Prepare launch",
            assigneeId: "user-1",
            sectionId: "section-1",
            customFields: { "field-1": "option-1" },
          }),
          assignees: await asana.listAssignees({ bindingId }),
          assigned: await asana.assignTask({
            bindingId,
            taskId: "task-1",
            assigneeId: "user-1",
          }),
          sections: await asana.listSections({ bindingId }),
          moved: await asana.moveTask({
            bindingId,
            taskId: "task-1",
            sectionId: "section-1",
          }),
          fields: await asana.listCustomFields({ bindingId }),
          fieldUpdate: await asana.updateCustomFields({
            bindingId,
            taskId: "task-1",
            values: { "field-1": "option-1" },
          }),
          attachments: await asana.listAttachments({
            bindingId,
            taskId: "task-1",
          }),
          external: await asana.createExternalAttachment({
            bindingId,
            taskId: "task-1",
            name: "Brief",
            url: "https://example.test/brief",
          }),
          uploaded: await asana.uploadAttachment({
            bindingId,
            taskId: "task-1",
            data: "attachment body",
            name: "brief.txt",
          }),
          downloaded: await asana.downloadAttachment({
            bindingId,
            taskId: "task-1",
            attachmentId: "attachment-1",
          }),
          stories: await asana.listStories({
            bindingId,
            taskId: "task-1",
          }),
          comment: await asana.createComment({
            bindingId,
            taskId: "task-1",
            text: "Ready to ship",
          }),
        };
      },
    });

    const response = await runtime.invoke();

    expect(response.status).toBe(200);
    const executeBodies = fetcher.mock.calls
      .filter(([url]) => String(url).endsWith("/execute"))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(executeBodies.map((body) => body.operation)).toEqual([
      "asana.bindings.list",
      "asana.tasks.list",
      "asana.tasks.create",
      "asana.assignees.list",
      "asana.assignees.assign",
      "asana.sections.list",
      "asana.sections.moveTask",
      "asana.customFields.list",
      "asana.customFields.updateTask",
      "asana.attachments.list",
      "asana.attachments.createExternal",
      "asana.stories.list",
      "asana.stories.createComment",
    ]);
    for (const body of executeBodies) {
      expect(JSON.stringify(body)).not.toContain("connectionId");
      expect(JSON.stringify(body)).not.toContain("token");
    }
    const uploadCall = fetcher.mock.calls.find(([url]) =>
      String(url).includes("/asana/attachments/upload"),
    );
    expect(
      new Headers(uploadCall?.[1]?.headers).get("x-opencloud-function-grant"),
    ).toBe("signed-integration-grant");
    await expect(response.json()).resolves.toMatchObject({
      tasks: { tasks: [{ id: "task-1" }] },
      downloaded: {
        data: expect.any(Object),
        name: "brief.txt",
        size: 15,
      },
      comment: { id: "story-1", text: "Ready to ship" },
    });
  });

  it("brokers typed bank account data without exposing provider credentials", async () => {
    const bindingId = "00000000-0000-4000-8000-000000000016";
    const fetcher = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      switch (body.operation) {
        case "bank.bindings.list":
          return Response.json({
            bindings: [{ id: bindingId, label: "Current account" }],
          });
        case "bank.account.get":
          return Response.json({
            currency: "GBP",
            displayName: "Current account",
          });
        case "bank.balances.list":
          return Response.json({
            balances: [{ amount: "42.50", currency: "GBP" }],
          });
        case "bank.transactions.list":
          return Response.json({
            transactions: [
              { id: "transaction-1", amount: "-10.25", currency: "GBP" },
            ],
            lastUpdatedAt: "2026-08-15T09:00:00Z",
            truncated: false,
          });
        default:
          throw new Error(`Unexpected operation ${body.operation}`);
      }
    });
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: async ({ integrations }) => {
        const bank = integrations.bankAccountData("bank");
        return {
          bindings: await bank.bindings(),
          account: await bank.account({ bindingId }),
          balances: await bank.balances({ bindingId }),
          transactions: await bank.listTransactions({
            bindingId,
            dateFrom: "2026-08-01",
            dateTo: "2026-08-15",
            limit: 100,
            includePending: false,
          }),
        };
      },
    });

    const response = await runtime.invoke();

    expect(response.status).toBe(200);
    const bodies = fetcher.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(bodies.map((body) => body.operation)).toEqual([
      "bank.bindings.list",
      "bank.account.get",
      "bank.balances.list",
      "bank.transactions.list",
    ]);
    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toContain("token");
      expect(JSON.stringify(body)).not.toContain("connectionId");
    }
    expect(bodies[3]).toMatchObject({
      integration: "bank",
      bindingId,
      input: {
        dateFrom: "2026-08-01",
        dateTo: "2026-08-15",
        limit: 100,
        includePending: false,
      },
    });
    await expect(response.json()).resolves.toMatchObject({
      account: { currency: "GBP" },
      balances: { balances: [{ amount: "42.50" }] },
      transactions: { transactions: [{ id: "transaction-1" }] },
    });
  });

  it("registers an expected Wise payment through the typed broker", async () => {
    const bindingId = "00000000-0000-4000-8000-000000000017";
    const fetcher = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.operation === "payments.bindings.list") {
        return Response.json({
          bindings: [{ id: bindingId, label: "Wise GBP" }],
        });
      }
      return Response.json({
        status: "pending",
        expectedPaymentId: "00000000-0000-4000-8000-000000000018",
        reference: body.input.reference,
        amount: body.input.amount,
        currency: body.input.currency,
        receivedAt: null,
        providerReference: null,
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: async ({ integrations }) => {
        const payments = integrations.receivedPayments("payments");
        return {
          bindings: await payments.bindings(),
          payment: await payments.reconcile({
            bindingId,
            paymentKey: "order-42",
            reference: "OC-42",
            amount: "49.00",
            currency: "GBP",
            receivedAfter: "2026-08-15T09:00:00.000Z",
            receivedBefore: "2026-08-22T09:00:00.000Z",
          }),
        };
      },
    });

    const response = await runtime.invoke();

    expect(response.status).toBe(200);
    const bodies = fetcher.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(bodies.map((body) => body.operation)).toEqual([
      "payments.bindings.list",
      "payments.received.reconcile",
    ]);
    expect(bodies[1]).toMatchObject({
      integration: "payments",
      bindingId,
      input: {
        paymentKey: "order-42",
        reference: "OC-42",
        amount: "49.00",
        currency: "GBP",
      },
    });
    expect(JSON.stringify(bodies)).not.toContain("connectionId");
    await expect(response.json()).resolves.toMatchObject({
      payment: { status: "pending", reference: "OC-42" },
    });
  });

  it("lists bounded outgoing Wise transfer events through the typed broker", async () => {
    const bindingId = "00000000-0000-4000-8000-000000000019";
    const fetcher = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.operation === "transfers.bindings.list") {
        return Response.json({
          bindings: [{ id: bindingId, label: "Wise GBP" }],
        });
      }
      return Response.json({
        events: [
          {
            id: "00000000-0000-4000-8000-000000000020",
            transferKey: "wise-3f90c97c56b35f91",
            previousState: "funds_converted",
            currentState: "outgoing_payment_sent",
            occurredAt: "2026-08-15T12:00:00.000Z",
          },
        ],
        issues: [
          {
            id: "00000000-0000-4000-8000-000000000021",
            transferKey: "wise-3f90c97c56b35f91",
            activeCases: ["recipient_not_verified"],
            observedAt: "2026-08-15T12:01:00.000Z",
          },
        ],
        truncated: false,
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: async ({ integrations }) => {
        const transfers = integrations.sentTransfers("payments");
        return {
          bindings: await transfers.bindings(),
          timeline: await transfers.listEvents({ bindingId, limit: 25 }),
        };
      },
    });

    const response = await runtime.invoke();

    expect(response.status).toBe(200);
    const bodies = fetcher.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(bodies.map((body) => body.operation)).toEqual([
      "transfers.bindings.list",
      "transfers.sent.list",
    ]);
    expect(bodies[1]).toMatchObject({
      integration: "payments",
      bindingId,
      input: { limit: 25 },
    });
    expect(JSON.stringify(bodies)).not.toContain("connectionId");
    await expect(response.json()).resolves.toMatchObject({
      timeline: {
        events: [
          {
            transferKey: "wise-3f90c97c56b35f91",
            currentState: "outgoing_payment_sent",
          },
        ],
        issues: [
          {
            transferKey: "wise-3f90c97c56b35f91",
            activeCases: ["recipient_not_verified"],
          },
        ],
      },
    });
  });

  it("lets secrets read only declared app bindings", async () => {
    const runtime = installRuntime("dev", {
      MAIL_API_TOKEN: "mail-secret",
      UNDECLARED_SECRET: "hidden",
    });
    defineFunction({
      input: schema.object({}),
      handler: ({ secrets }) => {
        let reservedCode: string | null = null;
        try {
          secrets.get("OPENCLOUD_FILES_GRANT");
        } catch (error) {
          reservedCode =
            error instanceof OpenCloudError ? error.code : "unknown";
        }
        return {
          declared: secrets.require("MAIL_API_TOKEN"),
          undeclared: secrets.get("UNDECLARED_SECRET") ?? null,
          reservedCode,
        };
      },
    });

    const response = await runtime.invoke();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      declared: "mail-secret",
      undeclared: null,
      reservedCode: "INVALID_SECRET_NAME",
    });
  });

  it("sends through the scoped OpenCloud email broker without provider credentials", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        id: "message-1",
        providerId: "42",
        status: "queued",
        from: "notifications@m.example.test",
        replyTo: null,
        idempotent: false,
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: ({ email }) =>
        email.send(
          { from: "notifications", to: "person@example.test", text: "Hello" },
          { idempotencyKey: "welcome-123" },
        ),
    });

    const response = await runtime.invoke();
    expect(response.status).toBe(200);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("http://control.test/_internal/email/send");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-opencloud-email-token")).toBe(
      "app-scoped-email-credential",
    );
    expect(headers.has("mailpace-server-token")).toBe(false);
    expect(headers.get("idempotency-key")).toBe("welcome-123");
    await expect(response.json()).resolves.toMatchObject({
      id: "message-1",
      status: "queued",
    });
  });

  it("sends visible Web Push through the scoped notification broker", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        id: "00000000-0000-4000-8000-000000000030",
        status: "queued",
        recipientCount: 1,
        acceptedCount: 0,
        failedCount: 0,
        idempotent: false,
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: ({ notifications }) =>
        notifications.send(
          {
            userId,
            title: "Appointment reminder",
            body: "Your visit starts in 30 minutes.",
            path: "/appointments/next",
            icon: "/icons/appointment.png",
          },
          { idempotencyKey: "appointment:next" },
        ),
    });

    const response = await runtime.invoke();
    expect(response.status).toBe(200);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://control.test/_internal/notifications/send",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("x-opencloud-notifications-token")).toBe(
      "app-scoped-notifications-credential",
    );
    expect(headers.get("idempotency-key")).toBe("appointment:next");
    expect(JSON.parse(String(init?.body))).toEqual({
      userId,
      title: "Appointment reminder",
      body: "Your visit starts in 30 minutes.",
      path: "/appointments/next",
      icon: "/icons/appointment.png",
    });
    await expect(response.json()).resolves.toMatchObject({
      status: "queued",
      recipientCount: 1,
    });
  });

  it("enqueues and reads background jobs through the scoped Function broker", async () => {
    const jobId = "00000000-0000-4000-8000-000000000020";
    const responseBody = {
      id: jobId,
      queue: "document-processing",
      state: "queued",
      attempt: 0,
      maxAttempts: 3,
      runAt: "2026-08-17T12:00:00.000Z",
      createdAt: "2026-08-17T12:00:00.000Z",
      startedAt: null,
      completedAt: null,
      lastError: null,
    };
    const fetcher = vi.fn(async (_url: URL | string, init?: RequestInit) =>
      Response.json({
        ...responseBody,
        ...(init?.method === "POST" ? { idempotent: false } : {}),
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: async ({ jobs }) => {
        const enqueued = await jobs.enqueue(
          "document-processing",
          { documentId: fileId },
          { idempotencyKey: "document:one", delaySeconds: 5 },
        );
        const status = await jobs.get(enqueued.id);
        return { enqueued, status };
      },
    });

    const response = await runtime.invoke(
      new Request("http://function.test", {
        headers: { "x-opencloud-user-id": userId },
      }),
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [enqueueUrl, enqueueInit] = fetcher.mock.calls[0]!;
    expect(String(enqueueUrl)).toBe("http://control.test/_internal/jobs/");
    const headers = new Headers(enqueueInit?.headers);
    expect(headers.get("x-opencloud-jobs-token")).toBe(
      "app-scoped-jobs-credential",
    );
    expect(headers.get("x-opencloud-function-name")).toBe("action");
    expect(headers.get("x-opencloud-user-id")).toBe(userId);
    expect(headers.get("idempotency-key")).toBe("document:one");
    expect(headers.has("x-opencloud-files-grant")).toBe(false);
    expect(JSON.parse(String(enqueueInit?.body))).toEqual({
      queue: "document-processing",
      input: { documentId: fileId },
      options: { delaySeconds: 5 },
    });
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      `http://control.test/_internal/jobs/${jobId}`,
    );
    await expect(response.json()).resolves.toMatchObject({
      enqueued: { id: jobId, state: "queued", idempotent: false },
      status: { id: jobId, state: "queued" },
    });
  });

  it("delegates canonical file selections only on enqueue", async () => {
    const fetcher = vi.fn(async (_url: URL | string, _init?: RequestInit) => Response.json({ id: fileId }));
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    const another = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    defineFunction({
      input: schema.object({}),
      handler: async ({ jobs }) => {
        await jobs.enqueue("document-processing", { fileId }, {
          idempotencyKey: "files:one", files: { read: [another.toUpperCase(), fileId, another] },
        });
        return jobs.get(fileId);
      },
    });
    const response = await runtime.invoke();
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const init = fetcher.mock.calls[0]![1];
    expect(new Headers(init?.headers).get("x-opencloud-files-grant")).toBe("signed-file-grant");
    expect(JSON.parse(String(init?.body))).toEqual({
      queue: "document-processing", input: { fileId },
      options: { delaySeconds: 0, files: { read: [fileId, another] } },
    });
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).has("x-opencloud-files-grant")).toBe(false);
  });

  it.each(["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"])("matches shared UUID structural validation for %s", async (id) => {
    const fetcher = vi.fn(async () => Response.json({ id: fileId }));
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({ input: schema.object({}), handler: ({ jobs }) => jobs.enqueue("document-processing", {}, { idempotencyKey: "files:uuid", files: { read: [id] } }) });
    expect((await runtime.invoke()).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { read: [] }, { read: ["bad"] }, { read: ["FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"] }, { read: Array(17).fill(fileId) }, { read: [fileId], write: [fileId] }])("rejects malformed delegated inputs before transport: %j", async (files) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: ({ jobs }) => {
        try {
          void jobs.enqueue("document-processing", {}, { idempotencyKey: "files:bad", files: files as { read: string[] } });
          return { code: "unexpected" };
        } catch (error) {
          return { code: error instanceof OpenCloudError ? error.code : "unexpected" };
        }
      },
    });
    await expect((await runtime.invoke()).json()).resolves.toEqual({ code: "FILE_DELEGATION_INVALID" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("exposes trusted queue invocation metadata and validates enqueue options", async () => {
    const runtime = installRuntime("dev", {
      OPENCLOUD_JOB_ID: "00000000-0000-4000-8000-000000000021",
      OPENCLOUD_JOB_QUEUE: "document-processing",
      OPENCLOUD_JOB_ATTEMPT: "2",
    });
    defineFunction({
      input: schema.object({}),
      handler: ({ job, jobs }) => {
        let invalidCode: string | null = null;
        try {
          void jobs.enqueue("Invalid Queue", {}, { idempotencyKey: "valid" });
        } catch (error) {
          invalidCode = error instanceof OpenCloudError ? error.code : null;
        }
        return { job, invalidCode };
      },
    });

    const response = await runtime.invoke();
    await expect(response.json()).resolves.toEqual({
      job: {
        id: "00000000-0000-4000-8000-000000000021",
        queue: "document-processing",
        attempt: 2,
      },
      invalidCode: "INVALID_QUEUE_NAME",
    });
  });

  it("turns failed platform calls into sanitized structured errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { message: "relation is unavailable", token: "secret" },
          { status: 503, headers: { "x-request-id": "upstream-id" } },
        ),
      ),
    );
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: ({ data }) => data.table("items").list(),
    });

    const response = await runtime.invoke();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PLATFORM_REQUEST_FAILED",
        message:
          "OpenCloud platform request failed (503): relation is unavailable",
        requestId: "upstream-id",
        retryable: true,
        details: { message: "relation is unavailable", token: "[redacted]" },
      },
    });
  });

  it("preserves explicit function errors", async () => {
    expect(Object.keys(errors)).toEqual([
      "badRequest",
      "unauthorized",
      "forbidden",
      "notFound",
      "conflict",
      "unavailable",
    ]);
    const runtime = installRuntime();
    defineFunction({
      input: schema.object({}),
      handler: () => {
        throw errors.conflict("OUT_OF_STOCK", "No seats remain", {
          remaining: 0,
        });
      },
    });

    const response = await runtime.invoke();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "OUT_OF_STOCK",
        message: "No seats remain",
        retryable: false,
        details: { remaining: 0 },
      },
    });
  });

  it("refuses to run when the materialized SDK and runtime disagree", async () => {
    const runtime = installRuntime("dev", { OPENCLOUD_SDK_VERSION: "0.2.0" });
    defineFunction({
      input: schema.object({}),
      handler: () => ({ unreachable: true }),
    });

    const response = await runtime.invoke();
    expect(response.status).toBe(500);
    expect(response.headers.get("x-opencloud-sdk-version")).toBe("2.9.0");
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "SDK_VERSION_MISMATCH",
        details: { expected: "2.9.0", received: "0.2.0" },
      },
    });
  });

  it("keeps unknown production errors generic", async () => {
    const runtime = installRuntime("production");
    defineFunction({
      input: schema.object({}),
      handler: () => {
        throw new Error("database password leaked");
      },
    });
    const response = await runtime.invoke();
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "FUNCTION_EXECUTION_FAILED",
        message: "Function execution failed",
      },
    });
  });

  it("exposes structured errors for programmatic handling", () => {
    const error = new OpenCloudError("failed", {
      code: "TEST_FAILURE",
      status: 502,
      requestId: "req",
    });
    expect(error).toMatchObject({
      code: "TEST_FAILURE",
      status: 502,
      requestId: "req",
      retryable: true,
    });
  });

  it("rejects the removed handler-only Function shape", () => {
    expect(() => defineFunction((() => ({ ok: true })) as never)).toThrow(
      "requires exactly { input: schema.*, handler",
    );
  });
});
