import { describe, expect, it } from "vitest";
import {
  ingestCustomMetricsRequestSchema,
  deploymentStateSchema,
  startAgentOnboardingRequestSchema,
  upsertAlertRuleRequestSchema,
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
