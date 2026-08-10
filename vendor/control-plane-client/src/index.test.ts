import { describe, expect, it } from "vitest";
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
    expect(new Headers(init?.headers).has("x-opencloud-client-capabilities"))
      .toBe(false);
  });
});
