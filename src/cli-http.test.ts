import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginDeviceAuthorization } from "./account-auth.js";
import { OpenCloudClient } from "./api-client.js";
import {
  cliUserAgent,
  lastUsedApiUrl,
  requestIdForError,
  resetApiUsage,
  setCliVersion,
  usedApiCredential,
  withCliHeaders,
} from "./cli-http.js";
import { doctorDiagnostics } from "./doctor.js";

const REQUEST_ID = /^cli-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  resetApiUsage();
  setCliVersion("0.0.0");
});

function recordingFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const calls: Array<{ url: string; headers: Headers; init: RequestInit }> = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init.headers), init });
    return respond(url, init);
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("CLI request headers", () => {
  it("names the CLI, its platform and runtime in the user-agent", () => {
    setCliVersion("3.16.0");
    expect(cliUserAgent()).toBe(
      `opencloud-cli/3.16.0 (${process.platform} ${process.arch}; node ${process.versions.node})`,
    );
  });

  it("adds a user-agent and a fresh x-request-id unless the caller set them", async () => {
    setCliVersion("3.16.0");
    const { calls, fetcher } = recordingFetch();
    const send = withCliHeaders(fetcher);
    await send("https://api.example.test/v1/apps");
    await send("https://api.example.test/v1/apps");
    await send("https://api.example.test/v1/apps", {
      headers: { "user-agent": "custom/1", "x-request-id": "caller-chosen" },
    });
    expect(calls[0]!.headers.get("user-agent")).toBe(cliUserAgent());
    expect(calls[0]!.headers.get("x-request-id")).toMatch(REQUEST_ID);
    expect(calls[1]!.headers.get("x-request-id")).not.toBe(
      calls[0]!.headers.get("x-request-id"),
    );
    expect(calls[2]!.headers.get("user-agent")).toBe("custom/1");
    expect(calls[2]!.headers.get("x-request-id")).toBe("caller-chosen");
  });

  it("sends both headers on API client JSON calls, downloads and uploads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cli-http-"));
    try {
      const upload = path.join(root, "upload.txt");
      await writeFile(upload, "bytes");
      const { calls, fetcher } = recordingFetch((url) =>
        url.endsWith("/file") ? new Response("downloaded") : Response.json({ ok: true }),
      );
      const client = new OpenCloudClient({
        apiUrl: "https://api.example.test",
        token: "synthetic-token",
        fetch: fetcher,
      });
      await client.get("/v1/apps");
      await client.post("/v1/apps/one/restart", { reason: "test" });
      await client.download("/file");
      await client.uploadFile("PUT", "/upload", upload);
      expect(calls).toHaveLength(4);
      for (const call of calls) {
        expect(call.headers.get("user-agent")).toMatch(/^opencloud-cli\//);
        expect(call.headers.get("x-request-id")).toMatch(REQUEST_ID);
        expect(call.headers.get("authorization")).toBe("Bearer synthetic-token");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sends both headers on the doctor probe and login discovery", async () => {
    const { calls, fetcher } = recordingFetch((url) =>
      url.endsWith("/oauth-protected-resource/api")
        ? Response.json({ resource: "https://other.example.test", authorization_servers: ["https://auth.example.test"] })
        : Response.json({ version: "test" }),
    );
    await doctorDiagnostics(
      {
        apiUrl: "https://api.example.test",
        token: null,
        cliVersion: "3.16.0",
        currentDirectory: "/work",
        sessionFile: "/work/.opencloud/session.json",
        identitySource: "none",
        sessionState: null,
        appId: null,
        credentialExpiresAt: null,
      },
      fetcher,
    );
    await expect(beginDeviceAuthorization("https://api.example.test", fetcher)).rejects.toThrow(
      "invalid API authorization metadata",
    );
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.example.test/version",
      "https://api.example.test/.well-known/oauth-protected-resource/api",
    ]);
    for (const call of calls) {
      expect(call.headers.get("user-agent")).toMatch(/^opencloud-cli\//);
      expect(call.headers.get("x-request-id")).toMatch(REQUEST_ID);
    }
  });

  it("lets an error answer without x-request-id quote the request's ID", async () => {
    const { calls, fetcher } = recordingFetch((url) =>
      url.endsWith("/echo")
        ? Response.json({ message: "down" }, { status: 502, headers: { "x-request-id": "server-id" } })
        : new Response("<html>Bad gateway</html>", { status: 502 }),
    );
    const client = new OpenCloudClient({ apiUrl: "https://api.example.test", fetch: fetcher });
    const proxied = await client.get("/v1/apps").catch((error: unknown) => error);
    expect(proxied).toMatchObject({
      status: 502,
      requestId: calls[0]!.headers.get("x-request-id"),
    });
    const echoed = await client.get("/echo").catch((error: unknown) => error);
    expect(echoed).toMatchObject({ status: 502, requestId: "server-id" });
  });

  it("remembers the request ID of a request that got no answer", async () => {
    const failure = new TypeError("fetch failed");
    const { calls, fetcher } = recordingFetch(() => {
      throw failure;
    });
    await expect(withCliHeaders(fetcher)("https://api.example.test/v1/apps")).rejects.toBe(failure);
    expect(requestIdForError(failure)).toBe(calls[0]!.headers.get("x-request-id"));
    expect(requestIdForError(new Error("unrelated"))).toBeNull();
  });

  it("remembers the API and credential a client used, only for that origin", async () => {
    const { fetcher } = recordingFetch();
    expect(lastUsedApiUrl()).toBeNull();
    await new OpenCloudClient({
      apiUrl: "https://api.example.test/",
      token: "used-token",
      fetch: fetcher,
    }).get("/v1/apps");
    expect(lastUsedApiUrl()).toBe("https://api.example.test");
    expect(usedApiCredential("https://api.example.test")).toBe("used-token");
    expect(usedApiCredential("https://API.example.test/")).toBe("used-token");
    expect(usedApiCredential("https://other.example.test")).toBeNull();
    expect(usedApiCredential("http://api.example.test")).toBeNull();

    // A request elsewhere through the same client is never attributed to it.
    await withCliHeaders(fetcher, { apiUrl: "https://api.example.test" })(
      "https://elsewhere.example.test/x",
      { headers: { authorization: "Bearer foreign-token" } },
    );
    expect(usedApiCredential("https://api.example.test")).toBe("used-token");
  });
});
