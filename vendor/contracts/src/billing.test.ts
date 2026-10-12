import { describe, expect, it } from "vitest";
import { hostedAgentNeedsPaidPlan, hostedAgentPlan, planIncludesHostedAgent, type BillingPublicPlan } from "./billing.js";

const limits = {
  apps: "3", storage: "1000000000", agent_concurrency: "0", custom_domains: "0",
  email_recipients_month: "300", automatic_repairs: false, backup_retention: "2", priority_support: false,
};

function plan(key: string, agentConcurrency: string | null, monthly: number | null, isDefault = false): BillingPublicPlan {
  return {
    key, name: key[0]!.toUpperCase() + key.slice(1), description: "", default: isDefault, version: 1,
    limits: { ...limits, agent_concurrency: agentConcurrency }, features: [], trialDays: 0,
    prices: monthly === null ? [] : [{ interval: "month", currency: "usd", unitAmount: monthly, taxBehavior: "unspecified" }],
  };
}

describe("hosted Agent in plans", () => {
  it("leaves the hosted Agent out only of plans with no runs at once", () => {
    expect(planIncludesHostedAgent({ agent_concurrency: "0" })).toBe(false);
    expect(planIncludesHostedAgent({ agent_concurrency: "1" })).toBe(true);
    expect(planIncludesHostedAgent({ agent_concurrency: null })).toBe(true);
  });

  it("suggests the first paid plan in catalog order that includes it", () => {
    const plans = [plan("free", "0", null, true), plan("lite", "0", 400), plan("advance", "3", 900), plan("max", "6", 5000)];
    expect(hostedAgentPlan(plans)?.key).toBe("advance");
  });

  it("never suggests a free plan, and nothing when no paid plan includes it", () => {
    expect(hostedAgentPlan([plan("free", "1", null, true), plan("advance", "0", 900)])).toBeNull();
    expect(hostedAgentPlan([])).toBeNull();
  });

  it("calls the hosted Agent a paid feature only when the free plan leaves it out", () => {
    expect(hostedAgentNeedsPaidPlan([plan("free", "0", null, true), plan("advance", "3", 900)])).toBe(true);
    expect(hostedAgentNeedsPaidPlan([plan("free", "1", null, true), plan("advance", "3", 900)])).toBe(false);
    expect(hostedAgentNeedsPaidPlan([plan("free", "0", null, true), plan("advance", "0", 900)])).toBe(false);
    expect(hostedAgentNeedsPaidPlan([])).toBe(false);
  });
});
