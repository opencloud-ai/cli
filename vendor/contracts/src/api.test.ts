import { describe, expect, it } from "vitest";
import {
  deploymentStateSchema,
  startAgentOnboardingRequestSchema,
} from "./api.js";

describe("deployment state contract", () => {
  it("distinguishes superseded releases from explicit rollbacks", () => {
    expect(deploymentStateSchema.parse("superseded")).toBe("superseded");
    expect(deploymentStateSchema.parse("rolled_back")).toBe("rolled_back");
  });
});

describe("agent onboarding contract", () => {
  it("normalizes email and defaults new projects to private", () => {
    expect(
      startAgentOnboardingRequestSchema.parse({
        email: " Person@Example.Test ",
        projectName: "Family tasks",
      }),
    ).toEqual({
      email: "person@example.test",
      projectName: "Family tasks",
      visibility: "private",
    });
  });
});
