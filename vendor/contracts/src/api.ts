import { z } from "zod";
import { openCloudManifestSchema } from "./manifest.js";

export const appVisibilitySchema = z.enum(["public", "private"]);
const appSlugSchema = z
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

export const startAgentOnboardingRequestSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  projectName: z.string().trim().min(1).max(120),
  visibility: appVisibilitySchema.default("private"),
});

export const completeAgentOnboardingRequestSchema = z.object({
  completionToken: z.string().min(32).max(512),
});

export const customMetricDimensionsSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  z.string().min(1).max(40),
);

export const customMetricMeasurementSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z][a-z0-9_]*$/),
  value: z.number().finite().min(-1e15).max(1e15),
  dimensions: customMetricDimensionsSchema.default({}),
  idempotencyKey: z
    .string()
    .min(8)
    .max(120)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .optional(),
});

export const ingestCustomMetricsRequestSchema = z.object({
  measurements: z.array(customMetricMeasurementSchema).min(1).max(20),
});

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
export const alertStateSchema = z.enum([
  "ok",
  "firing",
  "resolved",
  "unknown",
  "invalid",
]);

export const upsertAlertRuleRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  metric: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z][a-z0-9_]*$/),
  aggregation: alertAggregationSchema,
  operator: alertOperatorSchema,
  threshold: z.number().finite().min(-1e15).max(1e15),
  window: alertWindowSchema,
  minimumSamples: z.number().int().min(1).max(100_000).default(1),
  severity: alertSeveritySchema.default("warning"),
  enabled: z.boolean().default(true),
});

export const deploymentSubmissionSchema = z.object({
  manifest: openCloudManifestSchema,
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type AppVisibility = z.infer<typeof appVisibilitySchema>;
export type AppState = z.infer<typeof appStateSchema>;
export type DeploymentState = z.infer<typeof deploymentStateSchema>;
export type OperationState = z.infer<typeof operationStateSchema>;
export type CreateAppRequest = z.infer<typeof createAppRequestSchema>;
export type CreateCredentialRequest = z.infer<
  typeof createCredentialRequestSchema
>;
export type StartAgentOnboardingRequest = z.infer<
  typeof startAgentOnboardingRequestSchema
>;
export type CompleteAgentOnboardingRequest = z.infer<
  typeof completeAgentOnboardingRequestSchema
>;
export type CustomMetricMeasurement = z.infer<
  typeof customMetricMeasurementSchema
>;
export type IngestCustomMetricsRequest = z.infer<
  typeof ingestCustomMetricsRequestSchema
>;
export type AlertAggregation = z.infer<typeof alertAggregationSchema>;
export type AlertOperator = z.infer<typeof alertOperatorSchema>;
export type AlertWindow = z.infer<typeof alertWindowSchema>;
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;
export type AlertState = z.infer<typeof alertStateSchema>;
export type UpsertAlertRuleRequest = z.infer<
  typeof upsertAlertRuleRequestSchema
>;

export type AgentOnboardingState =
  | "awaiting_email_verification"
  | "provisional_ready"
  | "ready";

export interface AgentOnboardingResponse {
  onboardingId: string;
  /** Non-secret owner page that waits for confirmation and deployment. */
  launchUrl: string;
  state: AgentOnboardingState;
  existingUser: boolean;
  verification: {
    required: true;
    status: "pending" | "verified";
    expiresAt: string;
    emailSent: boolean;
  };
  app: AppRecord | null;
  operation: OperationRecord | null;
  credential: {
    token: string;
    expiresAt: string;
  } | null;
  completionToken?: string;
}

export interface AppRecord {
  id: string;
  name: string;
  slug: string;
  appUrl: string;
  authUrl: string;
  apiUrl: string;
  visibility: AppVisibility;
  state: AppState;
  backupSchedule?: "none" | "daily" | "weekly";
  ownerUserId: string;
  desiredDeploymentId: string | null;
  activeDeploymentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CronInvocationRecord {
  id: string;
  appId: string;
  deploymentId: string;
  cronName: string;
  functionName: string;
  state: "running" | "succeeded" | "failed";
  scheduledAt: string;
  startedAt: string;
  finishedAt: string | null;
  responseStatus: number | null;
  error: Record<string, unknown> | null;
}

export interface DeploymentRecord {
  id: string;
  appId: string;
  version: string;
  artifactSha256: string;
  sdkVersion: string;
  manifest: unknown;
  state: DeploymentState;
  rollbackOfDeploymentId: string | null;
  error: Record<string, unknown> | null;
  createdAt: string;
  activatedAt: string | null;
}

export interface OperationStep {
  id: string;
  name: string;
  state: OperationState;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

export interface OperationRecord {
  id: string;
  appId: string | null;
  deploymentId: string | null;
  type: string;
  state: OperationState;
  actorType: string;
  actorId: string;
  idempotencyKey: string;
  error: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  steps?: OperationStep[];
}

export interface ErrorResponse {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export interface CustomMetricIngestResponse {
  accepted: number;
  duplicates: number;
  recordedAt: string;
}

export interface AlertRuleRecord extends UpsertAlertRuleRequest {
  id: string;
  appId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentFeedSignal {
  name: string;
  type: "state" | "counter" | "gauge" | "ratio" | "duration";
  value: string | number | null;
  unit: string | null;
  windowSeconds: number | null;
  source:
    | "control"
    | "runtime"
    | "usage"
    | "browser"
    | "authenticated"
    | "function"
    | "mixed"
    | "none";
}

export interface AgentFeedAlert {
  id: string;
  kind: "builtin" | "custom_metric";
  state: AlertState;
  severity: AlertSeverity;
  title: string;
  observedAt: string;
  lastTransitionAt: string | null;
  metric?: {
    name: string;
    type: "counter" | "gauge";
    value: number | null;
    unit: string | null;
    aggregation: AlertAggregation;
    window: AlertWindow;
    samples: number;
    source: "browser" | "authenticated" | "function" | "mixed" | "none";
  };
}

export interface AgentFeedEvent {
  id: string;
  type: "operation" | "cron";
  state: string;
  occurredAt: string;
  message: string;
  deploymentId: string | null;
}

export interface AgentFeedResponse {
  contractVersion: "1";
  app: {
    id: string;
    name: string;
    slug: string;
    state: AppState;
    activeDeployment: {
      id: string;
      version: string;
      state: DeploymentState;
    } | null;
  };
  observedAt: string;
  telemetry: {
    status: "available" | "unavailable";
    latestIngestedAt: string | null;
    ingestionLagSeconds: number | null;
    stale: boolean;
  };
  signals: AgentFeedSignal[];
  alerts: AgentFeedAlert[];
  events: AgentFeedEvent[];
  eventsTruncated: boolean;
  nextSince: string;
}
