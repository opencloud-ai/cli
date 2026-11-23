import { z } from "zod";
import {
  alertAggregationSchema,
  alertOperatorSchema,
  alertRuleIdSchema,
  alertSeveritySchema,
  alertWindowSchema,
  appAccessTokenDeliverySchema,
  appAiCredentialSourceSchema,
  appSlugSchema,
  appStateSchema,
  appVisibilitySchema,
  assignAppIdentityRequestSchema,
  assignAppIdentityLegacyRequestSchema,
  assignAppIdentityActivationRequestSchema,
  resolveAppIdentityActivationRequestSchema,
  resolveAppIdentityActivationResponseSchema,
  completeAgentOnboardingRequestSchema,
  createAppAccessTokenRequestSchema,
  createAppRequestSchema,
  createCredentialRequestSchema,
  createPendingAppRequestSchema,
  deploymentStateSchema,
  operationStateSchema,
  operatorCreateAppRequestSchema,
  requestAppAccessTokenApprovalSchema,
  startAgentOnboardingRequestSchema,
  upsertAlertRuleRequestSchema,
} from "./api-core.js";
import { openCloudManifestSchema } from "./manifest.js";
import type { ComputeLogCoordinates, ComputeLogObservation } from "./compute-observation.js";
import { customMetricMeasurementSchema, ingestCustomMetricsRequestSchema } from "./api-core.js";
export { customMetricDimensionsSchema, customMetricMeasurementSchema, ingestCustomMetricsRequestSchema } from "./api-core.js";

export {
  alertAggregationSchema,
  alertOperatorSchema,
  alertRuleIdSchema,
  alertSeveritySchema,
  alertWindowSchema,
  appAccessTokenDeliverySchema,
  appAiCredentialSourceSchema,
  appSlugSchema,
  appStateSchema,
  appVisibilitySchema,
  assignAppIdentityRequestSchema,
  assignAppIdentityLegacyRequestSchema,
  assignAppIdentityActivationRequestSchema,
  resolveAppIdentityActivationRequestSchema,
  resolveAppIdentityActivationResponseSchema,
  completeAgentOnboardingRequestSchema,
  createAppAccessTokenRequestSchema,
  createAppRequestSchema,
  createCredentialRequestSchema,
  createPendingAppRequestSchema,
  deploymentStateSchema,
  operationStateSchema,
  operatorCreateAppRequestSchema,
  requestAppAccessTokenApprovalSchema,
  startAgentOnboardingRequestSchema,
  upsertAlertRuleRequestSchema,
} from "./api-core.js";

export const alertStateSchema = z.enum([
  "ok",
  "firing",
  "resolved",
  "unknown",
  "invalid",
]);

export const deploymentSubmissionSchema = z.object({
  manifest: openCloudManifestSchema,
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type AppVisibility = z.infer<typeof appVisibilitySchema>;
export type AppAiCredentialSource = z.infer<typeof appAiCredentialSourceSchema>;
export type AppState = z.infer<typeof appStateSchema>;
export type DeploymentState = z.infer<typeof deploymentStateSchema>;
export type OperationState = z.infer<typeof operationStateSchema>;
export type CreateAppRequest = z.infer<typeof createAppRequestSchema>;
export type CreatePendingAppRequest = z.infer<
  typeof createPendingAppRequestSchema
>;
export type AssignAppIdentityRequest = z.infer<
  typeof assignAppIdentityRequestSchema
>;
export type AssignAppIdentityLegacyRequest = z.infer<
  typeof assignAppIdentityLegacyRequestSchema
>;
export type AssignAppIdentityActivationRequest = z.infer<
  typeof assignAppIdentityActivationRequestSchema
>;
export type ResolveAppIdentityActivationRequest = z.infer<
  typeof resolveAppIdentityActivationRequestSchema
>;
export type ResolveAppIdentityActivationResponse = z.infer<
  typeof resolveAppIdentityActivationResponseSchema
>;
export type CreateCredentialRequest = z.infer<
  typeof createCredentialRequestSchema
>;
export type CreateAppAccessTokenRequest = z.infer<
  typeof createAppAccessTokenRequestSchema
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
export type AlertRuleOrigin = "manifest" | "operational_override";
export type UpsertAlertRuleRequest = z.infer<
  typeof upsertAlertRuleRequestSchema
>;

export type AgentOnboardingState =
  "awaiting_email_verification" | "organisation_setup_required" | "provisional_ready" | "ready";

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
  identityStatus: "pending" | "assigned";
  name: string | null;
  slug: string | null;
  appUrl: string | null;
  authUrl: string;
  apiUrl: string;
  /** The app's page in the dashboard, and its Sharing page, where people are invited. */
  dashboardUrl?: string;
  sharingUrl?: string;
  visibility: AppVisibility;
  aiCredentialSource: AppAiCredentialSource;
  state: AppState;
  backupSchedule?: "none" | "daily" | "weekly";
  ownerUserId: string;
  organisationId?: string;
  workspaceId?: string;
  placementVersion?: string;
  creatorUserId?: string;
  desiredDeploymentId: string | null;
  activeDeploymentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppDeploymentTruth {
  schemaVersion: 1;
  appId: string;
  appState: AppState;
  canonicalUrl: string | null;
  activeDeployment: {
    id: string;
    version: string;
    artifactSha256: string;
    state: DeploymentState;
    activatedAt: string | null;
    activationOperationId: string | null;
    activatedByAgentRootRunId: string | null;
  } | null;
}

/**
 * Why a scheduled run didn't happen. A schedule runs only at its configured
 * time, so a run OpenCloud couldn't start then is skipped, never run later.
 */
export type CronSkipReason =
  /** OpenCloud couldn't start it within 5 minutes of its time, for example during an update or an outage. */
  | "missed"
  /** It hadn't started when the next run was due. */
  | "superseded"
  /** It waited a day without starting. */
  | "expired"
  /** The schedule was turned off before it started. */
  | "disabled"
  /** The schedule changed before it started. */
  | "schedule_changed"
  /** The schedule was removed before it started. */
  | "removed"
  /** It was no longer due when it could start. */
  | "no_longer_due";

export interface CronSkippedRun {
  reason: CronSkipReason;
  /** The reason in plain words. */
  message: string;
  /**
   * Set when the row stands for every scheduled run from this time to
   * `scheduledAt`, after a gap too long to list run by run.
   */
  since: string | null;
}

export interface CronInvocationRecord {
  id: string;
  appId: string;
  deploymentId: string;
  cronName: string;
  functionName: string;
  /** `skipped`: a scheduled run that didn't happen; see `skipped`. */
  state: "running" | "succeeded" | "failed" | "skipped";
  scheduledAt: string;
  /** Null for a skipped run, which never started. */
  startedAt: string | null;
  finishedAt: string | null;
  responseStatus: number | null;
  error: Record<string, unknown> | null;
  /** Set when `state` is `skipped`. */
  skipped?: CronSkippedRun;
}

export interface CronInvocationsPage {
  asOf: string;
  invocations: CronInvocationRecord[];
  nextCursor: string | null;
}

export type BackgroundJobState =
  "queued" | "running" | "retry_wait" | "succeeded" | "dead_lettered";

export interface BackgroundJobRecord {
  id: string;
  appId: string;
  deploymentId: string;
  queue: string;
  consumerFunction: string;
  producerFunction: string;
  state: BackgroundJobState;
  attempt: number;
  maxAttempts: number;
  runAt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  lastError: Record<string, unknown> | null;
}

export interface BackgroundJobStats {
  created: number;
  retried: number;
  succeeded: number;
  failed: number;
  active: number;
  queued: number;
  running: number;
  retryWaiting: number;
}

export interface BackgroundJobQueueStats extends BackgroundJobStats {
  name: string;
  declared: boolean;
  functionName: string | null;
  concurrency: number | null;
  maxAttempts: number | null;
  retryDelaySeconds: number | null;
  retryBackoff: boolean | null;
  timeoutSeconds: number | null;
  oldestPendingAt: string | null;
}

export interface BackgroundJobsPage {
  asOf: string;
  retentionDays: number;
  stats: BackgroundJobStats;
  queues: BackgroundJobQueueStats[];
  jobs: BackgroundJobRecord[];
  nextCursor: string | null;
}

export interface DeploymentRecord {
  id: string;
  appId: string;
  version: string;
  artifactSha256: string;
  sdkVersion: string;
  manifest: unknown;
  state: DeploymentState;
  /** Server-selected release path; absent on older installations. */
  deploymentMode?: "online" | "maintenance";
  preparationPhase?: "preparing" | "ready" | "published" | "failed" | null;
  rollbackOfDeploymentId: string | null;
  error: Record<string, unknown> | null;
  createdAt: string;
  activatedAt: string | null;
  /**
   * The exact draft file tree this release was validated from. Null when the
   * release was uploaded without a draft or predates release source; absent
   * from servers that do not record it.
   */
  source?: DeploymentSourceRecord | null;
}

export interface DeploymentSourceRecord {
  sha256: string;
  sizeBytes: number;
  fileCount: number;
}

export interface DeploymentsPage {
  asOf: string;
  deployments: DeploymentRecord[];
  nextCursor: string | null;
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

export interface OperationsPage {
  asOf: string;
  operations: OperationRecord[];
  nextCursor: string | null;
}

export interface AppLogEntry {
  compute?: ComputeLogCoordinates;
  id: string;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  surface: string;
  message: string;
  requestId: string | null;
  /** The structured fields a Function passed to `log`, on lines its runtime wrote. */
  fields?: Record<string, unknown>;
}

export interface AppLogsPage {
  computeObservation?: ComputeLogObservation;
  entries: AppLogEntry[];
  nextCursor: string | null;
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
  origin: AlertRuleOrigin;
  createdAt: string;
  updatedAt: string;
}

export type AlertFireDeliveryState = "pending" | "retry_wait" | "delivered";

export interface AlertFireDeliveryRecord {
  fireId: string;
  state: AlertFireDeliveryState;
  attempts: number;
  observedAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  incidentId: string | null;
  runId: string | null;
}

export interface AlertRuleStatusRecord extends AlertRuleRecord {
  state: Exclude<AlertState, "resolved">;
  samples: number;
  lastEvaluatedAt: string | null;
  lastTransitionAt: string | null;
  delivery: AlertFireDeliveryRecord | null;
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
  /** A custom metric's newest sample in its window, or null with none. */
  lastSampleAt?: string | null;
}

export interface AgentFeedAlert {
  id: string;
  kind: "builtin" | "custom_metric";
  state: Exclude<AlertState, "resolved">;
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

export interface AgentFeedBreach {
  id: string;
  ruleId: string;
  severity: AlertSeverity;
  title: string;
  startedAt: string;
  startedBeforeSince: boolean;
  endedAt: string | null;
  endState: "ok" | "unknown" | "invalid" | null;
  metric: {
    name: string;
    type: "counter" | "gauge";
    triggerValue: number;
    unit: string | null;
    aggregation: AlertAggregation;
    operator: AlertOperator;
    threshold: number;
    window: AlertWindow;
    samples: number;
    source: "browser" | "authenticated" | "function" | "mixed" | "none";
  };
}

export interface AgentFeedEvent {
  id: string;
  type: "operation" | "cron" | "job";
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
  recentBreaches: AgentFeedBreach[];
  breachesTruncated: boolean;
  events: AgentFeedEvent[];
  eventsTruncated: boolean;
  nextSince: string;
}
