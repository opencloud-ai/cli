import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slowResponseFetch } from "./slow-response-fetch.js";

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("slow response fetch", () => {
  it("sends a JSON POST over node:http, not global fetch, and returns its response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("global fetch caps headers at 300 seconds"); }));
    const seen: Array<{ method?: string; url?: string; headers: Record<string, unknown>; body: string }> = [];
    const origin = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        seen.push({ method: request.method, url: request.url, headers: request.headers, body });
        response.writeHead(201, { "content-type": "application/json", "x-request-id": "request-1" });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    const response = await slowResponseFetch(`${origin}/v1/apps/a/drafts/d/validate`, {
      method: "POST",
      headers: new Headers({ authorization: "Bearer synthetic", "content-type": "application/json", "idempotency-key": "key-1" }),
      body: "{}",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-request-id")).toBe("request-1");
    expect(await response.json()).toEqual({ ok: true });
    expect(seen).toEqual([expect.objectContaining({
      method: "POST", url: "/v1/apps/a/drafts/d/validate", body: "{}",
      headers: expect.objectContaining({ authorization: "Bearer synthetic", "idempotency-key": "key-1", "content-length": "2" }),
    })]);
  });

  it("leaves other requests to global fetch", async () => {
    const global = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", global);
    await slowResponseFetch("http://127.0.0.1:9/v1/apps", { method: "GET" });
    await slowResponseFetch("http://127.0.0.1:9/v1/apps/a/files", { method: "POST", body: new FormData() });
    expect(global).toHaveBeenCalledTimes(2);
  });

  it("rejects like fetch when aborted or when the connection drops", async () => {
    const origin = await listen((request) => {
      if (request.url === "/drop") request.socket.destroy();
      // "/slow" never answers.
    });
    const controller = new AbortController();
    const reason = new Error("The request timed out after 50ms");
    setTimeout(() => controller.abort(reason), 50);
    await expect(slowResponseFetch(`${origin}/slow`, { method: "POST", body: "{}", signal: controller.signal }))
      .rejects.toBe(reason);
    await expect(slowResponseFetch(`${origin}/drop`, { method: "POST", body: "{}" }))
      .rejects.toMatchObject({ name: "TypeError", message: "fetch failed" });
  });
});
