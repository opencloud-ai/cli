import { describe, expect, it } from "vitest";
import { accountOrganisationContextSchema } from "./organisation-directory.js";
import { controlPlaneOperations } from "./control-plane.js";

describe("single organisation account contract", () => {
  it("exposes a user-only read without scopes or mutation intent", () => {
    const operation = controlPlaneOperations.getAccountOrganisationContext;
    expect(operation).toMatchObject({ method: "GET", path: "/v1/account/organisation", auth: "user", scopes: [], idempotency: "none" });
  });
  it("keeps inactive context minimal and distinguishes no assignment", () => {
    expect(accountOrganisationContextSchema.parse({ state: "onboarding_required", organisation: null })).toEqual({ state: "onboarding_required", organisation: null });
    for (const state of ["removed", "suspended"]) {
      const value = { state, organisation: { id: "11111111-1111-4111-8111-111111111111", name: "Example" } };
      expect(accountOrganisationContextSchema.safeParse(value).success).toBe(true);
      expect(accountOrganisationContextSchema.safeParse({ ...value, workspaces: [] }).success).toBe(false);
      expect(accountOrganisationContextSchema.safeParse({ ...value, organisation: null }).success).toBe(false);
    }
  });
});
