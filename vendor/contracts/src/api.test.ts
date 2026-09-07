import { describe, expect, it } from "vitest";
import {
  assignAppIdentityActivationRequestSchema,
  assignAppIdentityLegacyRequestSchema,
  assignAppIdentityRequestSchema,
  ingestCustomMetricsRequestSchema,
  deploymentStateSchema,
  startAgentOnboardingRequestSchema,
  upsertAlertRuleRequestSchema,
} from "./api.js";

describe("agent app identity contract", () => {
  it("keeps schema v2 bound to the exact run attempt and authority grant", () => {
    const request = {
      schemaVersion: 2,
      userId: "11111111-1111-4111-8111-111111111111",
      appId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333",
      runAttempt: 2,
      authorityGrantId: "44444444-4444-4444-8444-444444444444",
      displayName: "Garden Ledger",
      slugStem: "garden-ledger",
    };

    expect(assignAppIdentityLegacyRequestSchema.parse(request)).toEqual(request);
    expect(assignAppIdentityRequestSchema.parse(request)).toEqual(request);
    expect(() =>
      assignAppIdentityRequestSchema.parse({
        ...request,
        schemaVersion: 1,
        runAttempt: undefined,
        authorityGrantId: undefined,
      }),
    ).toThrow();
  });

  it("accepts schema v3 only with an exact root and opaque activation ID", () => {
    const request = {
      schemaVersion: 3,
      userId: "11111111-1111-4111-8111-111111111111",
      appId: "22222222-2222-4222-8222-222222222222",
      rootRunId: "33333333-3333-4333-8333-333333333333",
      activationId: "55555555-5555-4555-8555-555555555555",
      displayName: "Garden Ledger",
      slugStem: "garden-ledger",
    };

    expect(assignAppIdentityActivationRequestSchema.parse(request)).toEqual(
      request,
    );
    expect(assignAppIdentityRequestSchema.parse(request)).toEqual(request);
    expect(() =>
      assignAppIdentityRequestSchema.parse({
        ...request,
        runId: request.rootRunId,
        authorityGrantId: "44444444-4444-4444-8444-444444444444",
      }),
    ).toThrow();
    expect(() =>
      assignAppIdentityRequestSchema.parse({
        ...request,
        activationId: "not-an-opaque-uuid",
      }),
    ).toThrow();
  });
});

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

describe("agent observability contract", () => {
  it("parses bounded metric batches and alert defaults", () => {
    expect(
      ingestCustomMetricsRequestSchema.parse({
        measurements: [
          {
            name: "tasks_created",
            value: 1,
            dimensions: { assignee_type: "child" },
            idempotencyKey: "task:123",
          },
        ],
      }),
    ).toEqual({
      measurements: [
        {
          name: "tasks_created",
          value: 1,
          dimensions: { assignee_type: "child" },
          idempotencyKey: "task:123",
        },
      ],
    });
    expect(
      upsertAlertRuleRequestSchema.parse({
        name: "Too many overdue tasks",
        metric: "overdue_tasks",
        aggregation: "latest",
        operator: "gt",
        threshold: 5,
        window: "15m",
      }),
    ).toMatchObject({
      minimumSamples: 1,
      severity: "warning",
      enabled: true,
    });
  });
});
