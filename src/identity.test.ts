import { describe, expect, it, vi } from "vitest";
import { ApiError, type OpenCloudClient } from "./api-client.js";
import { IDENTITY_UNSUPPORTED, readIdentity, signedInUser } from "./identity.js";

const identity = {
  user: {
    id: "60f07c58-ffa8-4442-acfa-1ec738466c45",
    email: "ada@example.com",
    displayName: "Ada Lovelace",
  },
  credential: {
    kind: "account_login" as const,
    appId: null,
    expiresAt: "2026-10-21T12:15:00.000Z",
  },
};

function control(call: () => Promise<unknown>): OpenCloudClient {
  return { call: vi.fn(call) } as unknown as OpenCloudClient;
}

describe("signed-in identity", () => {
  it("reads the person behind the credential", async () => {
    const client = control(async () => identity);

    await expect(readIdentity(client)).resolves.toEqual(identity);
    expect(client.call).toHaveBeenCalledWith("getCurrentIdentity", {});
    await expect(signedInUser(client)).resolves.toEqual({ user: identity.user });
  });

  it("treats a missing endpoint as an installation that predates identities", async () => {
    const client = control(async () => {
      throw new ApiError(404, { message: "Cannot GET /v1/auth/identity" });
    });

    await expect(readIdentity(client)).resolves.toBeNull();
    await expect(signedInUser(client)).resolves.toEqual({
      user: null,
      userUnavailable: IDENTITY_UNSUPPORTED,
    });
  });

  it("keeps other failures visible without failing the caller", async () => {
    const client = control(async () => {
      throw new ApiError(401, { message: "Invalid API credential" });
    });

    await expect(readIdentity(client)).rejects.toThrow("Invalid API credential");
    await expect(signedInUser(client)).resolves.toEqual({
      user: null,
      userUnavailable: expect.stringContaining("Invalid API credential"),
    });
  });
});
