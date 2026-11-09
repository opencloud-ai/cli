import { mkdtemp, writeFile, rm, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { OpenCloudClient } from "./api-client.js";

it("preserves authenticated binary downloads and streamed file uploads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-transfers-"));
  const bytes = new Uint8Array([0, 255, 128, 13]);
  try {
    await writeFile(path.join(root, "file.bin"), bytes);
    const calls: RequestInit[] = [];
    const client = new OpenCloudClient({ apiUrl: "https://api.example.test/", tokenProvider: async () => "synthetic",
      fetch: async (url, init) => {
        expect(String(url)).toBe("https://api.example.test/file");
        calls.push(init!);
        expect(new Headers(init!.headers).get("authorization")).toBe("Bearer synthetic");
        if (init!.method === "GET") return new Response(bytes);
        expect(new Uint8Array(await new Response(init!.body).arrayBuffer())).toEqual(bytes);
        return Response.json({ uploaded: true });
      },
    });
    expect(new Uint8Array(await (await client.download("/file")).arrayBuffer())).toEqual(bytes);
    expect(await client.uploadFile("PUT", "/file", path.join(root, "file.bin"), { contentType: "application/octet-stream", idempotencyKey: "stable" })).toEqual({ uploaded: true });
    expect(new Headers(calls[1]!.headers).get("idempotency-key")).toBe("stable");
    expect(new Headers(calls[1]!.headers).get("content-length")).toBe("4");
    await expect(client.uploadFile("PUT", "/file", root)).rejects.toThrow("must be a file");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("streams a 160 MiB upload without concatenating the body or using fetch's header deadline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-package-stream-"));
  const filename = path.join(root, "app.zip");
  const bytes = 160 * 1024 * 1024;
  const file = await open(filename, "wx", 0o600);
  await file.truncate(bytes); await file.close();
  let received = 0;
  const server = createServer(async (request, response) => {
    expect(request.headers["content-length"]).toBe(String(bytes));
    expect(request.headers["idempotency-key"]).toBe("stream-package-001");
    const digest = createHash("sha256");
    for await (const chunk of request) { received += chunk.length; digest.update(chunk); }
    response.end(JSON.stringify({ bytes: received, sha256: digest.digest("hex") }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const concat = Buffer.concat;
  const spy = vi.spyOn(Buffer, "concat").mockImplementation((list, length) => {
    if ((length ?? list.reduce((sum, item) => sum + item.length, 0)) >= 1024 * 1024) throw new Error("Whole upload buffered");
    return concat(list, length);
  });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Global fetch header deadline used"); }));
  try {
    const client = new OpenCloudClient({ apiUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "synthetic" });
    expect(await client.uploadFile("POST", "/v1/app-imports", filename, { contentType: "application/zip", idempotencyKey: "stream-package-001" }))
      .toMatchObject({ bytes, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(received).toBe(bytes);
  } finally {
    spy.mockRestore(); vi.unstubAllGlobals();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
