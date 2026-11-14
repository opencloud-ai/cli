import { z } from "zod";

/** Version 1 is fail-closed. A peer must negotiate before sending any work. */
export const COMPUTE_PROTOCOL_VERSION = 1 as const;
export const computeProtocolVersionSchema = z.literal(COMPUTE_PROTOCOL_VERSION);
export const computeIdSchema = z.uuid();
export const computeNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export const computeSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
/** Integers remain lossless across JSON, JavaScript and PostgreSQL. */
export const computeIntegerSchema = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
export const computeTimestampSchema = z.iso.datetime({ offset: true });
export const computeKindSchema = z.enum(["job", "service", "worker"]);
export const computeEnvironmentSchema = z.enum(["production", "development"]);
export const computeResourceAllocationSchema = z.object({
  vcpu: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
  memoryMib: z.union([z.literal(1024), z.literal(2048), z.literal(4096), z.literal(8192), z.literal(16384), z.literal(32768)]),
  scratchMib: z.union([z.literal(1024), z.literal(2048), z.literal(5120), z.literal(10240), z.literal(20480)]),
}).strict();
export type ComputeResourceAllocation = z.infer<typeof computeResourceAllocationSchema>;

export const computeEnvironmentBindingSchema = z.discriminatedUnion("environment", [
  z.object({ environment: z.literal("production"), developmentSessionId: z.null() }).strict(),
  z.object({ environment: z.literal("development"), developmentSessionId: computeIdSchema }).strict(),
]);
const bindingFields = {
  installationId: computeIdSchema,
  workerId: computeIdSchema,
  workerBootId: computeIdSchema,
  appId: computeIdSchema,
  revisionId: computeIdSchema,
  instanceId: computeIdSchema,
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  policyVersion: z.literal(1),
  launchId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/),
};
export const computeInstanceBindingSchema = z.discriminatedUnion("environment", [
  computeEnvironmentBindingSchema.options[0].extend(bindingFields).strict(),
  computeEnvironmentBindingSchema.options[1].extend(bindingFields).strict(),
]);
export type ComputeInstanceBinding = z.infer<typeof computeInstanceBindingSchema>;

const noNul = z.string().refine(value => !value.includes("\0"), "NUL is forbidden");
export const computeCommandSchema = z.array(noNul.max(4_096).refine(
  value => new TextEncoder().encode(value).length <= 4_096, "Argument exceeds 4096 UTF-8 bytes",
)).max(128);
export const computeEnvironmentNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
export const computeEnvironmentValuesSchema = z.record(computeEnvironmentNameSchema, noNul.max(65_536))
  .refine(value => Object.keys(value).length <= 64, "At most 64 environment entries");
export const computeApplicationPathSchema = z.string().min(1).max(2_048).refine(value => {
  if (!value.startsWith("/") || value.startsWith("//") || /[\\?#\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    return value.split("/").every(part => {
      const decoded = decodeURIComponent(part);
      return decoded !== "." && decoded !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(decoded);
    });
  } catch { return false; }
}, "Expected an absolute application path without traversal, query or fragment");
export const computeProbeSchema = z.object({
  path: computeApplicationPathSchema,
  timeoutSeconds: z.number().int().min(1).max(5).default(2),
}).strict();
export const computeImageReferenceSchema = z.string().min(1).max(512).regex(
  /^(?:(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})?$/,
  "Expected a container image reference, without a URL scheme or credentials",
);
export const computePinnedImageSchema = computeImageReferenceSchema.refine(
  value => /@sha256:[a-f0-9]{64}$/.test(value), "Launches require an immutable sha256 image reference",
);
export const computeBoundedJsonSchema = z.json().refine(
  value => new TextEncoder().encode(JSON.stringify(value)).length <= 65_536,
  "JSON input exceeds 64 KiB",
);

/** The signature covers this lease AND the complete instance binding. */
export const computeLeaseSchema = z.object({
  leaseId: computeIdSchema,
  leaseSequence: computeIntegerSchema,
  issuedAt: computeTimestampSchema,
  expiresAt: computeTimestampSchema,
  killAfter: computeTimestampSchema,
  fundedUntil: computeTimestampSchema,
  signature: z.string().min(32).max(4_096),
}).strict().superRefine((lease, context) => {
  const issued = Date.parse(lease.issuedAt), expires = Date.parse(lease.expiresAt);
  const kill = Date.parse(lease.killAfter), funded = Date.parse(lease.fundedUntil);
  if (expires <= issued || expires - issued > 30_000) context.addIssue({ code: "custom", path: ["expiresAt"], message: "Lease must last at most 30 seconds" });
  if (kill < expires || kill - expires > 10_000) context.addIssue({ code: "custom", path: ["killAfter"], message: "Kill deadline must be within 10 seconds of expiry" });
  if (funded < kill || funded - issued > 45_000) context.addIssue({ code: "custom", path: ["fundedUntil"], message: "Funding must cover termination within a 45-second horizon" });
});
export type ComputeLease = z.infer<typeof computeLeaseSchema>;
/** Signature covers the complete binding plus allowance. It cannot outlive a live execution lease.
 * External bytes aggregate upload/download, excluding Files/image transfer. */
export const computeNetworkAllowanceSchema = z.object({
  allowanceId: computeIdSchema,
  bytes: computeIntegerSchema,
  expiresAt: computeTimestampSchema,
  throughputMbitPerSecond: z.number().int().min(1).max(100),
  signature: z.string().min(32).max(4_096),
}).strict();
export const computeOutputPolicySchema = z.object({
  directory: z.string().min(7).max(240).refine(value =>
    value.startsWith("/work/") && value !== "/work/inputs" && !value.startsWith("/work/inputs/") &&
    value.split("/").slice(1).every(part => part !== "" && part !== "." && part !== "..") &&
    !/[\\%\u0000-\u001f\u007f]/.test(value), "Outputs must be a safe subtree of /work outside inputs"),
  maxFiles: z.number().int().min(1).max(16),
  maxTotalGiB: z.number().int().min(1).max(10),
}).strict();
export const computeInputGrantSchema = z.object({
  fileId: computeIdSchema,
  contentGeneration: computeIntegerSchema.refine(value => value !== "0", "Content generation must be positive"),
  transferId: computeIdSchema,
  sizeBytes: computeIntegerSchema,
  sha256: computeSha256Schema,
  name: z.string().min(1).max(255).refine(value => !/[\u0000-\u001f\u007f]/.test(value)).optional(),
  contentType: z.string().min(1).max(200).refine(value => !/[\r\n\0]/.test(value)).optional(),
  /** Files-owned token, scoped to this pinned content and exact instance binding. */
  transferToken: z.string().min(32).max(8_192),
}).strict();
export const computeLaunchRequestSchema = z.object({
  protocolVersion: computeProtocolVersionSchema,
  binding: computeInstanceBindingSchema,
  workloadName: computeNameSchema,
  kind: computeKindSchema,
  imageDigest: computePinnedImageSchema,
  allocation: computeResourceAllocationSchema,
  allocationHash: computeSha256Schema,
  command: computeCommandSchema.optional(),
  args: computeCommandSchema.optional(),
  /** Resolved values travel only over the authenticated worker channel. Never log them. */
  env: computeEnvironmentValuesSchema.default({}),
  egress: z.enum(["internet-http", "none"]),
  startupTimeoutSeconds: z.number().int().min(1).max(300),
  lease: computeLeaseSchema,
  networkAllowance: computeNetworkAllowanceSchema,
  executionDeadline: computeTimestampSchema.nullable(),
  /** First process start anchors this duration. Retries retain the original absolute deadline. */
  executionTimeoutSeconds: z.number().int().min(1).max(86_400).nullable(),
  executionId: computeIdSchema.nullable(),
  attempt: z.number().int().min(1).max(5).nullable(),
  replicaSlot: z.number().int().min(0).max(19).nullable(),
  input: computeBoundedJsonSchema.optional(),
  inputs: z.array(computeInputGrantSchema).max(16).default([]),
  outputs: computeOutputPolicySchema.optional(),
  service: z.object({
    port: z.number().int().min(1024).max(65_535),
    concurrency: z.number().int().min(1).max(100),
    startupProbe: computeProbeSchema,
    readinessProbe: computeProbeSchema,
    livenessProbe: computeProbeSchema.optional(),
  }).strict().optional(),
  /** Opaque instance-scoped capability; never an owner credential. */
  capabilityToken: z.string().min(32).max(8_192).optional(),
}).strict().superRefine((request, context) => {
  if (request.kind === "job") {
    if (request.executionId === null || request.attempt === null || request.replicaSlot !== null) context.addIssue({ code: "custom", message: "Jobs require an execution and attempt, without a replica slot" });
    if (request.executionTimeoutSeconds === null) context.addIssue({ code: "custom", path: ["executionTimeoutSeconds"], message: "Jobs require a locally enforced execution duration" });
    if (request.attempt !== null && request.attempt > 1 && request.executionDeadline === null) context.addIssue({ code: "custom", path: ["executionDeadline"], message: "Retries retain the original first-start deadline" });
  } else if (request.executionId !== null || request.attempt !== null || request.replicaSlot === null || request.input !== undefined || request.inputs.length || request.outputs) {
    context.addIssue({ code: "custom", message: "Steady instances require a replica slot and cannot carry job input or outputs" });
  }
  if (request.kind !== "job" && (request.executionTimeoutSeconds !== null || request.executionDeadline !== null)) context.addIssue({ code: "custom", message: "Steady instances cannot carry job execution deadlines" });
  if ((request.kind === "service") !== (request.service !== undefined)) context.addIssue({ code: "custom", path: ["service"], message: "Only services require an HTTP policy" });
  if (new TextEncoder().encode(JSON.stringify({ command: request.command, args: request.args, env: request.env })).length > 65_536) context.addIssue({ code: "custom", path: ["env"], message: "Runtime configuration exceeds 64 KiB" });
});
export type ComputeLaunchRequest = z.infer<typeof computeLaunchRequestSchema>;

export const computeInstanceStateSchema = z.enum(["preparing", "starting", "running", "ready", "unready", "draining", "stopping", "stopped", "failed", "lost"]);
export const computeInspectionSchema = z.object({
  protocolVersion: computeProtocolVersionSchema,
  binding: computeInstanceBindingSchema,
  state: computeInstanceStateSchema,
  observedAt: computeTimestampSchema,
  processStartedAt: computeTimestampSchema.nullable(),
  processStoppedAt: computeTimestampSchema.nullable(),
  exitCode: z.number().int().min(0).max(255).nullable(),
  signal: z.string().regex(/^SIG[A-Z0-9]{1,20}$/).nullable(),
  oomKilled: z.boolean(),
  scratchExhausted: z.boolean(),
  stopConfirmed: z.boolean(),
  sourceSequence: computeIntegerSchema,
}).strict();
export type ComputeInspection = z.infer<typeof computeInspectionSchema>;
const requestFields = { protocolVersion: computeProtocolVersionSchema, binding: computeInstanceBindingSchema };
export const computeInspectRequestSchema = z.object(requestFields).strict();
export const computeInspectResponseSchema = z.object({ instance: computeInspectionSchema.nullable() }).strict();
export const computeLaunchResponseSchema = z.object({ instance: computeInspectionSchema, replayed: z.boolean() }).strict();
export const computeLeaseRenewRequestSchema = z.object({ ...requestFields, lease: computeLeaseSchema, networkAllowance: computeNetworkAllowanceSchema.optional(), capabilityToken: z.string().min(32).max(8_192).optional() }).strict();
export const computeLeaseRenewResponseSchema = z.object({ leaseId: computeIdSchema, expiresAt: computeTimestampSchema, accepted: z.literal(true) }).strict();
export const computeStopRequestSchema = z.object({
  ...requestFields,
  reason: z.enum(["cancelled", "lease_expired", "authority_revoked", "budget", "rollout", "scale_down", "shutdown", "liveness", "timeout"]),
  deadline: computeTimestampSchema,
}).strict();
export const computeStopResponseSchema = z.object({ instance: computeInspectionSchema, accepted: z.literal(true) }).strict();
export const computeListManagedRequestSchema = z.object({
  protocolVersion: computeProtocolVersionSchema,
  cursor: z.string().max(2_048).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
export const computeListManagedResponseSchema = z.object({
  instances: z.array(computeInspectionSchema).max(100), nextCursor: z.string().max(2_048).nullable(),
}).strict();
export const computePrepareImageRequestSchema = z.object({
  protocolVersion: computeProtocolVersionSchema,
  imageDigest: computePinnedImageSchema,
  deadline: computeTimestampSchema,
}).strict();
export const computePrepareImageResponseSchema = z.object({
  imageDigest: computePinnedImageSchema,
  compressedBytes: computeIntegerSchema.refine(value => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 5n * 1_073_741_824n),
  unpackedBytes: computeIntegerSchema.refine(value => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 10n * 1_073_741_824n),
  os: z.literal("linux"), architecture: z.literal("amd64"),
}).strict();

/** Financial authority comes from the stored binding, never a report's claimed payer. */
export const computeUsageReportSchema = z.object({
  ...requestFields,
  sourceSequence: computeIntegerSchema,
  eventType: z.enum(["started", "sample", "stopped"]),
  allocation: computeResourceAllocationSchema,
  allocationHash: computeSha256Schema,
  cumulativeElapsedNanoseconds: computeIntegerSchema,
  observedAt: computeTimestampSchema,
  processStartedAt: computeTimestampSchema,
  processStoppedAt: computeTimestampSchema.nullable(),
  exitCode: z.number().int().min(0).max(255).nullable(),
  signal: z.string().regex(/^SIG[A-Z0-9]{1,20}$/).nullable(),
}).strict().superRefine((report, context) => {
  if ((report.eventType === "stopped") !== (report.processStoppedAt !== null)) context.addIssue({ code: "custom", path: ["processStoppedAt"], message: "Only stopped evidence has a stop timestamp" });
  if (report.eventType !== "stopped" && (report.exitCode !== null || report.signal !== null)) context.addIssue({ code: "custom", message: "Nonterminal samples cannot claim an exit" });
  if (report.eventType === "started" && report.cumulativeElapsedNanoseconds !== "0") context.addIssue({ code: "custom", path: ["cumulativeElapsedNanoseconds"], message: "Start evidence begins at zero elapsed time" });
  if (report.processStoppedAt && Date.parse(report.processStoppedAt) < Date.parse(report.processStartedAt)) context.addIssue({ code: "custom", path: ["processStoppedAt"], message: "Stop precedes start" });
});
export type ComputeUsageReport = z.infer<typeof computeUsageReportSchema>;
export const computeUsageBatchSchema = z.object({ reports: z.array(computeUsageReportSchema).min(1).max(100) }).strict();
export const computeUsageAcknowledgementSchema = z.object({ accepted: z.number().int().min(0).max(100), duplicates: z.number().int().min(0).max(100) }).strict();
/** Sequence is local to the original worker boot + instance generation. New observer boots
 * authenticate their own channel, then replay the unchanged journal binding and sequence. */
export const computeCollectUsageRequestSchema = z.object({
  ...requestFields,
  afterSequence: computeIntegerSchema.nullable().default(null),
  limit: z.number().int().min(1).max(100).default(100),
}).strict();
export const computeCollectUsageResponseSchema = z.object({
  reports: z.array(computeUsageReportSchema).max(100),
  nextAfterSequence: computeIntegerSchema.nullable(),
  acknowledgedThroughSequence: computeIntegerSchema.nullable(),
}).strict();
/** Only committed, contiguous evidence can be acknowledged. Ack never creates usage. */
export const computeAcknowledgeUsageRequestSchema = z.object({
  ...requestFields, throughSequence: computeIntegerSchema,
}).strict();
export const computeAcknowledgeUsageResponseSchema = z.object({
  acknowledgedThroughSequence: computeIntegerSchema,
}).strict();

export const computeLogEnvelopeSchema = z.object({
  ...requestFields,
  sourceSequence: computeIntegerSchema,
  observedAt: computeTimestampSchema,
  stream: z.enum(["stdout", "stderr"]),
  message: z.string().max(16_384).refine(value => new TextEncoder().encode(value).length <= 16_384, "Log line exceeds 16 KiB"),
  truncated: z.boolean(),
  /** Trusted gateway correlation only; customer JSON is content. */
  requestId: z.string().min(1).max(200).nullable(),
}).strict();
export type ComputeLogEnvelope = z.infer<typeof computeLogEnvelopeSchema>;
export const computeLogBatchSchema = z.object({
  lines: z.array(computeLogEnvelopeSchema).max(100),
  gaps: z.array(z.object({
    binding: computeInstanceBindingSchema, from: computeTimestampSchema, to: computeTimestampSchema,
    droppedLines: computeIntegerSchema,
  }).strict()).max(100).default([]),
}).strict();
/** Individual measurement times survive a terminal observation assembled from
 * retained counters and freshly measured scratch. Null means unobserved. */
export const computeResourceSamplingSchema = z.object({
  phase: z.enum(["running", "terminal"]),
  cpuObservedAt: computeTimestampSchema.nullable(),
  memoryObservedAt: computeTimestampSchema.nullable(),
  peakMemoryObservedAt: computeTimestampSchema.nullable(),
  scratchObservedAt: computeTimestampSchema.nullable(),
  networkObservedAt: computeTimestampSchema.nullable(),
}).strict();
export type ComputeResourceSampling = z.infer<typeof computeResourceSamplingSchema>;
export const computeResourceSampleSchema = z.object({
  observedAt: computeTimestampSchema, cpuUsageNs: computeIntegerSchema.nullable(),
  memoryBytes: computeIntegerSchema.nullable(), peakMemoryBytes: computeIntegerSchema.nullable(),
  scratchBytes: computeIntegerSchema.nullable(),
  network: z.object({ ingressBytes: computeIntegerSchema.nullable(), egressBytes: computeIntegerSchema.nullable(), coverage: z.enum(["complete", "partial", "unavailable"]) }).strict(),
  sampling: computeResourceSamplingSchema.optional(),
}).strict().superRefine((value, context) => {
  if (!value.sampling) return;
  const counters = [
    ["cpuObservedAt", value.cpuUsageNs !== null],
    ["memoryObservedAt", value.memoryBytes !== null],
    ["peakMemoryObservedAt", value.peakMemoryBytes !== null],
    ["scratchObservedAt", value.scratchBytes !== null],
    ["networkObservedAt", value.network.ingressBytes !== null || value.network.egressBytes !== null],
  ] as const;
  for (const [field, measured] of counters) {
    const timestamp = value.sampling[field];
    if (measured !== (timestamp !== null)) context.addIssue({ code: "custom", path: ["sampling", field], message: "Measurement and timestamp must both be known or both be null" });
    if (timestamp !== null && Date.parse(timestamp) > Date.parse(value.observedAt)) context.addIssue({ code: "custom", path: ["sampling", field], message: "Measurement time cannot follow its observation" });
  }
});
export type ComputeResourceSample = z.infer<typeof computeResourceSampleSchema>;
export const computeResourceObservationSchema = computeResourceSampleSchema.safeExtend(requestFields).strict();
/** One immutable terminal receipt per binding and requestId, accepted only from trusted ingress. */
export const computeHttpObservationSchema = z.object({
  ...requestFields, requestId: z.string().min(1).max(200), observedAt: computeTimestampSchema,
  statusCode: z.number().int().min(100).max(599).nullable(),
  queueMilliseconds: z.number().finite().nonnegative(),
  durationMilliseconds: z.number().finite().nonnegative(),
  outcome: z.enum(["completed", "deadline", "client_disconnect", "revoked", "upstream_failed"]),
}).strict();
export type ComputeHttpObservation = z.infer<typeof computeHttpObservationSchema>;
/** Control authenticates ingress, then resolves workload identity from the captured instance binding. */
export const computeHttpObservationOperation = {
  method: "POST", path: "/v1/observations/http", input: computeHttpObservationSchema,
  output: z.object({ accepted: z.literal(true) }).strict(),
} as const;
/** Authoritative quota evidence is separate from best-effort diagnostic network totals. */
export const computeNetworkUsageObservationSchema = z.object({
  ...requestFields,
  sourceSequence: computeIntegerSchema,
  allowanceId: computeIdSchema,
  grantedBytes: computeIntegerSchema,
  consumedBytes: computeIntegerSchema,
  remainingBytes: computeIntegerSchema,
  expiresAt: computeTimestampSchema,
  observedAt: computeTimestampSchema,
  closedAt: computeTimestampSchema.nullable(),
  closeReason: z.enum(["expired", "revoked", "exhausted", "stopped"]).nullable(),
  fenceConfirmed: z.boolean(),
}).strict().superRefine((value, context) => {
  if ([value.grantedBytes, value.consumedBytes, value.remainingBytes].every(bytes => /^(0|[1-9][0-9]*)$/.test(bytes)) && BigInt(value.grantedBytes) !== BigInt(value.consumedBytes) + BigInt(value.remainingBytes)) context.addIssue({ code: "custom", path: ["remainingBytes"], message: "Consumed and remaining bytes must equal the signed grant" });
  if ((value.closedAt !== null) !== (value.closeReason !== null) || (value.closedAt !== null) !== value.fenceConfirmed) context.addIssue({ code: "custom", path: ["closedAt"], message: "Closing an allowance requires a reason and confirmed traffic fence" });
});
export const computeNetworkUsagePageSchema = z.object({
  observations: z.array(computeNetworkUsageObservationSchema).max(100),
  nextAfterSequence: computeIntegerSchema.nullable(),
}).strict();
export type ComputeNetworkUsageObservation = z.infer<typeof computeNetworkUsageObservationSchema>;
export type ComputeNetworkUsagePage = z.infer<typeof computeNetworkUsagePageSchema>;
export const computeWorkerHelloSchema = z.object({
  protocolVersions: z.array(computeProtocolVersionSchema).min(1).max(1),
  installationId: computeIdSchema, workerId: computeIdSchema, workerBootId: computeIdSchema,
  observedAt: computeTimestampSchema,
  clockUncertaintyMilliseconds: z.number().int().min(0).max(5_000),
  capabilities: z.object({
    operatingSystem: z.literal("linux"), architecture: z.literal("amd64"),
    sandbox: z.literal("runsc"), policyVersion: z.literal(1),
    scratchQuota: z.literal(true), egressGuard: z.literal(true), independentWatchdog: z.literal(true),
  }).strict(),
  capacity: z.object({ cpu: z.number().int().min(1).max(65_536), memoryGiB: z.number().int().min(1).max(1_048_576), scratchGiB: z.number().int().min(1).max(1_048_576), instances: z.number().int().min(1).max(10_000) }).strict(),
}).strict();
export type ComputeWorkerHello = z.infer<typeof computeWorkerHelloSchema>;

export type ComputeInspectRequest = z.infer<typeof computeInspectRequestSchema>;
export type ComputeInspectResponse = z.infer<typeof computeInspectResponseSchema>;
export type ComputeLaunchResponse = z.infer<typeof computeLaunchResponseSchema>;
export type ComputeLeaseRenewRequest = z.infer<typeof computeLeaseRenewRequestSchema>;
export type ComputeLeaseRenewResponse = z.infer<typeof computeLeaseRenewResponseSchema>;
export type ComputeStopRequest = z.infer<typeof computeStopRequestSchema>;
export type ComputeStopResponse = z.infer<typeof computeStopResponseSchema>;
export type ComputePrepareImageRequest = z.infer<typeof computePrepareImageRequestSchema>;
export type ComputePrepareImageResponse = z.infer<typeof computePrepareImageResponseSchema>;
export type ComputeListManagedRequest = z.infer<typeof computeListManagedRequestSchema>;
export type ComputeListManagedResponse = z.infer<typeof computeListManagedResponseSchema>;
export type ComputeResourceObservation = z.infer<typeof computeResourceObservationSchema>;
export type ComputeLogBatch = z.infer<typeof computeLogBatchSchema>;
export type ComputeInputGrant = z.infer<typeof computeInputGrantSchema>;
export type ComputeCollectUsageRequest = z.infer<typeof computeCollectUsageRequestSchema>;
export type ComputeCollectUsageResponse = z.infer<typeof computeCollectUsageResponseSchema>;
export type ComputeAcknowledgeUsageRequest = z.infer<typeof computeAcknowledgeUsageRequestSchema>;
export type ComputeAcknowledgeUsageResponse = z.infer<typeof computeAcknowledgeUsageResponseSchema>;

/** No Data credential is issued by this identity projection. */
export const computeCallerContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("anonymous"), userId: z.null(), functionName: z.null() }).strict(),
  z.object({ kind: z.literal("user"), userId: computeIdSchema, functionName: z.null() }).strict(),
  z.object({ kind: z.literal("function"), userId: computeIdSchema.nullable(), functionName: computeNameSchema }).strict(),
]);

/** A central slot stays held until acknowledged close or its original deadline. */
export const computeIngressGrantSchema = z.object({
  protocolVersion: computeProtocolVersionSchema,
  binding: computeInstanceBindingSchema,
  slotId: computeIdSchema,
  requestId: z.string().min(1).max(200).regex(/^[A-Za-z0-9:._-]+$/),
  workloadName: computeNameSchema,
  routeGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  gatewayId: computeIdSchema,
  caller: computeCallerContextSchema,
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  uri: z.string().min(1).max(4_096).refine(value =>
    value.startsWith("/") && !value.startsWith("//") && !/[\\#\u0000-\u001f\u007f]/.test(value), "Expected an app-relative request URI"),
  issuedAt: computeTimestampSchema,
  expiresAt: computeTimestampSchema,
  signature: z.string().min(32).max(4_096),
}).strict().superRefine((grant, context) => {
  const duration = Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt);
  if (duration <= 0 || duration > 3_600_000) context.addIssue({ code: "custom", path: ["expiresAt"], message: "Request grant must last at most one hour" });
});
export const computeIngressCloseSchema = z.object({
  protocolVersion: computeProtocolVersionSchema,
  binding: computeInstanceBindingSchema,
  slotId: computeIdSchema,
  requestId: z.string().min(1).max(200),
  closedAt: computeTimestampSchema,
  reason: z.enum(["completed", "client_disconnect", "deadline", "revoked", "drained", "upstream_failed"]),
  /** Signed by the configured worker certificate key; the gateway may only relay. */
  signature: z.string().min(32).max(4_096),
}).strict();
export type ComputeIngressGrant = z.infer<typeof computeIngressGrantSchema>;
export type ComputeIngressClose = z.infer<typeof computeIngressCloseSchema>;
export type ComputeNetworkAllowance = z.infer<typeof computeNetworkAllowanceSchema>;

/** The collector never restarts customer code. Its authority is distinct from a running lease. */
export const computeOutputCollectionRequestSchema = z.object({
  ...requestFields,
  executionId: computeIdSchema,
  attempt: z.number().int().min(1).max(5),
  publicationId: computeIdSchema,
  outputs: computeOutputPolicySchema,
  collectionDeadline: computeTimestampSchema,
  /** Files token names the winning stopped instance, generation and publication. */
  collectionToken: z.string().min(32).max(8_192),
}).strict();
export const computeOutputFileSchema = z.object({
  path: z.string().min(1).max(240).refine(value => !value.startsWith("/") && !/[\\\u0000-\u001f\u007f]/.test(value) && value.split("/").every(part => part !== "" && part !== "." && part !== "..")),
  contentType: z.string().min(1).max(200).refine(value => !/[\r\n\0]/.test(value)),
  sizeBytes: computeIntegerSchema,
  sha256: computeSha256Schema,
}).strict();
export const computeOutputCollectionResponseSchema = z.object({
  publicationId: computeIdSchema,
  state: z.enum(["collecting", "published"]),
  outputFileIds: z.array(computeIdSchema).max(16),
}).strict();
export type ComputeOutputCollectionRequest = z.infer<typeof computeOutputCollectionRequestSchema>;
export type ComputeOutputCollectionResponse = z.infer<typeof computeOutputCollectionResponseSchema>;
/** Control releases retained stopped scratch only after output disposition and committed usage. */
export const computeCleanupRequestSchema = z.object({
  ...requestFields,
  usageThroughSequence: computeIntegerSchema,
  outputPublicationId: computeIdSchema.nullable(),
}).strict();
export const computeCleanupResponseSchema = z.object({ released: z.literal(true) }).strict();
export type ComputeCleanupRequest = z.infer<typeof computeCleanupRequestSchema>;
export type ComputeCleanupResponse = z.infer<typeof computeCleanupResponseSchema>;

/** Control owns connection authorization and credential custody. Its trusted runtime
 * fetcher receives host-scoped credentials over mTLS and retains OCI bytes. Sandbox
 * launches receive only the resulting mirrored digest, never registry credentials. */
export const computeResolveImageRequestSchema = z.object({
  /** Control allocates and persists this identity before resolving a mutable tag. */
  retentionId: computeIdSchema,
  sourceReference: computeImageReferenceSchema,
  registryConnectionId: computeIdSchema.optional(),
}).strict();
export const computeResolvedImageSchema = computePrepareImageResponseSchema.extend({ retentionId: computeIdSchema });
/** Secret transport only, supplied by Control after checking connection custody and host scope. */
export const computeImageFetchRequestSchema = computeResolveImageRequestSchema.omit({ registryConnectionId: true }).extend({
  registryAuthorization: z.object({
    registryHost: z.string().min(1).max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/),
    username: z.string().min(1).max(1_024),
    password: z.string().min(1).max(16_384),
  }).strict().optional(),
}).strict();
export type ComputeResolvedImage = z.infer<typeof computeResolvedImageSchema>;
export type ComputeImageFetchRequest = z.infer<typeof computeImageFetchRequestSchema>;
export const computeReleaseImageRequestSchema = z.object({
  retentionId: computeIdSchema,
  /** Null requires an unresolved retention under the shared resolve/release lock;
   * a completed resolution must match its exact pinned digest. */
  imageDigest: computePinnedImageSchema.nullable(),
  /** Durable Control receipt proving no retained definition, release, dev or execution references. */
  proofId: computeIdSchema,
}).strict();
export const computeReleaseImageResponseSchema = z.object({ released: z.literal(true) }).strict();
export type ComputeReleaseImageRequest = z.infer<typeof computeReleaseImageRequestSchema>;
export type ComputeReleaseImageResponse = z.infer<typeof computeReleaseImageResponseSchema>;
export interface ComputeImageResolver {
  resolve(request: z.infer<typeof computeResolveImageRequestSchema>): Promise<ComputeResolvedImage>;
}
export interface ComputeImageFetcher {
  resolveAndRetain(request: ComputeImageFetchRequest): Promise<ComputeResolvedImage>;
  release(request: ComputeReleaseImageRequest): Promise<ComputeReleaseImageResponse>;
}
/** Separate installation fetcher port; worker transports cannot resolve or release images. */
export const computeImageFetcherOperations = {
  resolveAndRetain: { method: "POST", path: "/v1/images/resolve", input: computeImageFetchRequestSchema, output: computeResolvedImageSchema },
  release: { method: "POST", path: "/v1/images/release", input: computeReleaseImageRequestSchema, output: computeReleaseImageResponseSchema },
} as const;

export const CONTAINER_RUNTIME_ENV = Object.freeze({
  gatewayUrl: "OPENCLOUD_CONTAINER_GATEWAY_URL",
  capabilityToken: "OPENCLOUD_CONTAINER_CAPABILITY",
  capabilityFile: "OPENCLOUD_CONTAINER_CAPABILITY_FILE",
  instanceId: "OPENCLOUD_CONTAINER_INSTANCE_ID",
});

export type ComputeSignaturePurpose = "opencloud.compute.v1.lease" | "opencloud.compute.v1.network" | "opencloud.compute.v1.ingress" | "opencloud.compute.v1.ingress-close";
/** Control signs lease/network/ingress with its Ed25519 key. The worker signs
 * ingress-close with its configured certificate key (Ed25519 or SHA-256 RSA/EC).
 * Sign UTF-8 bytes; only the outer signature is omitted. */
export function canonicalComputeSignaturePayload(purpose: ComputeSignaturePurpose, binding: ComputeInstanceBinding, payload: object): string {
  if (!["opencloud.compute.v1.lease", "opencloud.compute.v1.network", "opencloud.compute.v1.ingress", "opencloud.compute.v1.ingress-close"].includes(purpose)) throw new TypeError("Unsupported compute signature purpose");
  const seen = new Set<object>();
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || !value || seen.has(value)) throw new TypeError("Signature payload must be finite acyclic JSON");
    seen.add(value);
    let result: unknown;
    if (Array.isArray(value)) result = value.map(canonical);
    else {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("Signature payload must contain plain JSON objects");
      result = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
    }
    seen.delete(value);
    return result;
  };
  const unsigned = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "signature"));
  return JSON.stringify(canonical({ purpose, binding: computeInstanceBindingSchema.parse(binding), payload: unsigned }));
}

/** All routes require the authenticated installation/worker transport binding. */
export const computeWorkerOperations = {
  prepareImage: { method: "POST", path: "/v1/images/prepare", input: computePrepareImageRequestSchema, output: computePrepareImageResponseSchema },
  start: { method: "POST", path: "/v1/instances/start", input: computeLaunchRequestSchema, output: computeLaunchResponseSchema },
  inspect: { method: "POST", path: "/v1/instances/inspect", input: computeInspectRequestSchema, output: computeInspectResponseSchema },
  renewLease: { method: "POST", path: "/v1/instances/lease", input: computeLeaseRenewRequestSchema, output: computeLeaseRenewResponseSchema },
  stop: { method: "POST", path: "/v1/instances/stop", input: computeStopRequestSchema, output: computeStopResponseSchema },
  listManaged: { method: "POST", path: "/v1/instances/list", input: computeListManagedRequestSchema, output: computeListManagedResponseSchema },
  collectUsage: { method: "POST", path: "/v1/instances/usage", input: computeCollectUsageRequestSchema, output: computeCollectUsageResponseSchema },
  acknowledgeUsage: { method: "POST", path: "/v1/instances/usage/acknowledge", input: computeAcknowledgeUsageRequestSchema, output: computeAcknowledgeUsageResponseSchema },
  collectOutputs: { method: "POST", path: "/v1/instances/outputs", input: computeOutputCollectionRequestSchema, output: computeOutputCollectionResponseSchema },
  observeResources: { method: "POST", path: "/v1/instances/resources", input: computeInspectRequestSchema, output: computeResourceObservationSchema.nullable() },
  cleanup: { method: "POST", path: "/v1/instances/cleanup", input: computeCleanupRequestSchema, output: computeCleanupResponseSchema },
  collectNetworkUsage: { method: "POST", path: "/v1/instances/network-usage", input: computeCollectUsageRequestSchema, output: computeNetworkUsagePageSchema },
} as const;

/** Runtime adapters implement this port; orchestration and prices belong elsewhere. */
export interface ComputeBackend {
  prepareImage(request: ComputePrepareImageRequest): Promise<ComputePrepareImageResponse>;
  start(request: ComputeLaunchRequest): Promise<ComputeLaunchResponse>;
  inspect(request: ComputeInspectRequest): Promise<ComputeInspectResponse>;
  renewLease(request: ComputeLeaseRenewRequest): Promise<ComputeLeaseRenewResponse>;
  stop(request: ComputeStopRequest): Promise<ComputeStopResponse>;
  listManaged(request: ComputeListManagedRequest): Promise<ComputeListManagedResponse>;
  collectUsage(request: ComputeCollectUsageRequest): Promise<ComputeCollectUsageResponse>;
  acknowledgeUsage(request: ComputeAcknowledgeUsageRequest): Promise<ComputeAcknowledgeUsageResponse>;
  collectOutputs(request: ComputeOutputCollectionRequest): Promise<ComputeOutputCollectionResponse>;
  observeResources(request: ComputeInspectRequest): Promise<ComputeResourceObservation | null>;
  cleanup(request: ComputeCleanupRequest): Promise<ComputeCleanupResponse>;
  collectNetworkUsage(request: ComputeCollectUsageRequest): Promise<ComputeNetworkUsagePage>;
}
