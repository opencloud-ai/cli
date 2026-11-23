import { z } from "zod";
import {
  computeApplicationPathSchema,
  computeBoundedJsonSchema,
  computeCommandSchema,
  computeEnvironmentBindingSchema,
  computeEnvironmentNameSchema,
  computeEnvironmentValuesSchema,
  computeIdSchema,
  computeImageReferenceSchema,
  computeInstanceStateSchema,
  computeIntegerSchema,
  computeKindSchema,
  computeNameSchema,
  computeOutputPolicySchema,
  computePinnedImageSchema,
  computeProbeSchema,
  computeResourceAllocationSchema,
  computeTimestampSchema,
  type ComputeResourceAllocation,
} from "@opencloud/compute-protocol";
import { customMetricNameSchema, customMetricMeasurementSchema, customMetricDimensionsSchema } from "./api-core.js";
import { computeInstanceDiagnosticsSchema } from "./compute-observation.js";

export { computeEnvironmentBindingSchema, computeKindSchema, computeNameSchema, computeInstanceStateSchema };
export const containerNameSchema = computeNameSchema;
export const containerKindSchema = computeKindSchema;
export const containerResourcesSchema = z.object({
  cpu: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).default(1),
  memoryGiB: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16), z.literal(32)]).default(2),
  scratchGiB: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(10), z.literal(20)]).default(1),
}).strict();
export type ContainerResources = z.infer<typeof containerResourcesSchema>;
/** The only manifest-to-worker unit conversion. Billing receives this exact allocation. */
export function normalizeComputeResources(resources: ContainerResources): ComputeResourceAllocation {
  return computeResourceAllocationSchema.parse({ vcpu: resources.cpu, memoryMib: resources.memoryGiB * 1024, scratchMib: resources.scratchGiB * 1024 });
}

const uniqueNames = <T extends z.ZodType<string>>(schema: T, maximum: number) =>
  z.array(schema).max(maximum).refine(values => new Set(values).size === values.length, "Names must be unique");
const containerEnvironmentNameSchema = computeEnvironmentNameSchema.refine(
  name => name !== "PORT" && !name.startsWith("OPENCLOUD_") && !name.startsWith("SUPABASE_"),
  "Environment name is reserved by OpenCloud",
);
const secretReferenceSchema = computeEnvironmentNameSchema.refine(
  name => !name.startsWith("OPENCLOUD_") && !name.startsWith("SUPABASE_"), "Secret reference is reserved",
);
const containerCommonFields = {
  name: containerNameSchema,
  image: computeImageReferenceSchema,
  registryConnection: computeIdSchema.optional(),
  command: computeCommandSchema.optional(),
  args: computeCommandSchema.optional(),
  env: z.record(containerEnvironmentNameSchema, computeEnvironmentValuesSchema.valueType).refine(
    entries => Object.keys(entries).length <= 64, "At most 64 environment entries",
  ).default({}),
  secrets: z.record(containerEnvironmentNameSchema, secretReferenceSchema).refine(
    entries => Object.keys(entries).length <= 64, "At most 64 secret references",
  ).default({}),
  resources: containerResourcesSchema.prefault({}),
  startupTimeoutSeconds: z.number().int().min(1).max(300).default(120),
  permissions: z.object({
    functions: uniqueNames(computeNameSchema, 100).default([]),
    metrics: uniqueNames(customMetricNameSchema, 20).default([]),
  }).strict().prefault({}),
  egress: z.enum(["internet-http", "none"]).default("internet-http"),
};
export const containerJobPolicySchema = z.object({
  timeoutSeconds: z.number().int().min(1).max(86_400).default(900),
  queueTimeoutSeconds: z.number().int().min(1).max(86_400).default(86_400),
  concurrency: z.number().int().min(1).max(20).default(1),
  maxAttempts: z.number().int().min(1).max(5).default(1),
  retryExitCodes: z.array(z.number().int().min(1).max(255)).max(255).refine(
    codes => new Set(codes).size === codes.length, "Retry exit codes must be unique",
  ).default([]),
  inputs: z.object({ maxFiles: z.number().int().min(1).max(16), maxTotalGiB: z.number().int().min(1).max(10) }).strict().optional(),
  outputs: computeOutputPolicySchema.optional(),
  onComplete: computeNameSchema.optional(),
}).strict();
export const containerServicePolicySchema = z.object({
  port: z.number().int().min(1024).max(65_535).default(8080),
  concurrency: z.number().int().min(1).max(100).default(20),
  requestTimeoutSeconds: z.number().int().min(1).max(3_600).default(60),
  drainTimeoutSeconds: z.number().int().min(0).max(300).default(30),
  scaling: z.object({
    minInstances: z.number().int().min(0).max(20).default(0),
    maxInstances: z.number().int().min(1).max(20).default(5),
  }).strict().prefault({}).refine(value => value.minInstances <= value.maxInstances, "minInstances must not exceed maxInstances"),
  startupProbe: computeProbeSchema,
  readinessProbe: computeProbeSchema,
  livenessProbe: computeProbeSchema.optional(),
}).strict();
const containerWorkerPolicyInputSchema = z.object({
  replicas: z.number().int().min(0).max(20).default(1),
  maxReplicas: z.number().int().min(1).max(20).optional(),
  restart: z.literal("always").default("always"),
}).strict();
export const containerWorkerPolicySchema = containerWorkerPolicyInputSchema
  .transform(value => ({ ...value, maxReplicas: value.maxReplicas ?? Math.max(1, value.replicas) }))
  .pipe(containerWorkerPolicyInputSchema.required())
  .refine(value => value.replicas <= value.maxReplicas, "replicas must not exceed maxReplicas");
export const containerDefinitionSchema = z.discriminatedUnion("kind", [
  z.object({ ...containerCommonFields, kind: z.literal("job"), job: containerJobPolicySchema }).strict(),
  z.object({ ...containerCommonFields, kind: z.literal("service"), service: containerServicePolicySchema }).strict(),
  z.object({ ...containerCommonFields, kind: z.literal("worker"), worker: containerWorkerPolicySchema }).strict(),
]).superRefine((definition, context) => {
  for (const name of Object.keys(definition.secrets)) {
    if (Object.hasOwn(definition.env, name)) context.addIssue({ code: "custom", path: ["secrets", name], message: "An environment name cannot also reference a secret" });
  }
  if (definition.kind === "job" && definition.job.outputs && definition.job.outputs.maxTotalGiB > definition.resources.scratchGiB) {
    context.addIssue({ code: "custom", path: ["job", "outputs", "maxTotalGiB"], message: "Reserved outputs must fit the scratch allocation" });
  }
  if (new TextEncoder().encode(JSON.stringify(definition)).length > 65_536) context.addIssue({ code: "custom", message: "Normalized container configuration exceeds 64 KiB" });
});
export const containerDefinitionsSchema = z.array(containerDefinitionSchema).max(10).superRefine((definitions, context) => {
  const seen = new Set<string>();
  definitions.forEach((definition, index) => {
    if (seen.has(definition.name)) context.addIssue({ code: "custom", path: [index, "name"], message: "Container names must be unique" });
    seen.add(definition.name);
  });
});
export type ContainerDefinition = z.infer<typeof containerDefinitionSchema>;
export type ContainerJobDefinition = Extract<ContainerDefinition, { kind: "job" }>;
export type ContainerServiceDefinition = Extract<ContainerDefinition, { kind: "service" }>;
export type ContainerWorkerDefinition = Extract<ContainerDefinition, { kind: "worker" }>;

export const computeErrorOriginSchema = z.enum(["app", "policy", "platform", "unknown"]);
export const computeErrorPhaseSchema = z.enum(["validation", "admission", "image", "preparation", "startup", "running", "ingress", "collecting", "completion", "stopping", "metering", "billing"]);
export const computeRetryScopeSchema = z.enum(["request", "unstarted_preparation", "known_failed_attempt", "collection", "notification", "observer_reconciliation", "none"]);
export const computeBillingDispositionSchema = z.enum(["none", "confirmed_usage", "pending_evidence", "credit_due"]);
export const computeErrorCategorySchema = z.enum(["configuration", "authority", "billing", "capacity", "image", "files", "execution", "ingress", "network", "metering", "internal"]);
type ErrorOrigin = z.infer<typeof computeErrorOriginSchema>;
type ErrorPhase = z.infer<typeof computeErrorPhaseSchema>;
type RetryScope = z.infer<typeof computeRetryScopeSchema>;
type BillingDisposition = z.infer<typeof computeBillingDispositionSchema>;
type ErrorCategory = z.infer<typeof computeErrorCategorySchema>;
function error(statusCode: number, category: ErrorCategory, origin: ErrorOrigin, phase: ErrorPhase, retryScope: RetryScope, billingDisposition: BillingDisposition, message: string, retryable = false) {
  return Object.freeze({ statusCode, category, origin, phase, retryScope, billingDisposition, message, retryable });
}
/** Defaults never infer platform blame from customer stderr or an HTTP status alone. */
export const computeErrorCatalog = Object.freeze({
  COMPUTE_NOT_ENABLED: error(403, "configuration", "policy", "admission", "none", "none", "Container compute is not enabled for this account."),
  COMPUTE_NOT_OFFERED: error(422, "configuration", "policy", "validation", "none", "none", "This installation doesn't offer containers. Remove the containers, and a container frontend, from opencloud.yaml to use this app here."),
  COMPUTE_BILLING_UNAVAILABLE: error(503, "billing", "policy", "admission", "none", "none", "Compute billing is not available for this account."),
  COMPUTE_PAYMENT_REQUIRED: error(402, "billing", "policy", "admission", "none", "none", "Compute payment is required."),
  COMPUTE_BUDGET_EXCEEDED: error(429, "billing", "policy", "admission", "none", "confirmed_usage", "The compute spending limit has been reached."),
  COMPUTE_CAPACITY_EXCEEDED: error(429, "capacity", "policy", "admission", "request", "none", "The account has reached its container capacity limit.", true),
  COMPUTE_QUEUE_FULL: error(429, "capacity", "policy", "admission", "request", "none", "The container waiting queue is full.", true),
  COMPUTE_NO_CAPACITY: error(503, "capacity", "platform", "admission", "unstarted_preparation", "none", "Every available compute host is full right now. Retry shortly.", true),
  COMPUTE_HOST_UNAVAILABLE: error(503, "capacity", "platform", "admission", "unstarted_preparation", "none", "No compute host is available right now: every host is down, unreachable or under maintenance. Retry later.", true),
  COMPUTE_INVALID_DEFINITION: error(422, "configuration", "app", "validation", "none", "none", "The container definition is invalid."),
  COMPUTE_UNSUPPORTED_IMAGE: error(422, "image", "app", "image", "none", "none", "The image is not supported by this runtime."),
  COMPUTE_IMAGE_TOO_LARGE: error(422, "image", "app", "image", "none", "none", "The image exceeds the supported size limit."),
  COMPUTE_REVISION_UNAVAILABLE: error(409, "authority", "policy", "admission", "none", "none", "The pinned container revision is no longer eligible."),
  COMPUTE_RELEASE_REPLACED: error(409, "configuration", "policy", "admission", "none", "none", "Another release (a deploy, rollback or dev sync) replaced this one. A job still waiting to start on it was cancelled: start it again to run it on the current release. A worker or service copy of it is stopping and can no longer call Functions: save progress as you go, so the new release's copies carry on from there."),
  COMPUTE_REVISION_CONFLICT: error(409, "configuration", "policy", "admission", "none", "none", "The workload changed. Refresh its control generation."),
  COMPUTE_IDEMPOTENCY_CONFLICT: error(409, "configuration", "app", "admission", "none", "none", "The idempotency key was already used for a different request."),
  COMPUTE_AUTHORITY_REVOKED: error(403, "authority", "policy", "running", "none", "confirmed_usage", "The workload's execution authority was revoked."),
  COMPUTE_CAPABILITY_INVALID: error(401, "authority", "app", "running", "request", "none", "The container capability is missing, malformed or no longer current. Read OPENCLOUD_CONTAINER_CAPABILITY_FILE again for every call."),
  COMPUTE_NOT_LIVE: error(503, "authority", "policy", "startup", "request", "none", "This copy isn't serving yet: its release goes live when the deploy or sync switches to it. Retry shortly.", true),
  COMPUTE_METRIC_INVALID: error(422, "configuration", "app", "running", "none", "none", "The container recorded a metric it may not record, or a measurement that isn't valid: record each value as a finite number, declare the metric in observability.metrics and the container's permissions.metrics, use only declared dimension values, and never record a negative counter increment. details.field names a malformed field."),
  COMPUTE_METRIC_LIMIT: error(429, "capacity", "policy", "running", "request", "none", "The app reached its custom metric limits (1,200 measurements a minute, 100,000 kept). Record fewer measurements, or retry later.", true),
  COMPUTE_NOT_FOUND: error(404, "authority", "policy", "admission", "none", "none", "The container resource was not found."),
  COMPUTE_CANCEL_PRODUCER_ONLY: error(403, "authority", "app", "admission", "none", "none", "Only the Function that started this execution can cancel it. Cancel it from that Function, or start and cancel the job in the same Function."),
  COMPUTE_PROTOCOL_UNSUPPORTED: error(422, "configuration", "app", "validation", "none", "none", "This protocol is not supported."),
  COMPUTE_IMAGE_NOT_FOUND: error(422, "image", "app", "image", "none", "none", "The requested container image was not found."),
  COMPUTE_IMAGE_ACCESS_DENIED: error(422, "image", "app", "image", "none", "none", "The registry connection cannot read this image."),
  COMPUTE_IMAGE_PULL_FAILED: error(503, "image", "unknown", "image", "unstarted_preparation", "none", "The container image could not be retrieved.", true),
  COMPUTE_INPUT_UNAVAILABLE: error(409, "files", "policy", "preparation", "none", "none", "An input file is no longer available or authorized."),
  COMPUTE_INPUT_TRANSFER_FAILED: error(503, "files", "platform", "preparation", "unstarted_preparation", "none", "Input file transfer could not complete.", true),
  COMPUTE_QUEUE_TIMEOUT: error(408, "capacity", "policy", "admission", "none", "none", "The execution reached its queue deadline without starting."),
  COMPUTE_STARTUP_FAILED: error(422, "execution", "app", "startup", "none", "confirmed_usage", "The container failed to start successfully."),
  COMPUTE_STARTUP_TIMEOUT: error(504, "execution", "app", "startup", "none", "confirmed_usage", "The container did not become ready before its startup deadline."),
  COMPUTE_EXIT_NONZERO: error(422, "execution", "app", "running", "known_failed_attempt", "confirmed_usage", "The container process exited unsuccessfully."),
  COMPUTE_OUT_OF_MEMORY: error(422, "execution", "app", "running", "none", "confirmed_usage", "The container exceeded its memory allocation."),
  COMPUTE_SCRATCH_EXHAUSTED: error(422, "execution", "app", "running", "none", "confirmed_usage", "The container exhausted its scratch allocation."),
  COMPUTE_TIMEOUT: error(408, "execution", "app", "running", "none", "confirmed_usage", "The job reached its execution deadline."),
  COMPUTE_CANCELLED: error(409, "execution", "policy", "stopping", "none", "confirmed_usage", "The execution was cancelled."),
  COMPUTE_OUTPUT_INVALID: error(422, "files", "app", "collecting", "none", "confirmed_usage", "The job output violates its declared file policy."),
  COMPUTE_OUTPUT_DIRECTORY_MISSING: error(422, "files", "app", "collecting", "none", "confirmed_usage", "The job declares outputs but didn't create its output directory. Create it (for example with mkdir -p), even when the job writes nothing."),
  COMPUTE_OUTPUT_COLLECTION_FAILED: error(503, "files", "unknown", "collecting", "collection", "pending_evidence", "The stopped job's outputs could not be collected.", true),
  COMPUTE_COMPLETION_FAILED: error(502, "execution", "app", "completion", "notification", "confirmed_usage", "Completion notification failed; the compute result is retained.", true),
  COMPUTE_OUTCOME_UNKNOWN: error(409, "execution", "unknown", "running", "observer_reconciliation", "pending_evidence", "The execution outcome is not yet known. Do not repeat its effects."),
  COMPUTE_WORKER_LOST: error(503, "execution", "platform", "running", "observer_reconciliation", "pending_evidence", "The execution host is unreachable."),
  COMPUTE_LEASE_EXPIRED: error(409, "authority", "policy", "stopping", "none", "confirmed_usage", "The funded execution lease expired."),
  COMPUTE_RUNTIME_UNAVAILABLE: error(503, "execution", "platform", "startup", "unstarted_preparation", "none", "The required sandbox or host policy is unavailable.", true),
  COMPUTE_STOP_FAILED: error(503, "execution", "platform", "stopping", "observer_reconciliation", "credit_due", "Container termination could not be confirmed."),
  COMPUTE_STARTING_PENDING: error(503, "ingress", "policy", "ingress", "request", "confirmed_usage", "The service is still starting.", true),
  COMPUTE_SERVICE_UNAVAILABLE: error(503, "ingress", "policy", "ingress", "request", "confirmed_usage", "The service has no ready instance."),
  COMPUTE_CONCURRENCY_EXCEEDED: error(429, "capacity", "policy", "ingress", "request", "confirmed_usage", "The service's request capacity is full.", true),
  COMPUTE_REQUEST_TOO_LARGE: error(413, "ingress", "app", "ingress", "none", "confirmed_usage", "The service request body exceeds the supported size limit."),
  COMPUTE_REQUEST_HEADERS_TOO_LARGE: error(431, "ingress", "app", "ingress", "none", "confirmed_usage", "The service request headers exceed the supported size limit."),
  COMPUTE_REQUEST_TIMEOUT: error(504, "ingress", "app", "ingress", "none", "confirmed_usage", "The service request exceeded its deadline."),
  COMPUTE_UPSTREAM_FAILED: error(502, "ingress", "unknown", "ingress", "none", "confirmed_usage", "The container connection failed."),
  COMPUTE_FUNCTION_FAILED: error(502, "execution", "app", "running", "none", "none", "The Function answered with an error status (details.upstreamStatus); its logs say why. The same idempotency key keeps this answer: use a new key to run it again."),
  COMPUTE_READINESS_FAILED: error(503, "execution", "app", "running", "none", "confirmed_usage", "The service is not ready for traffic."),
  COMPUTE_LIVENESS_FAILED: error(503, "execution", "app", "running", "none", "confirmed_usage", "The service failed its liveness check."),
  COMPUTE_CRASH_LOOP: error(409, "execution", "app", "running", "none", "confirmed_usage", "Repeated failures paused this workload. Fix it before resuming."),
  COMPUTE_EGRESS_DENIED: error(403, "network", "policy", "running", "none", "confirmed_usage", "The destination or protocol is outside the container's network policy."),
  COMPUTE_EGRESS_LIMIT: error(429, "network", "policy", "running", "none", "confirmed_usage", "The account's external transfer allowance was reached."),
  COMPUTE_METER_CONFLICT: error(409, "metering", "platform", "metering", "observer_reconciliation", "pending_evidence", "Compute usage evidence conflicts with retained observations."),
  COMPUTE_METERING_UNAVAILABLE: error(503, "metering", "platform", "metering", "observer_reconciliation", "pending_evidence", "Durable compute usage recording is unavailable."),
  COMPUTE_PRICE_INVALID: error(422, "configuration", "policy", "billing", "none", "none", "The compute price configuration is invalid."),
  COMPUTE_PRICE_VERSION_CONFLICT: error(409, "configuration", "policy", "billing", "none", "none", "The compute price version is immutable or the draft changed."),
  COMPUTE_BILLING_EXPORT_FAILED: error(503, "billing", "platform", "billing", "observer_reconciliation", "pending_evidence", "Compute billing reporting is delayed.", true),
  COMPUTE_BILLING_MISMATCH: error(409, "billing", "platform", "billing", "observer_reconciliation", "pending_evidence", "Compute billing totals require reconciliation."),
  COMPUTE_INTERNAL_ERROR: error(500, "internal", "platform", "running", "none", "pending_evidence", "An internal compute error occurred."),
});
export type ComputeErrorCode = keyof typeof computeErrorCatalog;
export const computeErrorCodeSchema = z.enum(Object.keys(computeErrorCatalog) as [ComputeErrorCode, ...ComputeErrorCode[]]);
export const computeErrorDetailsSchema = z.object({
  category: computeErrorCategorySchema,
  origin: computeErrorOriginSchema,
  phase: computeErrorPhaseSchema,
  retryScope: computeRetryScopeSchema,
  retryable: z.boolean(),
  billingDisposition: computeBillingDispositionSchema,
  retryAfterSeconds: z.number().int().min(1).max(86_400).optional(),
  workloadName: containerNameSchema.optional(),
  executionId: computeIdSchema.optional(),
  instanceId: computeIdSchema.optional(),
  attempt: z.number().int().min(1).max(5).optional(),
  exitCode: z.number().int().min(0).max(255).optional(),
  signal: z.string().regex(/^SIG[A-Z0-9]{1,20}$/).optional(),
  /** The HTTP status a Function answered a container's call with. */
  upstreamStatus: z.number().int().min(100).max(599).optional(),
  /** The request field a malformed request got wrong, such as `measurements.0.value`. */
  field: z.string().regex(/^[A-Za-z0-9_.]{1,100}$/).optional(),
  /** Why a platform refusal holds, as a stable code (what blocks a compute host's recovery, say); never text or a value. */
  reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
}).strict();
export const computeErrorSchema = z.object({
  statusCode: z.number().int().min(400).max(599),
  code: computeErrorCodeSchema,
  message: z.string().min(1).max(500),
  requestId: z.string().min(1).max(200).optional(),
  details: computeErrorDetailsSchema,
}).strict().refine(value => value.statusCode === computeErrorCatalog[value.code].statusCode, "HTTP status must match the compute error code");
export type ComputeError = z.infer<typeof computeErrorSchema>;
export type ComputeErrorDetails = z.infer<typeof computeErrorDetailsSchema>;
/** Only trusted runtime evidence may override origin/phase/billing classification. */
export function classifyComputeError(code: ComputeErrorCode, evidence: Partial<ComputeErrorDetails> = {}): ComputeError {
  const definition = computeErrorCatalog[code];
  const { statusCode, message, ...defaults } = definition;
  return computeErrorSchema.parse({ statusCode, code, message, details: { ...defaults, ...evidence } });
}
/** The headers `computeRefusalPage` is sent with: never cached, and nothing on it may load or run. */
export const computeRefusalPageHeaders = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  "x-content-type-options": "nosniff",
});
const escapeRefusalHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
/**
 * The page a visitor's browser gets when a compute refusal answers a page of
 * an app's own site (a paused container frontend, say): the refusal's status
 * and message, plainly, with no platform branding, sign-in or "try again"
 * controls, since the message says whether waiting helps. The gateway and
 * Control send the same page, with `computeRefusalPageHeaders`.
 */
export function computeRefusalPage(
  error: Pick<ComputeError, "statusCode" | "code" | "message">,
  requestId: string,
): string {
  const title = error.statusCode === 429 ? "This site is busy right now" : "This site isn't available right now";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1.5rem;color:#222}p.code{font-size:.85em;color:#666}</style></head><body><h1>${title}</h1><p>${escapeRefusalHtml(error.message)}</p><p class="code">${escapeRefusalHtml(error.code)} · ${escapeRefusalHtml(requestId)}</p></body></html>`;
}
export function isExpectedComputeError(code: string): boolean {
  const parsed = computeErrorCodeSchema.safeParse(code);
  if (!parsed.success) return false;
  return ["app", "policy"].includes(computeErrorCatalog[parsed.data].origin);
}

export const computeExecutionStateSchema = z.enum(["queued", "preparing", "starting", "running", "retry_wait", "collecting", "cancelling", "succeeded", "failed", "timed_out", "cancelled", "outcome_unknown"]);
/**
 * Why a waiting job has not started yet, as job dispatch last found it: hosts
 * full, no host available, the account's container limit or spending limit, the
 * workload's concurrency, a pause, its previous attempt still stopping, the app
 * held by another platform operation (a deploy, say), or a temporary platform
 * problem. Null when there is no reason yet, or the job is not waiting.
 */
export const computeExecutionWaitReasonSchema = z.enum(["no_capacity", "host_unavailable", "capacity_limit", "budget", "concurrency", "paused", "previous_attempt", "app_busy", "platform_error"]);
export type ComputeExecutionWaitReason = z.infer<typeof computeExecutionWaitReasonSchema>;
export const computeWorkloadStateSchema = z.enum(["idle", "queued", "starting", "running", "ready", "unready", "draining", "paused", "blocked", "failed", "crash_loop"]);
export const computeDecimalSchema = z.string().max(39).regex(/^(0|[1-9][0-9]{0,25})(\.[0-9]{1,12})?$/, "Expected a nonnegative decimal with at most 26 integer and 12 fractional digits");
export const computeRateSchema = z.string().max(31).regex(/^(0|[1-9][0-9]{0,17})(\.[0-9]{1,12})?$/, "Expected a rate with at most 18 integer and 12 fractional digits");
export const computeCurrencySchema = z.string().regex(/^[a-z]{3}$/);
export const computeResourceUnitSchema = z.enum(["vcpu_second", "gib_memory_second", "gib_scratch_second"]);
export const computeQuantitiesSchema = z.object({
  vcpuSeconds: computeIntegerSchema,
  memoryGiBSeconds: computeIntegerSchema,
  scratchGiBSeconds: computeIntegerSchema,
}).strict();
export const computeUsagePeriodSchema = z.object({
  periodId: computeIdSchema, periodStart: computeTimestampSchema, periodEnd: computeTimestampSchema,
  priceVersionId: computeIdSchema, currency: computeCurrencySchema, quantities: computeQuantitiesSchema,
  grossEstimatedCostMinor: computeDecimalSchema, appliedCreditMinor: computeDecimalSchema, netEstimatedCostMinor: computeDecimalSchema,
}).strict().refine(value => Date.parse(value.periodEnd) > Date.parse(value.periodStart), "Usage period must have a positive duration");
export const computeUsageSchema = z.object({
  quantities: computeQuantitiesSchema,
  currency: computeCurrencySchema.nullable(),
  grossEstimatedCostMinor: computeDecimalSchema.nullable(),
  appliedCreditMinor: computeDecimalSchema.nullable(),
  netEstimatedCostMinor: computeDecimalSchema.nullable(),
  priceVersionIds: z.array(computeIdSchema).max(100),
  pendingEvidenceCount: z.number().int().nonnegative(),
  lastSettledAt: computeTimestampSchema.nullable(),
  observedAt: computeTimestampSchema,
  periods: z.array(computeUsagePeriodSchema).max(1_000).optional(),
}).strict();
export type ComputeUsage = z.infer<typeof computeUsageSchema>;
const environmentFields = { environment: z.enum(["production", "development"]), developmentSessionId: computeIdSchema.nullable() };
function environmentIssue(value: { environment: string; developmentSessionId: string | null }, context: z.RefinementCtx) {
  if ((value.environment === "development") !== (value.developmentSessionId !== null)) context.addIssue({ code: "custom", path: ["developmentSessionId"], message: "Only development requires its exact session ID" });
}
export const computeInstanceSchema = z.object({
  instanceId: computeIdSchema, revisionId: computeIdSchema, workloadName: containerNameSchema,
  kind: containerKindSchema, ...environmentFields,
  generation: z.number().int().positive(), state: computeInstanceStateSchema,
  resources: containerResourcesSchema, executionId: computeIdSchema.nullable(), attempt: z.number().int().min(1).max(5).nullable(),
  replicaSlot: z.number().int().min(0).max(19).nullable(),
  startedAt: computeTimestampSchema.nullable(), stoppedAt: computeTimestampSchema.nullable(),
  observedAt: computeTimestampSchema.nullable(), leaseExpiresAt: computeTimestampSchema.nullable(),
  error: computeErrorSchema.nullable(),
  diagnostics: computeInstanceDiagnosticsSchema.optional(),
}).strict().superRefine(environmentIssue);
export type ComputeInstance = z.infer<typeof computeInstanceSchema>;
export const computeCompletionDeliverySchema = z.object({
  state: z.enum(["not_configured", "pending", "retry_wait", "delivered", "failed", "revoked"]),
  attempts: z.number().int().min(0).max(5),
  lastAttemptAt: computeTimestampSchema.nullable(),
  nextAttemptAt: computeTimestampSchema.nullable(),
  error: computeErrorSchema.nullable(),
}).strict();
export const computeExecutionSchema = z.object({
  executionId: computeIdSchema, workloadName: containerNameSchema, revisionId: computeIdSchema,
  ...environmentFields, state: computeExecutionStateSchema,
  waitReason: computeExecutionWaitReasonSchema.nullable(),
  acceptedAt: computeTimestampSchema, queueDeadline: computeTimestampSchema,
  statusUrl: z.string().min(1).max(2_048),
  attempt: z.number().int().min(0).max(5),
  startedAt: computeTimestampSchema.nullable(), finishedAt: computeTimestampSchema.nullable(),
  executionDeadline: computeTimestampSchema.nullable(), phaseDeadline: computeTimestampSchema.nullable(),
  error: computeErrorSchema.nullable(), outputFileIds: z.array(computeIdSchema).max(16),
  completionDelivery: computeCompletionDeliverySchema, usage: computeUsageSchema,
}).strict().superRefine(environmentIssue);
export type ComputeExecution = z.infer<typeof computeExecutionSchema>;
export const computeWorkloadLimitsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("job"), startupTimeoutSeconds: z.number().int().min(1).max(300), job: containerJobPolicySchema }).strict(),
  z.object({ kind: z.literal("service"), startupTimeoutSeconds: z.number().int().min(1).max(300), service: containerServicePolicySchema }).strict(),
  z.object({ kind: z.literal("worker"), startupTimeoutSeconds: z.number().int().min(1).max(300), worker: containerWorkerPolicySchema }).strict(),
]);
export const computeHourlyEstimateSchema = z.object({ priceVersionId: computeIdSchema, currency: computeCurrencySchema, perInstanceHourMinor: computeDecimalSchema }).strict();
export const computeWorkloadSchema = z.object({
  name: containerNameSchema, kind: containerKindSchema, revisionId: computeIdSchema,
  ...environmentFields, imageDigest: computePinnedImageSchema,
  resources: containerResourcesSchema,
  limits: computeWorkloadLimitsSchema, hourlyEstimate: computeHourlyEstimateSchema.nullable(),
  state: computeWorkloadStateSchema, generation: z.number().int().positive(), paused: z.boolean(),
  pauseReason: z.enum(["manual", "budget", "authority", "crash_loop", "capacity", "deployment", "disabled"]).nullable(),
  replicaOverride: z.number().int().min(0).max(20).nullable(),
  counts: z.object({ desired: z.number().int().nonnegative(), starting: z.number().int().nonnegative(), ready: z.number().int().nonnegative(), running: z.number().int().nonnegative(), draining: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).strict(),
  instances: z.array(computeInstanceSchema).max(100),
  error: computeErrorSchema.nullable(), usage: computeUsageSchema,
  observedAt: computeTimestampSchema,
}).strict().superRefine((value, context) => {
  environmentIssue(value, context);
  if (value.kind !== value.limits.kind) context.addIssue({ code: "custom", path: ["limits", "kind"], message: "Limits must match workload kind" });
});
export type ComputeWorkload = z.infer<typeof computeWorkloadSchema>;
export const computeEventSchema = z.object({
  id: computeIdSchema, workloadName: containerNameSchema, kind: containerKindSchema,
  executionId: computeIdSchema.nullable(), instanceId: computeIdSchema.nullable(),
  revisionId: computeIdSchema, occurredAt: computeTimestampSchema,
  phase: computeErrorPhaseSchema, state: z.string().min(1).max(80),
  message: z.string().max(500), error: computeErrorSchema.nullable(),
}).strict();
export const computeJobSubmitRequestSchema = z.object({
  input: computeBoundedJsonSchema.default({}),
  inputFileIds: z.array(computeIdSchema).max(16).refine(ids => new Set(ids).size === ids.length, "Input file IDs must be unique").overwrite(ids => [...ids].sort()).default([]),
}).strict();
export type ComputeJobSubmitRequest = z.infer<typeof computeJobSubmitRequestSchema>;
export const computeControlRequestSchema = z.object({ expectedGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export const computeScaleRequestSchema = computeControlRequestSchema.extend({ replicas: z.number().int().min(0).max(20) });
// A control change commits at once; its effects show in the workload read and its events. The generation is the one to name next.
export const computeControlReceiptSchema = z.object({ workloadName: containerNameSchema, generation: z.number().int().positive(), acceptedAt: computeTimestampSchema }).strict();
const computeListFields = {
  workloadName: containerNameSchema.optional(), kind: containerKindSchema.optional(),
  from: computeTimestampSchema.optional(), to: computeTimestampSchema.optional(),
  cursor: z.string().max(2_048).optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
};
function computeRangeIssue(value: { from?: string | undefined; to?: string | undefined }, context: z.RefinementCtx) {
  if (value.from && value.to && (Date.parse(value.to) <= Date.parse(value.from) || Date.parse(value.to) - Date.parse(value.from) > 31 * 86_400_000)) context.addIssue({ code: "custom", path: ["to"], message: "Time range must be positive and at most 31 days" });
}
export const computeListQuerySchema = z.object({ ...computeListFields, state: computeExecutionStateSchema.optional() }).strict().superRefine(computeRangeIssue);
export const computeWorkloadListQuerySchema = z.object({ ...computeListFields, state: computeWorkloadStateSchema.optional() }).strict().superRefine(computeRangeIssue);
export const computeEventListQuerySchema = z.object(computeListFields).omit({ kind: true, workloadName: true }).strict().superRefine(computeRangeIssue);
export const computeWorkloadsPageSchema = z.object({ workloads: z.array(computeWorkloadSchema).max(100), nextCursor: z.string().nullable(), observedAt: computeTimestampSchema }).strict();
export const computeExecutionsPageSchema = z.object({ executions: z.array(computeExecutionSchema).max(100), nextCursor: z.string().nullable(), observedAt: computeTimestampSchema }).strict();
export const computeEventsPageSchema = z.object({ events: z.array(computeEventSchema).max(100), nextCursor: z.string().nullable(), observedAt: computeTimestampSchema }).strict();

export const computeIdempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9:._-]+$/);
export const containerRuntimeRunRequestSchema = computeJobSubmitRequestSchema.extend({ name: containerNameSchema, idempotencyKey: computeIdempotencyKeySchema });
export const containerRuntimeGetRequestSchema = z.object({ executionId: computeIdSchema }).strict();
export const containerRuntimeCancelRequestSchema = containerRuntimeGetRequestSchema.extend({ idempotencyKey: computeIdempotencyKeySchema });
const httpHeadersSchema = z.record(z.string().min(1).max(128).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), z.string().max(8_192).refine(value => !/[\r\n\0]/.test(value)))
  .refine(value => Object.keys(value).length <= 64 && new TextEncoder().encode(JSON.stringify(value)).length <= 32_768, "Headers exceed their bound");
/** A Function's request body to a service crosses the shared API process, so
 * it is capped well below a container route's 32 MiB. Responses keep 32 MiB. */
export const containerServiceRequestBodyBytes = 4 * 1024 * 1024;
export const containerServiceResponseBodyBytes = 32 * 1024 * 1024;
const maximumServiceBodyBytes = containerServiceRequestBodyBytes;
const maximumServiceBodyBase64Length = Math.ceil(maximumServiceBodyBytes / 3) * 4;
const serviceBodyBase64Schema = z.string().max(maximumServiceBodyBase64Length).superRefine((value, context) => {
  // The encoded-size check already rejects larger inputs. Avoid decoding or
  // repeated regex groups: a large valid body can exhaust a regex backtracking stack.
  if (value.length > maximumServiceBodyBase64Length) return;
  const invalid = () => context.addIssue({ code: "custom", message: "Expected canonical padded Base64" });
  if (value.length % 4 !== 0) { invalid(); return; }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const end = value.length - padding;
  for (let index = 0; index < end; index++) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47)) { invalid(); return; }
  }
  if (padding > 0) {
    const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(value[end - 1]!);
    if ((last & ((1 << (padding * 2)) - 1)) !== 0) { invalid(); return; }
  }
  if (value.length / 4 * 3 - padding > maximumServiceBodyBytes) {
    context.addIssue({ code: "too_big", origin: "string", maximum: maximumServiceBodyBytes, inclusive: true, message: "Decoded body exceeds 4 MiB" });
  }
});
export const containerRuntimeServiceRequestSchema = z.object({
  name: containerNameSchema, path: z.string().min(1).max(4_096).refine(value => value.startsWith("/") && !value.startsWith("//") && !/[\\#\u0000-\u001f\u007f]/.test(value)),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).default("GET"),
  headers: httpHeadersSchema.default({}),
  timeoutSeconds: z.number().int().min(1).max(3_600).optional(),
  bodyBase64: serviceBodyBase64Schema.optional(),
}).strict();
/**
 * A Function's `containers.request` answer is framed, not JSON, so a 32 MiB
 * body costs a Function's 150 MB about 32 MiB, not Base64 text and its parsed
 * string as well. The frame is one line of JSON (the head:
 * `containerRuntimeServiceResponseSchema`), a newline, the service's raw body,
 * and a tail of exactly `containerServiceResponseTailBytes` bytes: a newline,
 * then JSON (`containerRuntimeServiceResponseTailSchema`) padded with spaces.
 * The head's `bodyBytes` is the service's declared length, when it gave one;
 * the tail says whether the body is whole, was cut off at the 32 MiB limit,
 * or broke off because the connection to the service failed.
 */
export const containerServiceResponseContentType = "application/vnd.opencloud.service-response.v1";
export const containerServiceResponseTailBytes = 64;
export const containerRuntimeServiceResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: httpHeadersSchema,
  bodyBytes: z.number().int().min(0).max(containerServiceResponseBodyBytes).optional(),
}).strict();
export const containerRuntimeServiceResponseTailSchema = z.object({
  end: z.enum(["complete", "too_large", "failed"]),
  bodyBytes: z.number().int().min(0).max(containerServiceResponseBodyBytes),
}).strict();
export const containerRuntimeOperations = {
  run: { path: "/_opencloud/containers/run", input: containerRuntimeRunRequestSchema, output: computeExecutionSchema },
  get: { path: "/_opencloud/containers/get", input: containerRuntimeGetRequestSchema, output: computeExecutionSchema },
  cancel: { path: "/_opencloud/containers/cancel", input: containerRuntimeCancelRequestSchema, output: computeExecutionSchema },
  request: { path: "/_opencloud/containers/request", input: containerRuntimeServiceRequestSchema, output: containerRuntimeServiceResponseSchema },
} as const;

export const containerInvokeFunctionRequestSchema = z.object({
  name: computeNameSchema, input: computeBoundedJsonSchema.default({}), idempotencyKey: computeIdempotencyKeySchema,
}).strict();
export const containerInvokeFunctionResponseSchema = z.object({ result: z.json() }).strict();
export const containerRecordMetricRequestSchema = z.object({
  measurements: z.array(customMetricMeasurementSchema.extend({
    idempotencyKey: customMetricMeasurementSchema.shape.idempotencyKey.unwrap(),
    dimensions: customMetricDimensionsSchema.refine(value => Object.keys(value).length <= 8, "At most eight dimensions").default({}),
  }).strict()).min(1).max(20),
}).strict();
export const containerRecordMetricResponseSchema = z.object({ accepted: z.number().int().min(0).max(20) }).strict();
/** These capability-scoped HTTPS methods grant no Data, Files or billing access. */
export const containerCapabilityOperations = {
  invokeFunction: { path: "/_opencloud/containers/invoke-function", input: containerInvokeFunctionRequestSchema, output: containerInvokeFunctionResponseSchema },
  recordMetric: { path: "/_opencloud/containers/record-metric", input: containerRecordMetricRequestSchema, output: containerRecordMetricResponseSchema },
} as const;

export const containerRegistryHostSchema = z.string().min(1).max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/).refine(value => {
  const [hostname, port] = value.split(":");
  return Boolean(hostname && hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) && label.length <= 63)) && (!port || (Number(port) >= 1 && Number(port) <= 65_535));
}, "Expected an exact lowercase registry host and optional port");
export const containerRegistrySchema = z.object({ id: computeIdSchema, name: z.string().min(1).max(80), registryHost: containerRegistryHostSchema, createdAt: computeTimestampSchema, revokedAt: computeTimestampSchema.nullable() }).strict();
export const containerRegistryCreateSchema = containerRegistrySchema.pick({ name: true, registryHost: true }).extend({ username: z.string().min(1).max(1_024), password: z.string().min(1).max(16_384) });

export const computePriceDefinitionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  currency: computeCurrencySchema, taxBehavior: z.enum(["exclusive", "inclusive"]),
  quantumSeconds: z.literal(1), minimumSeconds: z.literal(1),
  tariffPolicyVersion: z.literal(1).default(1),
  boundaryRule: z.literal("quantum_start").default("quantum_start"),
  ratesMinorPerUnit: z.object({ vcpu_second: computeRateSchema, gib_memory_second: computeRateSchema, gib_scratch_second: computeRateSchema }).strict(),
  effectiveFrom: computeTimestampSchema,
}).strict();
export const computePriceVersionSchema = computePriceDefinitionSchema.extend({
  id: computeIdSchema, version: z.number().int().positive(),
  state: z.enum(["published", "retired"]), publishedAt: computeTimestampSchema,
});
export const computePriceDraftSchema = computePriceDefinitionSchema.extend({ revision: computeIntegerSchema, updatedAt: computeTimestampSchema });
export const computeCommercialModeSchema = z.enum(["operator", "organisation_stripe", "personal_managed"]);
export const computePayerSettingsSchema = z.object({
  payerId: computeIdSchema, enabled: z.boolean(), mode: computeCommercialModeSchema,
  currency: computeCurrencySchema, priceVersionId: computeIdSchema.nullable(),
  price: computePriceVersionSchema.nullable().optional(),
  nextPriceVersionId: computeIdSchema.nullable(), nextEffectiveAt: computeTimestampSchema.nullable(),
  monthlyLimitMinor: computeDecimalSchema.nullable(), dailyLimitMinor: computeDecimalSchema.nullable(),
  activeInstanceLimit: z.number().int().min(0).max(1_000),
  dailyTransferBytes: computeIntegerSchema,
  subscriptionState: z.enum(["not_required", "unavailable", "pending", "active", "past_due", "cancelled"]),
  consentedAt: computeTimestampSchema.nullable(),
  updatedAt: computeTimestampSchema,
}).strict();
export const computePayerSettingsUpdateSchema = z.object({
  enabled: z.boolean(),
  monthlyLimitMinor: computeDecimalSchema.nullable(), dailyLimitMinor: computeDecimalSchema.nullable(),
}).strict();
export const computePayerUsageSchema = z.object({
  payerId: computeIdSchema, from: computeTimestampSchema, to: computeTimestampSchema,
  production: computeUsageSchema, development: computeUsageSchema,
  reservedMinor: computeDecimalSchema,
  availableCreditMinor: computeDecimalSchema,
}).strict();
export type ComputePriceVersion = z.infer<typeof computePriceVersionSchema>;
export type ComputePriceDefinition = z.infer<typeof computePriceDefinitionSchema>;
export type ComputePayerSettings = z.infer<typeof computePayerSettingsSchema>;
export type ComputePayerUsage = z.infer<typeof computePayerUsageSchema>;

/** Capability declaration is independent of the actor/payer enablement checks. */
export const computeInstallationCapabilitiesSchema = z.object({
  jobs: z.boolean().default(false), services: z.boolean().default(false),
  workers: z.boolean().default(false), containerFrontend: z.boolean().default(false),
}).strip();
export type ComputeInstallationCapabilities = z.infer<typeof computeInstallationCapabilitiesSchema>;
export function unsupportedComputeCapabilities(manifest: { containers?: readonly ContainerDefinition[]; frontend: { container?: string } | { directory: string } }, capabilities: ComputeInstallationCapabilities): string[] {
  const unsupported = new Set<string>();
  for (const workload of manifest.containers ?? []) {
    const key = { job: "jobs", service: "services", worker: "workers" }[workload.kind] as "jobs" | "services" | "workers";
    if (!capabilities[key]) unsupported.add(key);
  }
  if ("container" in manifest.frontend && !capabilities.containerFrontend) unsupported.add("containerFrontend");
  return [...unsupported];
}
