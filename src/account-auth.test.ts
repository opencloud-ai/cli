import { describe, expect, it, vi } from "vitest";
import {
  beginDeviceAuthorization,
  completeDeviceAuthorization,
  DEVICE_AUTHORIZATION_GRANT,
} from "./account-auth.js";

describe("OpenCloud CLI device authorization", () => {
  it("discovers the authorization server from the selected API", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          resource: "https://api.opencloud.ai",
          authorization_servers: ["https://auth.opencloud.ai"],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          issuer: "https://auth.opencloud.ai",
          token_endpoint: "https://auth.opencloud.ai/oauth/token",
          device_authorization_endpoint:
            "https://auth.opencloud.ai/oauth/device/authorize",
          revocation_endpoint: "https://auth.opencloud.ai/oauth/revoke",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          device_code: `oc_device_${"d".repeat(43)}`,
          user_code: "browser-request-code",
          verification_uri: "https://auth.opencloud.ai/cli/authorize",
          verification_uri_complete:
            "https://auth.opencloud.ai/cli/authorize?request=browser-request-code",
          expires_in: 600,
          interval: 2,
        }),
      );

    const authorization = await beginDeviceAuthorization(
      "https://api.opencloud.ai/",
      request as typeof fetch,
    );

    expect(authorization).toMatchObject({
      apiUrl: "https://api.opencloud.ai",
      issuer: "https://auth.opencloud.ai",
      tokenEndpoint: "https://auth.opencloud.ai/oauth/token",
      intervalSeconds: 2,
    });
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "https://api.opencloud.ai/.well-known/oauth-protected-resource/api",
      "https://auth.opencloud.ai/.well-known/oauth-authorization-server",
      "https://auth.opencloud.ai/oauth/device/authorize",
    ]);
    const startBody = request.mock.calls[2]?.[1]?.body;
    expect(String(startBody)).toContain("client_id=opencloud-cli");
    expect(String(startBody)).toContain("cli%3Aaccount");
  });

  it("polls through authorization_pending and returns redacted credential data", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { code: "authorization_pending", message: "Waiting" },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "oc_cli_private-access",
          token_type: "Bearer",
          expires_in: 900,
          refresh_token: "oc_refresh_private-refresh",
          refresh_expires_in: 2_592_000,
          scope: "openid profile cli:account",
          resource: "https://api.opencloud.ai",
        }),
      );
    const wait = vi.fn().mockResolvedValue(undefined);

    const credential = await completeDeviceAuthorization(
      {
        apiUrl: "https://api.opencloud.ai",
        issuer: "https://auth.opencloud.ai",
        tokenEndpoint: "https://auth.opencloud.ai/oauth/token",
        revocationEndpoint: "https://auth.opencloud.ai/oauth/revoke",
        deviceCode: `oc_device_${"d".repeat(43)}`,
        verificationUri: "https://auth.opencloud.ai/cli/authorize",
        verificationUriComplete:
          "https://auth.opencloud.ai/cli/authorize?request=browser-request-code",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        intervalSeconds: 2,
      },
      request as typeof fetch,
      wait,
    );

    expect(wait).toHaveBeenCalledWith(2_000);
    expect(credential).toMatchObject({
      kind: "account",
      accessToken: "oc_cli_private-access",
      refreshToken: "oc_refresh_private-refresh",
    });
    const tokenBody = request.mock.calls[1]?.[1]?.body;
    expect(String(tokenBody)).toContain(
      `grant_type=${encodeURIComponent(DEVICE_AUTHORIZATION_GRANT)}`,
    );
  });
});
