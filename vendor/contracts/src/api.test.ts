import { describe, expect, it } from "vitest";
import { deploymentStateSchema } from "./api.js";

describe("deployment state contract", () => {
  it("distinguishes superseded releases from explicit rollbacks", () => {
    expect(deploymentStateSchema.parse("superseded")).toBe("superseded");
    expect(deploymentStateSchema.parse("rolled_back")).toBe("rolled_back");
  });
});
