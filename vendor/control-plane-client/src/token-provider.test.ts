import { describe, expect, it, vi } from "vitest";
import { OpenCloudClient } from "./index.js";

describe("OpenCloudClient tokenProvider", () => {
  it("resolves a refreshed credential immediately before each request", async () => {
    const tokenProvider = vi
      .fn()
      .mockResolvedValueOnce("oc_agent_first")
      .mockResolvedValueOnce("oc_agent_second");
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return Response.json({
        authorization: new Headers(init?.headers).get("authorization"),
      });
    });
    const client = new OpenCloudClient({
      apiUrl: "https://api.opencloud.ai",
      tokenProvider,
      fetch: request as typeof fetch,
    });

    await expect(client.get("/first")).resolves.toEqual({
      authorization: "Bearer oc_agent_first",
    });
    await expect(client.get("/second")).resolves.toEqual({
      authorization: "Bearer oc_agent_second",
    });
    expect(tokenProvider).toHaveBeenCalledTimes(2);
  });
});
