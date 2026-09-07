import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { controlPlaneOperations } from "./control-plane.js";

const appId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const backupId = "44444444-4444-4444-8444-444444444444";
const deploymentId = "55555555-5555-4555-8555-555555555555";

describe("privileged dashboard operation contract", () => {
  it("defines bounded, scoped collection pages", () => {
    expect(
      controlPlaneOperations.listAppAccessPage.input.parse({
        appId,
        query: {},
      }),
    ).toEqual({ appId, query: { group: "admins", limit: 25 } });
    expect(
      controlPlaneOperations.listSecretsPage.input.parse({ appId, query: {} }),
    ).toEqual({ appId, query: { limit: 25 } });
    expect(
      controlPlaneOperations.listAppAccessTokensPage.input.parse({
        appId,
        query: {},
      }),
    ).toEqual({ appId, query: { limit: 25 } });

    for (const operation of [
      controlPlaneOperations.listAppAccessPage,
      controlPlaneOperations.listSecretsPage,
      controlPlaneOperations.listAppAccessTokensPage,
    ]) {
      expect(operation.queryKey).toBe("query");
      expect("mcp" in operation).toBe(false);
      expect(() =>
        operation.input.parse({ appId, query: { limit: 101 } }),
      ).toThrow();
    }

    const pageOutputs = [
      controlPlaneOperations.listAppAccessPage.output.parse({
        appId,
        group: "admins",
        asOf: "2026-09-01T10:00:00.000Z",
        people: [],
        counts: { admins: 1, users: 0 },
        nextCursor: null,
      }),
      controlPlaneOperations.listSecretsPage.output.parse({
        appId,
        asOf: "2026-09-01T10:00:00.000Z",
        activeDeploymentId: null,
        declarations: [],
        secrets: [],
        nextCursor: null,
      }),
      controlPlaneOperations.listAppAccessTokensPage.output.parse({
        appId,
        asOf: "2026-09-01T10:00:00.000Z",
        tokens: [],
        activeCount: 0,
        maxActiveTokens: 10,
        nextCursor: null,
      }),
    ];
    expect(pageOutputs.map((page) => page.appId)).toEqual([
      appId,
      appId,
      appId,
    ]);
    const pageOperations = [
      controlPlaneOperations.listAppAccessPage,
      controlPlaneOperations.listSecretsPage,
      controlPlaneOperations.listAppAccessTokensPage,
    ] as const;
    pageOutputs.forEach((page, index) => {
      const { appId: _appId, ...withoutAppId } = page;
      expect(() => pageOperations[index]!.output.parse(withoutAppId)).toThrow();
    });
  });

  it("keeps privileged actions out of MCP while supporting scoped owner API access", () => {
    const operations = [
      controlPlaneOperations.archiveApp,
      controlPlaneOperations.deleteApp,
      controlPlaneOperations.putSecret,
      controlPlaneOperations.addAppAccess,
      controlPlaneOperations.removeAppBuilder,
      controlPlaneOperations.removeAppUser,
      controlPlaneOperations.invokeCronOperation,
    ];

    for (const operation of operations) {
      expect("mcp" in operation).toBe(false);
    }
    expect(controlPlaneOperations.archiveApp.idempotency).toBe("required");
    expect(controlPlaneOperations.deleteApp.idempotency).toBe("required");
    expect(controlPlaneOperations.invokeCronOperation.idempotency).toBe(
      "required",
    );
    expect(controlPlaneOperations.putSecret.idempotency).toBe("required");
    expect(controlPlaneOperations.archiveApp.auth).toBe("bearer");
    expect(controlPlaneOperations.putSecret.auth).toBe("bearer");
    expect(controlPlaneOperations.putSecret.scopes).toEqual(["app:configure"]);
    expect(controlPlaneOperations.invokeCronOperation.auth).toBe("bearer");
    expect(
      controlPlaneOperations.invokeCronOperation.input.parse({
        appId,
        name: "nightly-import",
        body: { deploymentId },
      }),
    ).toEqual({
      appId,
      name: "nightly-import",
      body: { deploymentId },
    });
    expect(
      controlPlaneOperations.invokeCronOperation.input.parse({
        appId,
        name: "nightly-import",
      }),
    ).toEqual({ appId, name: "nightly-import" });
    expect(controlPlaneOperations.deleteApp.auth).toBe("user");
  });

  it("documents audience-specific access-token secret delivery", () => {
    const operation = controlPlaneOperations.createAppAccessToken;

    expect(operation.description).toContain(
      "owner API credentials with the correct control-plane audience",
    );
    expect(operation.description).toContain(
      "MCP-resource credentials must use reveal_link",
    );
    expect(
      operation.input.parse({
        appId,
        body: {
          name: "Browser importer",
          expiresInDays: 90,
          delivery: "response",
        },
      }),
    ).toMatchObject({ body: { delivery: "response" } });
    expect(
      operation.input.parse({
        appId,
        body: {
          name: "MCP importer",
          expiresInDays: 90,
          delivery: "reveal_link",
        },
      }),
    ).toMatchObject({ body: { delivery: "reveal_link" } });
  });

  it("publishes idempotent secret entry for owner API and browser sessions", () => {
    const openApi = readFileSync(
      new URL("../../../docs/openapi/control-plane.yaml", import.meta.url),
      "utf8",
    );
    const routeStart = openApi.indexOf("  /v1/apps/{appId}/secrets/{name}:\n");
    const routeEnd = openApi.indexOf("\n  /v1/", routeStart + 1);

    expect(routeStart).toBeGreaterThanOrEqual(0);
    const route = openApi.slice(
      routeStart,
      routeEnd === -1 ? undefined : routeEnd,
    );
    const putStart = route.indexOf("\n    put:\n");
    const deleteStart = route.indexOf("\n    delete:\n", putStart + 1);
    expect(putStart).toBeGreaterThanOrEqual(0);
    expect(deleteStart).toBeGreaterThan(putStart);
    const putOperation = route.slice(putStart, deleteStart);
    expect(putOperation).toContain("operationId: putSecret");
    expect(putOperation).toContain("security:\n        - bearerAuth: []\n        - browserSession: []");
    expect(putOperation).toContain("name: Idempotency-Key\n          in: header\n          required: true");
  });

  it("types exact backup and access mutation routes", () => {
    expect(controlPlaneOperations.getBackup).toMatchObject({
      method: "GET",
      path: "/v1/apps/{appId}/backups/{backupId}",
    });
    expect(
      controlPlaneOperations.getBackup.input.parse({ appId, backupId }),
    ).toEqual({ appId, backupId });
    expect(
      controlPlaneOperations.addAppAccess.input.parse({
        appId,
        body: { email: "Builder@Example.test", role: "builder" },
      }),
    ).toEqual({
      appId,
      body: { email: "builder@example.test", role: "builder" },
    });
    expect(
      controlPlaneOperations.removeAppBuilder.input.parse({ appId, userId }),
    ).toEqual({ appId, userId });
    expect(
      controlPlaneOperations.removeAppUser.input.parse({ appId, userId }),
    ).toEqual({ appId, userId });
  });

  it("accepts a secret on input but never exposes it on output", () => {
    expect(
      controlPlaneOperations.putSecret.input.parse({
        appId,
        name: "DATABASE_TOKEN",
        body: { value: "sentinel-plaintext" },
      }),
    ).toMatchObject({ name: "DATABASE_TOKEN" });
    expect(
      controlPlaneOperations.putSecret.output.parse({
        name: "DATABASE_TOKEN",
        stored: true,
      }),
    ).toEqual({ name: "DATABASE_TOKEN", stored: true });
    expect(() =>
      controlPlaneOperations.putSecret.output.parse({
        name: "DATABASE_TOKEN",
        stored: true,
        value: "sentinel-plaintext",
      }),
    ).not.toThrow();
    expect(
      "value" in
        controlPlaneOperations.putSecret.output.parse({
          name: "DATABASE_TOKEN",
          stored: true,
          value: "sentinel-plaintext",
        }),
    ).toBe(false);
  });

  it("bounds active-release declaration status without exposing values", () => {
    const output = controlPlaneOperations.listSecretsPage.output.parse({
      appId,
      asOf: "2026-09-01T10:00:00.000Z",
      activeDeploymentId: "55555555-5555-4555-8555-555555555555",
      declarations: [
        {
          name: "DATABASE_TOKEN",
          mode: "required",
          configured: true,
          updatedAt: "2026-09-01T09:00:00.000Z",
          value: "sentinel-plaintext",
        },
      ],
      secrets: [
        {
          name: "DATABASE_TOKEN",
          createdAt: "2026-09-01T08:00:00.000Z",
          updatedAt: "2026-09-01T09:00:00.000Z",
          encryptedValue: "sentinel-encrypted-value",
          value: "sentinel-plaintext",
        },
      ],
      nextCursor: null,
    });

    expect(output.declarations).toEqual([
      {
        name: "DATABASE_TOKEN",
        mode: "required",
        configured: true,
        updatedAt: "2026-09-01T09:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(output)).not.toContain("sentinel-plaintext");
    expect(JSON.stringify(output)).not.toContain("sentinel-encrypted-value");
    expect(() =>
      controlPlaneOperations.listSecretsPage.output.parse({
        ...output,
        declarations: Array.from({ length: 101 }, (_, index) => ({
          name: `SECRET_${index}`,
          mode: "optional",
          configured: false,
          updatedAt: null,
        })),
      }),
    ).toThrow();
  });
});
