import { describe, expect, it } from "vitest";
import { assignAppIdentityResponseSchema } from "./control-plane.js";

describe("agent app identity response contract", () => {
  it("returns the existing bounded app envelope for both assignment schemas", () => {
    const response = {
      schemaVersion: 1,
      app: {
        id: "22222222-2222-4222-8222-222222222222",
        identityStatus: "assigned",
        name: "Garden Ledger",
        slug: "garden-ledger-a1b2c3",
        appUrl: "https://garden-ledger-a1b2c3.example.test",
        authUrl: "https://auth.example.test",
        apiUrl: "https://api.example.test",
        visibility: "private",
        aiCredentialSource: "owner",
        state: "draft",
        backupSchedule: "none",
        ownerUserId: "11111111-1111-4111-8111-111111111111",
        desiredDeploymentId: null,
        activeDeploymentId: null,
        createdAt: "2026-09-02T12:00:00.000Z",
        updatedAt: "2026-09-02T12:00:01.000Z",
      },
    };

    expect(assignAppIdentityResponseSchema.parse(response)).toEqual(response);
    expect(() =>
      assignAppIdentityResponseSchema.parse({
        ...response,
        activationId: "55555555-5555-4555-8555-555555555555",
      }),
    ).toThrow();
  });
});
