import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
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
