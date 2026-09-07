import { z } from "zod";

export const appVisibilitySchema = z.enum(["public", "private"]);
export const appAiCredentialSourceSchema = z.enum([
  "owner",
  "user",
  "platform",
]);
export const appSlugSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
  .refine((slug) => !["api", "auth", "www"].includes(slug), {
    message: "slug is reserved by OpenCloud",
  });
export const appStateSchema = z.enum([
  "draft",
  "provisioning",
  "deploying",
  "active",
  "failed",
  "rolling_back",
  "archived",
  "deleting",
  "deleted",
]);
export const deploymentStateSchema = z.enum([
  "queued",
  "validating",
  "deploying",
  "active",
  "superseded",
  "failed",
  "rolled_back",
  "deleted",
]);
export const operationStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const createAppRequestSchema = z.object({
  name: z.string().min(1).max(120),
  visibility: appVisibilitySchema.default("private"),
});

export const createPendingAppRequestSchema = z
  .object({
    visibility: appVisibilitySchema.default("private"),
  })
  .strict();

export const assignAppIdentityLegacyRequestSchema = z
  .object({
    schemaVersion: z.literal(2),
    userId: z.uuid(),
    appId: z.uuid(),
    runId: z.uuid(),
    runAttempt: z.number().int().positive(),
    authorityGrantId: z.uuid(),
    displayName: z.string().trim().min(1).max(120),
    slugStem: z
      .string()
      .trim()
      .min(1)
      .max(56)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  })
  .strict();

export const assignAppIdentityActivationRequestSchema = z
  .object({
    schemaVersion: z.literal(3),
    userId: z.uuid(),
    appId: z.uuid(),
    rootRunId: z.uuid(),
    activationId: z.uuid(),
    displayName: z.string().trim().min(1).max(120),
    slugStem: z
      .string()
      .trim()
      .min(1)
      .max(56)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  })
  .strict();

export const assignAppIdentityRequestSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    assignAppIdentityLegacyRequestSchema,
    assignAppIdentityActivationRequestSchema,
  ],
);

export const resolveAppIdentityActivationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    userId: z.uuid(),
    appId: z.uuid(),
    rootRunId: z.uuid(),
    activationId: z.uuid(),
  })
  .strict();

export const resolveAppIdentityActivationResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    userId: z.uuid(),
    appId: z.uuid(),
    rootRunId: z.uuid(),
    activationId: z.uuid(),
    appState: appStateSchema,
    identityStatus: z.enum(["pending", "assigned"]),
    resolution: z.enum(["unassigned", "exact", "assigned_elsewhere"]),
  })
  .strict();

export const operatorCreateAppRequestSchema = createAppRequestSchema.extend({
  slug: appSlugSchema.optional(),
  ownerUserId: z.uuid().optional(),
});

export const createCredentialRequestSchema = z.object({
  name: z.string().min(1).max(120),
  expiresInHours: z.coerce.number().int().min(1).max(168).default(24),
  scopes: z
    .array(
      z.enum([
        "app:read",
        "app:deploy",
        "app:configure",
        "app:observe",
        "app:rollback",
        "app:restart",
      ]),
    )
    .min(1),
});

export const appAccessTokenDeliverySchema = z.enum(["response", "reveal_link"]);

export const createAppAccessTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  expiresInDays: z.coerce.number().int().min(1).max(365).default(90),
  delivery: appAccessTokenDeliverySchema.default("response"),
});

export const requestAppAccessTokenApprovalSchema =
  createAppAccessTokenRequestSchema.pick({
    name: true,
    expiresInDays: true,
  });

export const startAgentOnboardingRequestSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  projectName: z.string().trim().min(1).max(120),
  visibility: appVisibilitySchema.default("private"),
});

export const completeAgentOnboardingRequestSchema = z.object({
  completionToken: z.string().min(32).max(512),
});

export const customMetricNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9_]*$/, "metric names must use lowercase snake_case");

export const alertRuleIdSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9-]*$/);

export const alertAggregationSchema = z.enum([
  "sum",
  "rate",
  "latest",
  "min",
  "max",
  "avg",
]);
export const alertOperatorSchema = z.enum(["gt", "gte", "lt", "lte", "eq"]);
export const alertWindowSchema = z.enum(["5m", "15m", "1h", "24h"]);
export const alertSeveritySchema = z.enum(["info", "warning", "critical"]);

export const manifestAlertRuleSchema = z
  .object({
    id: alertRuleIdSchema,
    name: z.string().trim().min(1).max(120),
    metric: customMetricNameSchema,
    aggregation: alertAggregationSchema,
    operator: alertOperatorSchema,
    threshold: z.number().finite().min(-1e15).max(1e15),
    window: alertWindowSchema,
    minimumSamples: z.number().int().min(1).max(100_000).default(1),
    severity: alertSeveritySchema.default("warning"),
    enabled: z.boolean().default(true),
  })
  .strict();

export const upsertAlertRuleRequestSchema = manifestAlertRuleSchema.omit({
  id: true,
});
