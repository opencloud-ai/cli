import { describe, expect, it } from "vitest";
import {
  OPEN_CLOUD_CLIENT_CAPABILITIES_HEADER,
  OPEN_CLOUD_DEV_SESSION_CAPABILITIES_V2,
  OpenCloudClient,
} from "./index.js";

describe("OpenCloudClient", () => {
  it("advertises support for negotiated development capabilities", async () => {
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
    expect(new Headers(init?.headers).get(OPEN_CLOUD_CLIENT_CAPABILITIES_HEADER))
      .toBe(OPEN_CLOUD_DEV_SESSION_CAPABILITIES_V2);
  });
});
