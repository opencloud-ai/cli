import { describe, expect, it } from "vitest";
import {
  aiModelsFlagConflicts,
  aiModelsFlagInputSchema,
  aiModelsFlagValueSchema,
  platformFeatureFlagKeys,
  platformFeatureFlags,
  platformFeatureFlagValues,
  platformJsonFeatureFlagValue,
  resolvePlatformFeatureFlag,
  resolvePlatformJsonFeatureFlag,
  usdPerMillionToNanodollars,
} from "./feature-flags.js";
import { platformAdminOperations } from "./platform-admin.js";

describe("platform feature flags", () => {
  it("turns ChatGPT and Claude sign-in on by default", () => {
    expect(platformFeatureFlagKeys).toEqual(["chatgpt-sign-in", "claude-sign-in", "container-compute"]);
    for (const key of ["chatgpt-sign-in", "claude-sign-in"] as const) {
      expect(platformFeatureFlags[key].defaultEnabled).toBe(true);
      expect(resolvePlatformFeatureFlag(key, {})).toEqual({ enabled: true, source: "default" });
    }
  });

  it("lets the most specific setting win: person, organisation, everyone", () => {
    const key = "claude-sign-in";
    expect(resolvePlatformFeatureFlag(key, { installation: false })).toEqual({ enabled: false, source: "installation" });
    expect(resolvePlatformFeatureFlag(key, { installation: false, organisation: true })).toEqual({ enabled: true, source: "organisation" });
    expect(resolvePlatformFeatureFlag(key, { installation: true, organisation: true, user: false })).toEqual({ enabled: false, source: "user" });
  });

  it("fills missing evaluated values with defaults and ignores unknown keys", () => {
    expect(platformFeatureFlagValues({ "claude-sign-in": false, "future-flag": false })).toEqual({
      "chatgpt-sign-in": true,
      "claude-sign-in": false,
      "container-compute": false,
    });
  });

  it("requires exactly the subject a setting's scope names", () => {
    const input = platformAdminOperations.setFeatureFlag.input;
    const organisationId = "11111111-1111-4111-8111-111111111111";
    expect(input.safeParse({ flagKey: "chatgpt-sign-in", scope: "installation", enabled: false }).success).toBe(true);
    expect(input.safeParse({ flagKey: "chatgpt-sign-in", scope: "installation", enabled: null }).success).toBe(true);
    expect(input.safeParse({ flagKey: "chatgpt-sign-in", scope: "user", user: "ann@example.test", enabled: true }).success).toBe(true);
    expect(input.safeParse({ flagKey: "chatgpt-sign-in", scope: "organisation", organisationId, enabled: true }).success).toBe(true);
    for (const invalid of [
      { flagKey: "chatgpt-sign-in", scope: "installation", user: "ann@example.test", enabled: true },
      { flagKey: "chatgpt-sign-in", scope: "user", enabled: true },
      { flagKey: "chatgpt-sign-in", scope: "user", user: "ann@example.test", organisationId, enabled: true },
      { flagKey: "chatgpt-sign-in", scope: "organisation", user: "ann@example.test", enabled: true },
      { flagKey: "unknown", scope: "installation", enabled: true },
      { flagKey: "chatgpt-sign-in", scope: "installation" },
    ]) {
      expect(input.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    }
  });

  it("refuses a value on an on/off flag and requires one on a JSON flag", () => {
    const input = platformAdminOperations.setFeatureFlag.input;
    expect(input.safeParse({ flagKey: "chatgpt-sign-in", scope: "installation", value: { models: [] } }).success).toBe(false);
    expect(input.safeParse({ flagKey: "ai-models", scope: "installation", enabled: true }).success).toBe(false);
    expect(input.safeParse({ flagKey: "ai-models", scope: "installation" }).success).toBe(false);
    expect(input.safeParse({ flagKey: "ai-models", scope: "installation", value: null }).success).toBe(true);
    expect(input.safeParse({ flagKey: "ai-models", scope: "user", user: "ann@example.test", value: { models: [sol] } }).success).toBe(true);
    const invalid = input.safeParse({ flagKey: "ai-models", scope: "installation", value: { models: [{ ...sol, usdPerMillionTokens: { ...sol.usdPerMillionTokens, output: -1 } }] } });
    expect(invalid.success).toBe(false);
    expect(invalid.error?.issues[0]?.path).toEqual(["value", "models", 0, "usdPerMillionTokens", "output"]);
  });
});

const sol = {
  provider: "openai",
  model: "gpt-6.1-sol",
  name: "GPT-6.1 Sol",
  usdPerMillionTokens: { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 },
  contextTokens: 1_050_000,
} as const;
const terra = {
  provider: "openai",
  model: "gpt-6.1-terra",
  name: "GPT-6.1 Terra",
  usdPerMillionTokens: { input: 1, cachedInput: 0.05, cacheWrite: 1.25, output: 5 },
} as const;

describe("the AI models flag", () => {
  it("takes a model's ID, name and four prices", () => {
    expect(aiModelsFlagInputSchema.safeParse({ models: [sol, terra] }).success).toBe(true);
    for (const invalid of [
      { models: [{ ...sol, model: "GPT-6.1-Sol" }] },
      { models: [{ ...sol, model: "openai/gpt-6.1-sol" }] },
      { models: [{ ...sol, provider: "openrouter" }] },
      { models: [{ ...sol, usdPerMillionTokens: { input: 2, cachedInput: 0.1, output: 10 } }] },
      { models: [{ ...sol, usdPerMillionTokens: { ...sol.usdPerMillionTokens, input: 0.0000000001 } }] },
      // Budgets can't limit a free model.
      { models: [{ ...sol, usdPerMillionTokens: { ...sol.usdPerMillionTokens, output: 0 } }] },
      { models: [{ ...sol, colour: "blue" }] },
      { models: [sol, { ...sol, name: "Again" }] },
      { models: Array.from({ length: 201 }, (_, index) => ({ ...sol, model: `gpt-test-${index}` })) },
    ]) {
      expect(aiModelsFlagInputSchema.safeParse(invalid).success, JSON.stringify(invalid).slice(0, 200)).toBe(false);
    }
  });

  it("reads a stored value leniently, so a later release's fields survive a rollback", () => {
    expect(aiModelsFlagValueSchema.parse({ models: [{ ...sol, colour: "blue" }], note: "later" })).toEqual({ models: [sol] });
    // One person's combined value may hold more models than one setting may.
    const many = Array.from({ length: 250 }, (_, index) => ({ ...sol, model: `gpt-test-${index}` }));
    expect(aiModelsFlagValueSchema.safeParse({ models: many }).success).toBe(true);
    expect(aiModelsFlagValueSchema.safeParse({ models: [{ ...sol, provider: "openrouter" }] }).success).toBe(false);
  });

  it("names the models two settings give different values", () => {
    expect(aiModelsFlagConflicts({ models: [sol, terra] }, { models: [sol] })).toEqual([]);
    expect(aiModelsFlagConflicts({ models: [sol, terra] }, { models: [{ ...terra, name: "Terra preview" }] })).toEqual([terra]);
    expect(aiModelsFlagConflicts({ models: [sol] }, { models: [{ ...sol, usdPerMillionTokens: { ...sol.usdPerMillionTokens, cachedInput: 0.2 } }] }))
      .toEqual([sol]);
    expect(aiModelsFlagConflicts({ models: [sol] }, { models: [{ ...sol, contextTokens: undefined }] })).toEqual([sol]);
    expect(aiModelsFlagConflicts({ models: [terra] }, { models: [{ ...terra, contextTokens: undefined }] })).toEqual([]);
  });

  it("refuses built-in models when saved but still reads them", () => {
    const astra = { ...sol, model: "gpt-6-astra", name: "GPT-6 Astra" };
    const saved = aiModelsFlagInputSchema.safeParse({ models: [astra] });
    expect(saved.success).toBe(false);
    expect(saved.error?.issues[0]?.message).toContain("GPT-6 Astra is built in already");
    expect(aiModelsFlagValueSchema.safeParse({ models: [astra] }).success).toBe(true);
  });

  it("adds a narrower setting's models to everyone's list, keeping the broader entry for a model in both", () => {
    const cheaperSol = { ...sol, usdPerMillionTokens: { ...sol.usdPerMillionTokens, input: 1 } };
    expect(resolvePlatformJsonFeatureFlag("ai-models", {})).toEqual({ value: { models: [] }, source: "default" });
    expect(resolvePlatformJsonFeatureFlag("ai-models", { installation: { models: [sol] }, user: { models: [terra] } }))
      .toEqual({ value: { models: [sol, terra] }, source: "user" });
    expect(resolvePlatformJsonFeatureFlag("ai-models", {
      installation: { models: [sol] },
      organisation: { models: [terra] },
      user: { models: [cheaperSol] },
    })).toEqual({ value: { models: [sol, terra] }, source: "user" });
    expect(resolvePlatformJsonFeatureFlag("ai-models", { organisation: { models: [terra] } }))
      .toEqual({ value: { models: [terra] }, source: "organisation" });
  });

  it("skips a stored setting that no longer reads, and defaults a missing value", () => {
    expect(resolvePlatformJsonFeatureFlag("ai-models", { installation: { models: [sol] }, user: { models: "broken" } }))
      .toEqual({ value: { models: [sol] }, source: "installation" });
    expect(platformJsonFeatureFlagValue("ai-models", undefined)).toEqual({ models: [] });
    expect(platformJsonFeatureFlagValue("ai-models", { "ai-models": { models: [terra] } })).toEqual({ models: [terra] });
    expect(platformJsonFeatureFlagValue("ai-models", { "ai-models": { models: 1 } })).toEqual({ models: [] });
  });

  it("converts USD per million tokens to nanodollars exactly", () => {
    expect(usdPerMillionToNanodollars(2)).toBe("2000000000");
    expect(usdPerMillionToNanodollars(0.05)).toBe("50000000");
    expect(usdPerMillionToNanodollars(0.125)).toBe("125000000");
    expect(usdPerMillionToNanodollars(0.000000001)).toBe("1");
    expect(usdPerMillionToNanodollars(0)).toBe("0");
  });
});
