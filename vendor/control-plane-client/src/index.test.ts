import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCloudClient } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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
    expect(
      new Headers(init?.headers).has("x-opencloud-client-capabilities"),
    ).toBe(false);
  });

  it("can require revalidation for the platform compatibility marker", async () => {
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

  it("streams owner File uploads with bounded metadata", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "opencloud-client-upload-test-"),
    );
    temporaryDirectories.push(directory);
    const source = path.join(directory, "upload.bin");
    await writeFile(source, Buffer.from([0, 1, 2, 3, 255]));
    let requestUrl = "";
    let requestInit: (RequestInit & { duplex?: string }) | undefined;
    let body = Buffer.alloc(0);
    const client = new OpenCloudClient({
      apiUrl: "https://api.opencloud.ai",
      token: "test-token",
      fetch: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        const chunks: Buffer[] = [];
        const stream = init?.body as ReadableStream<Uint8Array>;
        for await (const chunk of Readable.fromWeb(stream)) {
          chunks.push(Buffer.from(chunk));
        }
        body = Buffer.concat(chunks);
        return Response.json({ id: "operation-1", state: "queued" });
      },
    });

    await expect(
      client.uploadFile("POST", "/v1/apps/app-1/files?name=input.bin", source, {
        contentType: "application/x-test",
        idempotencyKey: "stable-key-1",
      }),
    ).resolves.toEqual({ id: "operation-1", state: "queued" });
    expect(requestUrl).toBe(
      "https://api.opencloud.ai/v1/apps/app-1/files?name=input.bin",
    );
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.duplex).toBe("half");
    expect(new Headers(requestInit?.headers)).toMatchObject({});
    expect(new Headers(requestInit?.headers).get("content-length")).toBe("5");
    expect(new Headers(requestInit?.headers).get("content-type")).toBe(
      "application/x-test",
    );
    expect(new Headers(requestInit?.headers).get("idempotency-key")).toBe(
      "stable-key-1",
    );
    expect(body).toEqual(Buffer.from([0, 1, 2, 3, 255]));
  });

  it("returns an unread streaming response for owner File downloads", async () => {
    let requested = "";
    const client = new OpenCloudClient({
      apiUrl: "https://api.opencloud.ai/",
      token: "test-token",
      fetch: async (input) => {
        requested = String(input);
        return new Response("download-body", {
          headers: { "content-type": "application/octet-stream" },
        });
      },
    });

    const response = await client.download(
      "/v1/apps/app-1/files/file-1/content",
    );
    expect(requested).toBe(
      "https://api.opencloud.ai/v1/apps/app-1/files/file-1/content",
    );
    expect(response.bodyUsed).toBe(false);
    await expect(response.text()).resolves.toBe("download-body");
  });
});
