import { describe, expect, it } from "vitest";
import {
  resolveAppIdentityActivationRequestSchema,
  resolveAppIdentityActivationResponseSchema,
} from "./api.js";

const request = {
  schemaVersion: 1 as const,
  userId: "11111111-1111-4111-8111-111111111111",
  appId: "22222222-2222-4222-8222-222222222222",
  rootRunId: "33333333-3333-4333-8333-333333333333",
  activationId: "55555555-5555-4555-8555-555555555555",
};

describe("agent app identity activation resolution contract", () => {
  it("accepts only the exact internal resolution selector", () => {
    expect(resolveAppIdentityActivationRequestSchema.parse(request)).toEqual(
      request,
    );
    expect(() =>
      resolveAppIdentityActivationRequestSchema.parse({
        ...request,
        displayName: "must not be accepted",
      }),
    ).toThrow();
    expect(() =>
      resolveAppIdentityActivationRequestSchema.parse({
        ...request,
        activationId: "not-a-uuid",
      }),
    ).toThrow();
  });

  it.each(["unassigned", "exact", "assigned_elsewhere"] as const)(
    "accepts the strict %s response without assignment provenance",
    (resolution) => {
      const response = {
        ...request,
        appState: "draft" as const,
        identityStatus:
          resolution === "unassigned"
            ? ("pending" as const)
            : ("assigned" as const),
        resolution,
      };

      expect(resolveAppIdentityActivationResponseSchema.parse(response)).toEqual(
        response,
      );
      expect(() =>
        resolveAppIdentityActivationResponseSchema.parse({
          ...response,
          assignedRootRunId: request.rootRunId,
        }),
      ).toThrow();
    },
  );
});
