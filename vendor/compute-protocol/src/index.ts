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
/** The current ingress protocol (see COMPUTE_INGRESS_HEADERS). */
export const COMPUTE_INGRESS_PROTOCOL = 1 as const;
export const computeIngressProtocolSchema = z.number().int().min(1).max(1_000);
export const computeEnvironmentSchema = z.enum(["production", "development"]);
export const computeResourceAllocationSchema = z
  .object({
    vcpu: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
    memoryMib: z.union([
      z.literal(1024),
      z.literal(2048),
      z.literal(4096),
      z.literal(8192),
      z.literal(16384),
      z.literal(32768),
    ]),
    scratchMib: z.union([z.literal(1024), z.literal(2048), z.literal(5120), z.literal(10240), z.literal(20480)]),
  })
  .strict();
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
  launchId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/),
};
export const computeInstanceBindingSchema = z.discriminatedUnion("environment", [
  computeEnvironmentBindingSchema.options[0].extend(bindingFields).strict(),
  computeEnvironmentBindingSchema.options[1].extend(bindingFields).strict(),
]);
export type ComputeInstanceBinding = z.infer<typeof computeInstanceBindingSchema>;

const noNul = z.string().refine((value) => !value.includes("\0"), "NUL is forbidden");
export const computeCommandSchema = z
  .array(
    noNul
      .max(4_096)
      .refine((value) => new TextEncoder().encode(value).length <= 4_096, "Argument exceeds 4096 UTF-8 bytes"),
  )
  .max(128);
export const computeEnvironmentNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
export const computeEnvironmentValuesSchema = z
  .record(computeEnvironmentNameSchema, noNul.max(65_536))
  .refine((value) => Object.keys(value).length <= 64, "At most 64 environment entries");
export const computeApplicationPathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => {
    if (!value.startsWith("/") || value.startsWith("//") || /[\\?#\u0000-\u001f\u007f]/.test(value)) return false;
    try {
      return value.split("/").every((part) => {
        const decoded = decodeURIComponent(part);
        return decoded !== "." && decoded !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(decoded);
      });
    } catch {
      return false;
    }
  }, "Expected an absolute application path without traversal, query or fragment");
export const computeProbeSchema = z
  .object({
    path: computeApplicationPathSchema,
    timeoutSeconds: z.number().int().min(1).max(5).default(2),
  })
  .strict();
export const computeImageReferenceSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^(?:(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})?$/,
    "Expected a container image reference, without a URL scheme or credentials",
  );
export const computePinnedImageSchema = computeImageReferenceSchema.refine(
  (value) => /@sha256:[a-f0-9]{64}$/.test(value),
  "Launches require an immutable sha256 image reference",
);
export const computeBoundedJsonSchema = z
  .json()
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 65_536, "JSON input exceeds 64 KiB");

/**
 * A container keeps running on its last lease while the control plane can't
 * renew it, as during a platform update, then stops: SIGTERM at expiry and
 * SIGKILL at the kill deadline. Funding covers the whole lease plus that grace.
 */
export const COMPUTE_LEASE_MILLISECONDS = 300_000;
export const COMPUTE_STOP_GRACE_MILLISECONDS = 10_000;
export const COMPUTE_FUNDING_MILLISECONDS = COMPUTE_LEASE_MILLISECONDS + COMPUTE_STOP_GRACE_MILLISECONDS + 5_000;
/**
 * A running instance reports cumulative usage at most this often, and again on
 * every state change (start, stop). The charge is allocation × time, so a
 * finer cadence adds rows, not accuracy; live cost estimates lag by up to this.
 */
export const COMPUTE_USAGE_SAMPLE_MILLISECONDS = 60_000;
/** The signature covers this lease AND the complete instance binding. */
export const computeLeaseSchema = z
  .object({
    leaseId: computeIdSchema,
    leaseSequence: computeIntegerSchema,
    issuedAt: computeTimestampSchema,
    expiresAt: computeTimestampSchema,
    killAfter: computeTimestampSchema,
    fundedUntil: computeTimestampSchema,
    signature: z.string().min(32).max(4_096),
  })
  .strict()
  .superRefine((lease, context) => {
    const issued = Date.parse(lease.issuedAt),
      expires = Date.parse(lease.expiresAt);
    const kill = Date.parse(lease.killAfter),
      funded = Date.parse(lease.fundedUntil);
    if (expires <= issued || expires - issued > COMPUTE_LEASE_MILLISECONDS)
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "Lease must last at most 5 minutes" });
    if (kill < expires || kill - expires > COMPUTE_STOP_GRACE_MILLISECONDS)
      context.addIssue({
        code: "custom",
        path: ["killAfter"],
        message: "Kill deadline must be within 10 seconds of expiry",
      });
    if (funded < kill || funded - issued > COMPUTE_FUNDING_MILLISECONDS)
      context.addIssue({
        code: "custom",
        path: ["fundedUntil"],
        message: "Funding must cover termination within a 5-minute-15-second horizon",
      });
  });
export type ComputeLease = z.infer<typeof computeLeaseSchema>;
/** Signature covers the complete binding plus allowance. It cannot outlive a live execution lease.
 * External bytes aggregate upload/download, excluding Files/image transfer. */
export const computeNetworkAllowanceSchema = z
  .object({
    allowanceId: computeIdSchema,
    bytes: computeIntegerSchema,
    expiresAt: computeTimestampSchema,
    throughputMbitPerSecond: z.number().int().min(1).max(100),
    signature: z.string().min(32).max(4_096),
  })
  .strict();
export const computeOutputPolicySchema = z
  .object({
    directory: z
      .string()
      .min(7)
      .max(240)
      .refine(
        (value) =>
          value.startsWith("/work/") &&
          value !== "/work/inputs" &&
          !value.startsWith("/work/inputs/") &&
          value
            .split("/")
            .slice(1)
            .every((part) => part !== "" && part !== "." && part !== "..") &&
          !/[\\%\u0000-\u001f\u007f]/.test(value),
        "Outputs must be a safe subtree of /work outside inputs",
      ),
    maxFiles: z.number().int().min(1).max(16),
    maxTotalGiB: z.number().int().min(1).max(10),
  })
  .strict();
export const computeInputGrantSchema = z
  .object({
    fileId: computeIdSchema,
    contentGeneration: computeIntegerSchema.refine((value) => value !== "0", "Content generation must be positive"),
    transferId: computeIdSchema,
    sizeBytes: computeIntegerSchema,
    sha256: computeSha256Schema,
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
      .optional(),
    contentType: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !/[\r\n\0]/.test(value))
      .optional(),
    // No per-file token: the worker fetches each input over its mTLS lane by
    // binding, execution, current lease and transferId (POST /v1/files/input).
  })
  .strict();
export const computeLaunchRequestSchema = z
  .object({
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
    /**
     * The `env` entries that carry resolved secrets, each with its immutable
     * secret version (a development session's generated value names its
     * secret instead). The launch identity names these versions in place of
     * the values, so no stored digest can be used to guess a secret.
     */
    secretVersions: z
      .record(computeEnvironmentNameSchema, z.string().min(1).max(200))
      .refine((value) => Object.keys(value).length <= 64, "At most 64 secret entries")
      .optional(),
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
    service: z
      .object({
        port: z.number().int().min(1024).max(65_535),
        concurrency: z.number().int().min(1).max(100),
        startupProbe: computeProbeSchema,
        readinessProbe: computeProbeSchema,
        livenessProbe: computeProbeSchema.optional(),
      })
      .strict()
      .optional(),
    /** Opaque instance-scoped capability; never an owner credential. */
    capabilityToken: z.string().min(32).max(8_192).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.kind === "job") {
      if (request.executionId === null || request.attempt === null || request.replicaSlot !== null)
        context.addIssue({ code: "custom", message: "Jobs require an execution and attempt, without a replica slot" });
      if (request.executionTimeoutSeconds === null)
        context.addIssue({
          code: "custom",
          path: ["executionTimeoutSeconds"],
          message: "Jobs require a locally enforced execution duration",
        });
      if (request.attempt !== null && request.attempt > 1 && request.executionDeadline === null)
        context.addIssue({
          code: "custom",
          path: ["executionDeadline"],
          message: "Retries retain the original first-start deadline",
        });
    } else if (
      request.executionId !== null ||
      request.attempt !== null ||
      request.replicaSlot === null ||
      request.input !== undefined ||
      request.inputs.length ||
      request.outputs
    ) {
      context.addIssue({
        code: "custom",
        message: "Steady instances require a replica slot and cannot carry job input or outputs",
      });
    }
    if (request.kind !== "job" && (request.executionTimeoutSeconds !== null || request.executionDeadline !== null))
      context.addIssue({ code: "custom", message: "Steady instances cannot carry job execution deadlines" });
    if ((request.kind === "service") !== (request.service !== undefined))
      context.addIssue({ code: "custom", path: ["service"], message: "Only services require an HTTP policy" });
    if (Object.keys(request.secretVersions ?? {}).some((name) => !(name in request.env)))
      context.addIssue({ code: "custom", path: ["secretVersions"], message: "A secret version names a missing entry" });
    if (
      new TextEncoder().encode(JSON.stringify({ command: request.command, args: request.args, env: request.env }))
        .length > 65_536
    )
      context.addIssue({ code: "custom", path: ["env"], message: "Runtime configuration exceeds 64 KiB" });
  });
export type ComputeLaunchRequest = z.infer<typeof computeLaunchRequestSchema>;

/** Exact legacy launch-identity bytes, not signature canonicalization. Owners SHA256
 * this payload; Control stores the digest and the worker journals it. A secret
 * appears in it only as its version (`secretVersions`), never its value; a
 * launch without secrets keeps its legacy bytes. */
export function computeLaunchIdentityPayload(raw: unknown): string {
  const { lease, networkAllowance, capabilityToken, inputs, secretVersions, ...configuration } =
    computeLaunchRequestSchema.parse(raw);
  const secrets = Object.keys(secretVersions ?? {}).sort();
  if (!secrets.length) return JSON.stringify({ ...configuration, inputs });
  const env = Object.fromEntries(Object.entries(configuration.env).filter(([name]) => !secrets.includes(name)));
  return JSON.stringify({
    ...configuration,
    env,
    secretVersions: Object.fromEntries(secrets.map((name) => [name, secretVersions![name]!])),
    inputs,
  });
}

export const computeInstanceStateSchema = z.enum([
  "preparing",
  "starting",
  "running",
  "ready",
  "unready",
  "draining",
  "stopping",
  "stopped",
  "failed",
  "lost",
]);
/** Trusted Runtime/watchdog evidence; never derived from tenant log content. */
export const computeTerminationReasonSchema = z.enum(["timeout", "lease_expired", "startup_timeout", "liveness"]);
export type ComputeTerminationReason = z.infer<typeof computeTerminationReasonSchema>;
/** Safe catalog codes from trusted preparation, never remote text or tenant output. */
export const computePreparationErrorCodeSchema = z.enum([
  "COMPUTE_UNSUPPORTED_IMAGE",
  "COMPUTE_IMAGE_TOO_LARGE",
  "COMPUTE_IMAGE_NOT_FOUND",
  "COMPUTE_IMAGE_ACCESS_DENIED",
  "COMPUTE_IMAGE_PULL_FAILED",
  "COMPUTE_INPUT_UNAVAILABLE",
  "COMPUTE_INPUT_TRANSFER_FAILED",
  "COMPUTE_NO_CAPACITY",
  "COMPUTE_RUNTIME_UNAVAILABLE",
]);
export type ComputePreparationErrorCode = z.infer<typeof computePreparationErrorCodeSchema>;
export const computeInspectionSchema = z
  .object({
    protocolVersion: computeProtocolVersionSchema,
    binding: computeInstanceBindingSchema,
    state: computeInstanceStateSchema,
    observedAt: computeTimestampSchema,
    processStartedAt: computeTimestampSchema.nullable(),
    processStoppedAt: computeTimestampSchema.nullable(),
    exitCode: z.number().int().min(0).max(255).nullable(),
    signal: z
      .string()
      .regex(/^SIG[A-Z0-9]{1,20}$/)
      .nullable(),
    oomKilled: z.boolean(),
    scratchExhausted: z.boolean(),
    stopConfirmed: z.boolean(),
    terminationReason: computeTerminationReasonSchema.nullable().default(null),
    preparationErrorCode: computePreparationErrorCodeSchema.nullable().default(null),
    /** Durable observation sequence, independent of usage. Replays preserve the
     * complete snapshot, including observedAt, until inspection-visible facts change. */
    sourceSequence: computeIntegerSchema,
  })
  .strict()
  .superRefine((inspection, context) => {
    if (
      inspection.preparationErrorCode !== null &&
      (inspection.state !== "failed" ||
        !inspection.stopConfirmed ||
        inspection.processStartedAt !== null ||
        inspection.processStoppedAt !== null ||
        inspection.exitCode !== null ||
        inspection.signal !== null ||
        inspection.oomKilled ||
        inspection.scratchExhausted ||
        inspection.terminationReason !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["preparationErrorCode"],
        message: "Preparation errors require terminal confirmed no-start failure evidence",
      });
    }
  });
export type ComputeInspection = z.infer<typeof computeInspectionSchema>;
const requestFields = { protocolVersion: computeProtocolVersionSchema, binding: computeInstanceBindingSchema };
export const computeInspectRequestSchema = z.object(requestFields).strict();
export const computeInspectResponseSchema = z.object({ instance: computeInspectionSchema.nullable() }).strict();
export const computeLaunchResponseSchema = z
  .object({ instance: computeInspectionSchema, replayed: z.boolean() })
  .strict();
export const computeLeaseRenewRequestSchema = z
  .object({
    ...requestFields,
    lease: computeLeaseSchema,
    networkAllowance: computeNetworkAllowanceSchema.optional(),
    capabilityToken: z.string().min(32).max(8_192).optional(),
  })
  .strict();
export const computeLeaseRenewResponseSchema = z
  .object({ leaseId: computeIdSchema, expiresAt: computeTimestampSchema, accepted: z.literal(true) })
  .strict();
export const computeStopRequestSchema = z
  .object({
    ...requestFields,
    reason: z.enum([
      "cancelled",
      "lease_expired",
      "authority_revoked",
      "budget",
      "rollout",
      "scale_down",
      "shutdown",
      "liveness",
      "timeout",
    ]),
    deadline: computeTimestampSchema,
  })
  .strict();
export const computeStopResponseSchema = z
  .object({ instance: computeInspectionSchema, accepted: z.literal(true) })
  .strict();
/** Controller-only retirement metadata never contains executable configuration or secrets. */
export const computeRetireUnstartedRequestSchema = z
  .object({
    ...requestFields,
    requestHash: computeSha256Schema,
    launch: z
      .object({
        workloadName: computeNameSchema,
        kind: computeKindSchema,
        imageDigest: computePinnedImageSchema,
        allocation: computeResourceAllocationSchema,
        allocationHash: computeSha256Schema,
      })
      .strict(),
    lease: computeLeaseSchema,
    networkAllowances: z.array(computeNetworkAllowanceSchema).min(1).max(100),
  })
  .strict()
  .superRefine((request, context) => {
    const ids = new Set<string>();
    request.networkAllowances.forEach((allowance, index) => {
      if (ids.has(allowance.allowanceId))
        context.addIssue({
          code: "custom",
          path: ["networkAllowances", index, "allowanceId"],
          message: "Retirement requires unique signed allowance IDs",
        });
      ids.add(allowance.allowanceId);
    });
  });
export const computeRetireUnstartedResponseSchema = z
  .object({
    instance: computeInspectionSchema,
    retired: z.boolean(),
  })
  .strict()
  .superRefine((response, context) => {
    if (
      response.retired &&
      (!response.instance.stopConfirmed ||
        response.instance.processStartedAt !== null ||
        !["stopped", "failed"].includes(response.instance.state))
    ) {
      context.addIssue({
        code: "custom",
        path: ["retired"],
        message: "Retirement requires terminal confirmed no-start evidence",
      });
    }
  });
/** Controller-only terminal reconciliation cannot issue a lease or revive a grant. */
export const computeRetireUndeliveredAllowancesRequestSchema = z
  .object({
    ...requestFields,
    networkAllowances: z.array(computeNetworkAllowanceSchema).min(1).max(100),
  })
  .strict()
  .superRefine((request, context) => {
    const ids = new Set<string>();
    request.networkAllowances.forEach((allowance, index) => {
      if (ids.has(allowance.allowanceId))
        context.addIssue({
          code: "custom",
          path: ["networkAllowances", index, "allowanceId"],
          message: "Retirement requires unique signed allowance IDs",
        });
      ids.add(allowance.allowanceId);
    });
  });
export const computeRetireUndeliveredAllowancesResponseSchema = computeStopResponseSchema.superRefine(
  (response, context) => {
    if (!response.instance.stopConfirmed || !["stopped", "failed"].includes(response.instance.state)) {
      context.addIssue({
        code: "custom",
        path: ["instance"],
        message: "Allowance retirement requires confirmed terminal stop evidence",
      });
    }
  },
);
export const computeListManagedRequestSchema = z
  .object({
    protocolVersion: computeProtocolVersionSchema,
    cursor: z.string().max(2_048).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export const computeListManagedResponseSchema = z
  .object({
    instances: z.array(computeInspectionSchema).max(100),
    nextCursor: z.string().max(2_048).nullable(),
  })
  .strict();
export const computePrepareImageRequestSchema = z
  .object({
    protocolVersion: computeProtocolVersionSchema,
    imageDigest: computePinnedImageSchema,
    deadline: computeTimestampSchema,
  })
  .strict();
export const computePrepareImageResponseSchema = z
  .object({
    imageDigest: computePinnedImageSchema,
    compressedBytes: computeIntegerSchema.refine(
      (value) => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 5n * 1_073_741_824n,
    ),
    unpackedBytes: computeIntegerSchema.refine(
      (value) => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 10n * 1_073_741_824n,
    ),
    os: z.literal("linux"),
    architecture: z.literal("amd64"),
  })
  .strict();

/** Financial authority comes from the stored binding, never a report's claimed payer. */
export const computeUsageReportSchema = z
  .object({
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
    signal: z
      .string()
      .regex(/^SIG[A-Z0-9]{1,20}$/)
      .nullable(),
  })
  .strict()
  .superRefine((report, context) => {
    if ((report.eventType === "stopped") !== (report.processStoppedAt !== null))
      context.addIssue({
        code: "custom",
        path: ["processStoppedAt"],
        message: "Only stopped evidence has a stop timestamp",
      });
    if (report.eventType !== "stopped" && (report.exitCode !== null || report.signal !== null))
      context.addIssue({ code: "custom", message: "Nonterminal samples cannot claim an exit" });
    if (report.eventType === "started" && report.cumulativeElapsedNanoseconds !== "0")
      context.addIssue({
        code: "custom",
        path: ["cumulativeElapsedNanoseconds"],
        message: "Start evidence begins at zero elapsed time",
      });
    if (report.processStoppedAt && Date.parse(report.processStoppedAt) < Date.parse(report.processStartedAt))
      context.addIssue({ code: "custom", path: ["processStoppedAt"], message: "Stop precedes start" });
  });
export type ComputeUsageReport = z.infer<typeof computeUsageReportSchema>;
export const computeUsageBatchSchema = z
  .object({ reports: z.array(computeUsageReportSchema).min(1).max(100) })
  .strict();
export const computeUsageAcknowledgementSchema = z
  .object({ accepted: z.number().int().min(0).max(100), duplicates: z.number().int().min(0).max(100) })
  .strict();
/** Sequence is local to the original worker boot + instance generation. New observer boots
 * authenticate their own channel, then replay the unchanged journal binding and sequence. */
export const computeCollectUsageRequestSchema = z
  .object({
    ...requestFields,
    afterSequence: computeIntegerSchema.nullable().default(null),
    limit: z.number().int().min(1).max(100).default(100),
  })
  .strict();
export const computeCollectUsageResponseSchema = z
  .object({
    reports: z.array(computeUsageReportSchema).max(100),
    nextAfterSequence: computeIntegerSchema.nullable(),
    acknowledgedThroughSequence: computeIntegerSchema.nullable(),
  })
  .strict();
/** Only committed, contiguous evidence can be acknowledged. Ack never creates usage. */
export const computeAcknowledgeUsageRequestSchema = z
  .object({
    ...requestFields,
    throughSequence: computeIntegerSchema,
  })
  .strict();
export const computeAcknowledgeUsageResponseSchema = z
  .object({
    acknowledgedThroughSequence: computeIntegerSchema,
  })
  .strict();

export const computeLogEnvelopeSchema = z
  .object({
    ...requestFields,
    sourceSequence: computeIntegerSchema,
    observedAt: computeTimestampSchema,
    stream: z.enum(["stdout", "stderr"]),
    message: z
      .string()
      .max(16_384)
      .refine((value) => new TextEncoder().encode(value).length <= 16_384, "Log line exceeds 16 KiB"),
    truncated: z.boolean(),
    /** Trusted gateway correlation only; customer JSON is content. */
    requestId: z.string().min(1).max(200).nullable(),
  })
  .strict();
export type ComputeLogEnvelope = z.infer<typeof computeLogEnvelopeSchema>;
export const computeLogBatchSchema = z
  .object({
    lines: z.array(computeLogEnvelopeSchema).max(100),
    gaps: z
      .array(
        z
          .object({
            binding: computeInstanceBindingSchema,
            from: computeTimestampSchema,
            to: computeTimestampSchema,
            droppedLines: computeIntegerSchema,
            /** `quota`: the instance exceeded its accepted log rate. Absent: the platform lost the lines. */
            reason: z.literal("quota").optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
/** Individual measurement times survive a terminal observation assembled from
 * retained counters and freshly measured scratch. Null means unobserved. */
export const computeResourceSamplingSchema = z
  .object({
    phase: z.enum(["running", "terminal"]),
    cpuObservedAt: computeTimestampSchema.nullable(),
    memoryObservedAt: computeTimestampSchema.nullable(),
    peakMemoryObservedAt: computeTimestampSchema.nullable(),
    scratchObservedAt: computeTimestampSchema.nullable(),
    networkObservedAt: computeTimestampSchema.nullable(),
  })
  .strict();
export type ComputeResourceSampling = z.infer<typeof computeResourceSamplingSchema>;
export const computeResourceSampleSchema = z
  .object({
    observedAt: computeTimestampSchema,
    cpuUsageNs: computeIntegerSchema.nullable(),
    memoryBytes: computeIntegerSchema.nullable(),
    peakMemoryBytes: computeIntegerSchema.nullable(),
    scratchBytes: computeIntegerSchema.nullable(),
    network: z
      .object({
        ingressBytes: computeIntegerSchema.nullable(),
        egressBytes: computeIntegerSchema.nullable(),
        coverage: z.enum(["complete", "partial", "unavailable"]),
      })
      .strict(),
    sampling: computeResourceSamplingSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
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
      if (measured !== (timestamp !== null))
        context.addIssue({
          code: "custom",
          path: ["sampling", field],
          message: "Measurement and timestamp must both be known or both be null",
        });
      if (timestamp !== null && Date.parse(timestamp) > Date.parse(value.observedAt))
        context.addIssue({
          code: "custom",
          path: ["sampling", field],
          message: "Measurement time cannot follow its observation",
        });
    }
  });
export type ComputeResourceSample = z.infer<typeof computeResourceSampleSchema>;
export const computeResourceObservationSchema = computeResourceSampleSchema.safeExtend(requestFields).strict();
/** One immutable terminal receipt per binding and requestId, accepted only from trusted ingress. */
export const computeHttpObservationSchema = z
  .object({
    ...requestFields,
    requestId: z.string().min(1).max(200),
    observedAt: computeTimestampSchema,
    statusCode: z.number().int().min(100).max(599).nullable(),
    queueMilliseconds: z.number().finite().nonnegative(),
    durationMilliseconds: z.number().finite().nonnegative(),
    outcome: z.enum(["completed", "deadline", "client_disconnect", "revoked", "upstream_failed"]),
  })
  .strict();
export type ComputeHttpObservation = z.infer<typeof computeHttpObservationSchema>;
/** Control authenticates ingress, then resolves workload identity from the captured instance binding. */
export const computeHttpObservationOperation = {
  method: "POST",
  path: "/v1/observations/http",
  input: computeHttpObservationSchema,
  output: z.object({ accepted: z.literal(true) }).strict(),
} as const;
/** At most this many items travel in one batch call. */
export const COMPUTE_BATCH_LIMIT = 100;
/**
 * One result per input item, in input order. Control checks and applies each
 * item on its own, so one bad item never holds back the rest: `accepted` and
 * `rejected` (a permanent refusal, such as a revoked binding or a malformed
 * item) are final and the sender drops the item; `retry` keeps it queued.
 */
export const computeBatchResultSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            outcome: z.enum(["accepted", "rejected", "retry"]),
            code: z
              .string()
              .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
              .optional(),
          })
          .strict(),
      )
      .max(COMPUTE_BATCH_LIMIT),
  })
  .strict();
export type ComputeBatchResult = z.infer<typeof computeBatchResultSchema>;
/** Terminal HTTP observations from the gateway; each item is a `computeHttpObservationSchema`. */
export const computeHttpObservationBatchOperation = {
  method: "POST",
  path: "/v1/observations/http-batch",
  input: z
    .object({
      protocolVersion: computeProtocolVersionSchema,
      observations: z.array(z.unknown()).min(1).max(COMPUTE_BATCH_LIMIT),
    })
    .strict(),
  output: computeBatchResultSchema,
} as const;
const networkUsageObservationFields = {
  ...requestFields,
  sourceSequence: computeIntegerSchema,
  allowanceId: computeIdSchema,
  grantedBytes: computeIntegerSchema,
  expiresAt: computeTimestampSchema,
  observedAt: computeTimestampSchema,
};
const measuredNetworkUsageObservationSchema = z
  .object({
    ...networkUsageObservationFields,
    accounting: z.literal("measured").optional(),
    consumedBytes: computeIntegerSchema,
    remainingBytes: computeIntegerSchema,
    closedAt: computeTimestampSchema.nullable(),
    closeReason: z.enum(["expired", "revoked", "exhausted", "stopped"]).nullable(),
    fenceConfirmed: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      [value.grantedBytes, value.consumedBytes, value.remainingBytes].every((bytes) =>
        /^(0|[1-9][0-9]*)$/.test(bytes),
      ) &&
      BigInt(value.grantedBytes) !== BigInt(value.consumedBytes) + BigInt(value.remainingBytes)
    )
      context.addIssue({
        code: "custom",
        path: ["remainingBytes"],
        message: "Consumed and remaining bytes must equal the signed grant",
      });
    if (
      (value.closedAt !== null) !== (value.closeReason !== null) ||
      (value.closedAt !== null) !== value.fenceConfirmed
    )
      context.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "Closing an allowance requires a reason and confirmed traffic fence",
      });
  });
const forfeitedNetworkUsageObservationSchema = z
  .object({
    ...networkUsageObservationFields,
    accounting: z.literal("forfeited"),
    consumedBytes: z.null(),
    remainingBytes: z.null(),
    quotaForfeitedBytes: computeIntegerSchema,
    closedAt: computeTimestampSchema,
    closeReason: z.literal("counter_lost"),
    fenceConfirmed: z.literal(true),
    fenceEvidence: z.literal("retired_allowance"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.quotaForfeitedBytes !== value.grantedBytes)
      context.addIssue({
        code: "custom",
        path: ["quotaForfeitedBytes"],
        message: "Lost counters forfeit the entire signed grant against daily quota",
      });
  });
const unusedNetworkUsageObservationSchema = z
  .object({
    ...networkUsageObservationFields,
    accounting: z.literal("unused"),
    consumedBytes: z.literal("0"),
    remainingBytes: computeIntegerSchema,
    closedAt: computeTimestampSchema,
    closeReason: z.literal("never_started"),
    fenceConfirmed: z.literal(true),
    fenceEvidence: z.literal("durable_no_start"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.remainingBytes !== value.grantedBytes)
      context.addIssue({
        code: "custom",
        path: ["remainingBytes"],
        message: "A never-started allowance retains the entire signed grant",
      });
  });
const neverAdmittedNetworkUsageObservationSchema = z
  .object({
    ...networkUsageObservationFields,
    accounting: z.literal("unused"),
    consumedBytes: z.literal("0"),
    remainingBytes: computeIntegerSchema,
    closedAt: computeTimestampSchema,
    closeReason: z.literal("never_admitted"),
    fenceConfirmed: z.literal(true),
    fenceEvidence: z.literal("durable_grant_non_admission"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.remainingBytes !== value.grantedBytes)
      context.addIssue({
        code: "custom",
        path: ["remainingBytes"],
        message: "A never-admitted allowance retains the entire signed grant",
      });
  });
const stoppedInstanceNetworkUsageObservationSchema = z
  .object({
    ...networkUsageObservationFields,
    accounting: z.literal("forfeited"),
    consumedBytes: z.null(),
    remainingBytes: z.null(),
    quotaForfeitedBytes: computeIntegerSchema,
    closedAt: computeTimestampSchema,
    closeReason: z.literal("counter_unavailable"),
    fenceConfirmed: z.literal(true),
    fenceEvidence: z.literal("stopped_instance"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.quotaForfeitedBytes !== value.grantedBytes)
      context.addIssue({
        code: "custom",
        path: ["quotaForfeitedBytes"],
        message: "Unavailable counters forfeit the entire signed grant against daily quota",
      });
  });
/** Authoritative quota evidence is separate from diagnostic bytes and monetary usage.
 * Unknown counters require explicit guard-retired or terminal instance fence evidence. */
export const computeNetworkUsageObservationSchema = z.union([
  measuredNetworkUsageObservationSchema,
  forfeitedNetworkUsageObservationSchema,
  unusedNetworkUsageObservationSchema,
  neverAdmittedNetworkUsageObservationSchema,
  stoppedInstanceNetworkUsageObservationSchema,
]);
export const computeNetworkUsagePageSchema = z
  .object({
    observations: z.array(computeNetworkUsageObservationSchema).max(100),
    nextAfterSequence: computeIntegerSchema.nullable(),
  })
  .strict();
export type ComputeNetworkUsageObservation = z.infer<typeof computeNetworkUsageObservationSchema>;
export type ComputeNetworkUsagePage = z.infer<typeof computeNetworkUsagePageSchema>;
export const computeWorkerHelloSchema = z
  .object({
    protocolVersions: z.array(computeProtocolVersionSchema).min(1).max(1),
    installationId: computeIdSchema,
    workerId: computeIdSchema,
    workerBootId: computeIdSchema,
    observedAt: computeTimestampSchema,
    clockUncertaintyMilliseconds: z.number().int().min(0).max(5_000),
    capabilities: z
      .object({
        operatingSystem: z.literal("linux"),
        architecture: z.literal("amd64"),
        sandbox: z.literal("runsc"),
        policyVersion: z.literal(1),
        scratchQuota: z.literal(true),
        egressGuard: z.literal(true),
        independentWatchdog: z.literal(true),
        /** Ingress protocol versions this worker serves; absent before versioning. */
        ingressProtocols: z.array(computeIngressProtocolSchema).min(1).max(8).optional(),
      })
      .strict(),
    capacity: z
      .object({
        cpu: z.number().int().min(1).max(65_536),
        memoryGiB: z.number().int().min(1).max(1_048_576),
        scratchGiB: z.number().int().min(1).max(1_048_576),
        instances: z.number().int().min(1).max(10_000),
      })
      .strict(),
  })
  .strict();
export type ComputeWorkerHello = z.infer<typeof computeWorkerHelloSchema>;

/** A fresh challenge requests evidence only; it never changes host admission. */
export const computeProveHostQuiescenceRequestSchema = z
  .object({
    protocolVersion: computeProtocolVersionSchema,
    installationId: computeIdSchema,
    workerId: computeIdSchema,
    workerBootId: computeIdSchema,
    challengeId: computeIdSchema,
  })
  .strict();
export const computeProveHostQuiescenceResponseSchema = computeProveHostQuiescenceRequestSchema
  .extend({
    hostBootId: computeIdSchema,
    observedAt: computeTimestampSchema,
    expiresAt: computeTimestampSchema,
    // A preview may run an uncommitted build; it says so rather than naming a
    // commit it doesn't match. Releases always carry the exact commit.
    configSha256: computeSha256Schema,
    sourceRevision: z.string().regex(/^[a-f0-9]{40}(-dirty)?$/),
    journal: z
      .object({
        sha256: computeSha256Schema,
        headHash: computeSha256Schema,
        records: z.number().int().min(0).max(1_000_000),
        /** Every instance the journal ever held, as Control counts its history. */
        cleanedInstances: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        /** Of those, cleaned instances dropped from the journal after their
         * retention window; only the rest have retained records. */
        droppedInstances: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      })
      .strict(),
    daemon: z
      .object({
        id: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[\x20-\x7e]+$/),
        inventoryScope: z.literal("all_containers_in_dedicated_daemon"),
        containers: z.array(z.never()).length(0),
      })
      .strict(),
    guard: z
      .object({
        revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        policySha256: computeSha256Schema,
        receiptSha256: computeSha256Schema,
        hostBootId: computeIdSchema,
        workerBootId: computeIdSchema,
        activeInstances: z.literal(0),
        unacknowledgedRetiredAllowances: z.literal(0),
        remainingAllowanceRecords: z.literal(0),
      })
      .strict(),
    safety: z
      .object({
        watchdogObservedMonotonicNs: computeIntegerSchema,
        workerPid: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        workerStartTicks: computeIntegerSchema,
      })
      .strict(),
    preparationCount: z.literal(0),
    tails: z
      .object({
        usage: z.literal(0),
        network: z.literal(0),
        resources: z.literal(0),
        ingressClose: z.literal(0),
        liveSlotReservations: z.literal(0),
      })
      .strict(),
    logs: z
      .object({
        pendingBatches: z.literal(0),
        pendingGaps: z.literal(0),
        historicalCoverageLost: z.boolean().nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((proof, context) => {
    const duration = Date.parse(proof.expiresAt) - Date.parse(proof.observedAt);
    if (duration <= 0 || duration > 5_000)
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Host proof must expire within five seconds of observation",
      });
    for (const field of ["hostBootId", "workerBootId"] as const) {
      if (proof.guard[field] !== proof[field])
        context.addIssue({
          code: "custom",
          path: ["guard", field],
          message: "Guard and host proof must name the same boot",
        });
    }
    if (
      proof.journal.droppedInstances > proof.journal.cleanedInstances ||
      proof.journal.cleanedInstances - proof.journal.droppedInstances > proof.journal.records
    )
      context.addIssue({
        code: "custom",
        path: ["journal", "cleanedInstances"],
        message: "Retained cleaned instances require retained journal records",
      });
  });
export type ComputeProveHostQuiescenceRequest = z.infer<typeof computeProveHostQuiescenceRequestSchema>;
export type ComputeProveHostQuiescenceResponse = z.infer<typeof computeProveHostQuiescenceResponseSchema>;

/** Required live consumer check, after authenticating the transport. The schema
 * alone stays deterministic for audit replay; no clock tolerance grants authority. */
/**
 * Why a worker refused to prove its host quiescent, as it says in its refusal's
 * `details.reason`: a closed list of stable codes, so an authenticated worker
 * still can't put its own text into Control's answer or logs. The runtime's
 * own refusals come first, then each check of the host capture.
 */
export const computeHostQuiescenceRefusalReasonSchema = z.enum([
  "worker_starting",
  "quiescence_capture_unavailable",
  "admission_pending",
  "instance_operation_pending",
  "preparation_pending",
  "network_delivery_pending",
  "resource_delivery_pending",
  "host_identity_mismatch",
  "proof_invalid",
  "capture_failed",
  "background_delivery_pending",
  "log_mutation_pending",
  "ingress_delivery_pending",
  "allowance_identity",
  "allowance_retirement_conflict",
  "allowance_retirement_disposition",
  "allowance_retirement_identity",
  "allowance_retirement_shape",
  "close_ack_identity",
  "configuration_identity",
  "daemon_changed_during_capture",
  "daemon_inventory_not_empty",
  "dedicated_daemon_identity",
  "duplicate_allowance_retirement",
  "guard_policy_not_empty",
  "guard_receipt_not_empty",
  "guard_state_not_acknowledged",
  "health_timestamp",
  "hex",
  "host_boot_identity",
  "host_changed_during_capture",
  "ingress_close_pending",
  "instance_bound",
  "instance_meter_cursor",
  "instance_not_cleaned",
  "journal_binding",
  "journal_payload",
  "journal_record_bound",
  "log_delivery_or_unknown_file_pending",
  "missing_config",
  "missing_final_usage",
  "missing_resource_observation",
  "network_identity",
  "network_not_fenced",
  "network_settlement",
  "orphan_journal_evidence",
  "orphan_network_evidence",
  "resource_ack_identity",
  "resource_observation_pending",
  "retention_summary",
  "slot_identity",
  "slot_receipt_or_deadline_pending",
  "stale_host_evidence",
  "state_file_bound_or_type",
  "state_file_growth",
  "unknown_journal_record",
  "unknown_start_evidence",
  "usage_not_acknowledged",
  "usage_replay_conflict",
  "usage_sequence",
  "usage_tail_or_binding",
  "watchdog_identity",
  "worker_health_identity",
  "worker_log_health",
]);
export type ComputeHostQuiescenceRefusalReason = z.infer<typeof computeHostQuiescenceRefusalReasonSchema>;

export function validateComputeHostQuiescenceProof(
  request: unknown,
  response: unknown,
  nowMilliseconds: number,
): ComputeProveHostQuiescenceResponse {
  const expected = computeProveHostQuiescenceRequestSchema.parse(request);
  const proof = computeProveHostQuiescenceResponseSchema.parse(response);
  for (const field of ["protocolVersion", "installationId", "workerId", "workerBootId", "challengeId"] as const) {
    if (proof[field] !== expected[field]) throw new Error("Host proof does not match its request");
  }
  if (
    !Number.isFinite(nowMilliseconds) ||
    Date.parse(proof.observedAt) > nowMilliseconds ||
    nowMilliseconds >= Date.parse(proof.expiresAt)
  ) {
    throw new Error("Host proof is not current");
  }
  return proof;
}

export type ComputeInspectRequest = z.infer<typeof computeInspectRequestSchema>;
export type ComputeInspectResponse = z.infer<typeof computeInspectResponseSchema>;
export type ComputeLaunchResponse = z.infer<typeof computeLaunchResponseSchema>;
export type ComputeLeaseRenewRequest = z.infer<typeof computeLeaseRenewRequestSchema>;
export type ComputeLeaseRenewResponse = z.infer<typeof computeLeaseRenewResponseSchema>;
export type ComputeStopRequest = z.infer<typeof computeStopRequestSchema>;
export type ComputeStopResponse = z.infer<typeof computeStopResponseSchema>;
export type ComputeRetireUnstartedRequest = z.infer<typeof computeRetireUnstartedRequestSchema>;
export type ComputeRetireUnstartedResponse = z.infer<typeof computeRetireUnstartedResponseSchema>;
export type ComputeRetireUndeliveredAllowancesRequest = z.infer<typeof computeRetireUndeliveredAllowancesRequestSchema>;
export type ComputeRetireUndeliveredAllowancesResponse = z.infer<
  typeof computeRetireUndeliveredAllowancesResponseSchema
>;
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
  z
    .object({ kind: z.literal("function"), userId: computeIdSchema.nullable(), functionName: computeNameSchema })
    .strict(),
]);

/**
 * Ingress protocol versions. A worker lists the versions it serves in `hello`
 * (`capabilities.ingressProtocols`); the gateway names the one it speaks on
 * every proxied request and routes only to hosts that list it. A worker
 * refuses any other with COMPUTE_PROTOCOL_UNSUPPORTED. Version 1: Control-signed
 * route intents, per-instance route grants and worker-side concurrency.
 */
export const COMPUTE_INGRESS_HEADERS = Object.freeze({
  protocol: "x-opencloud-compute-ingress",
  intent: "x-opencloud-compute-intent",
  route: "x-opencloud-compute-route",
  request: "x-opencloud-compute-request",
});
const computeMethodSchema = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const computeAppUriSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => value.startsWith("/") && !value.startsWith("//") && !/[\\#\u0000-\u001f\u007f]/.test(value),
    "Expected an app-relative request URI",
  );
const computeGenerationSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/**
 * A route intent: Control's per-request authority decision, signed with its
 * Ed25519 key as `<base64url JSON>.<base64url signature>`. The edge (or Control
 * itself, for health checks and Function requests) obtains one per request;
 * the gateway and the worker verify it with Control's public key. It must be
 * admitted before `expiresAt` and the request ends by `requestDeadline`. The
 * nonce makes it single use: the gateway and each worker refuse a nonce they
 * have seen until the intent expires. `authority` is Control's own (the
 * caller's retained authority, or a health check's operation), which it
 * rechecks for long-lived streams; the gateway and worker never interpret it.
 */
export const computeRouteIntentSchema = z
  .object({
    purpose: z.literal("opencloud.compute.v1.route"),
    ingressProtocol: z.literal(COMPUTE_INGRESS_PROTOCOL),
    appId: computeIdSchema,
    environment: computeEnvironmentSchema,
    developmentSessionId: computeIdSchema.nullable(),
    revisionId: computeIdSchema,
    sourceId: computeIdSchema,
    workloadName: computeNameSchema,
    routeGeneration: computeGenerationSchema,
    /** Health checks may reach a deploy's candidate copies; ordinary requests never. */
    candidate: z.boolean(),
    method: computeMethodSchema,
    uri: computeAppUriSchema,
    caller: computeCallerContextSchema,
    forwardAuthorization: z.boolean(),
    authority: z.record(z.string(), z.unknown()),
    nonce: computeIdSchema,
    issuedAt: computeTimestampSchema,
    requestDeadline: computeTimestampSchema,
    expiresAt: computeTimestampSchema,
  })
  .strict()
  .superRefine((intent, context) => {
    const issued = Date.parse(intent.issuedAt),
      admission = Date.parse(intent.expiresAt) - issued,
      request = Date.parse(intent.requestDeadline) - issued;
    if (admission <= 0 || admission > 60_000 || request < admission || request > 3_600_000)
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "Route intent deadlines are out of bounds" });
  });
export type ComputeRouteIntent = z.infer<typeof computeRouteIntentSchema>;
/** Splits a Control-signed token into its signed body and signature, without
 * verifying anything; callers verify the signature with Control's public key. */
export function splitComputeToken(token: string): { body: string; signature: string } | null {
  if (token.length > 16_384) return null;
  const [body, signature, extra] = token.split(".");
  if (
    !body ||
    !signature ||
    extra !== undefined ||
    !/^[A-Za-z0-9_-]+$/.test(body) ||
    !/^[A-Za-z0-9_-]+$/.test(signature)
  )
    return null;
  return { body, signature };
}
/**
 * A per-instance route grant, issued with every route table: Control attests
 * that this exact instance serves this route generation until `expiresAt`. The
 * gateway forwards it with each request; the worker accepts a request only if
 * the grant names its instance and the intent's app, revision and route
 * generation match it. Signed with purpose `opencloud.compute.v1.route-grant`.
 * A candidate copy (a deploy's, before publication) takes only intents that
 * may reach candidates.
 */
export const computeRouteGrantSchema = z
  .object({
    protocolVersion: computeProtocolVersionSchema,
    binding: computeInstanceBindingSchema,
    workloadName: computeNameSchema,
    routeGeneration: computeGenerationSchema,
    candidate: z.boolean(),
    concurrency: z.number().int().min(1).max(1_000),
    issuedAt: computeTimestampSchema,
    expiresAt: computeTimestampSchema,
    signature: z.string().min(32).max(4_096),
  })
  .strict()
  .superRefine((grant, context) => {
    const duration = Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt);
    if (duration <= 0 || duration > 120_000)
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "Route grants last at most two minutes" });
  });
export type ComputeRouteGrant = z.infer<typeof computeRouteGrantSchema>;
/** One revision in the gateway's table: the workload's active and pending
 * (candidate) revisions, even without instances, and a retired revision while
 * copies of it still drain. Only `ready` instances of an active or candidate
 * revision take new requests; `draining` ones (draining, unready or on a
 * draining host, but not stopped) keep their open streams. */
export const computeRouteRevisionSchema = z
  .object({
    revisionId: computeIdSchema,
    appId: computeIdSchema,
    environment: computeEnvironmentSchema,
    developmentSessionId: computeIdSchema.nullable(),
    workloadName: computeNameSchema,
    routeGeneration: computeGenerationSchema,
    serving: z.enum(["active", "candidate", "retired"]),
    paused: z.boolean(),
    /** Why no copy of an active revision can be placed now, when that is the
     * platform's: every host down, quarantined or out of contact, or every
     * host full. A request that waits its admission deadline without a ready
     * copy is answered with it (nothing billed), not as a slow start. */
    unavailable: z.enum(["COMPUTE_HOST_UNAVAILABLE", "COMPUTE_NO_CAPACITY"]).optional(),
    concurrency: z.number().int().min(1).max(1_000),
    instances: z
      .array(
        z
          .object({
            state: z.enum(["ready", "draining"]),
            endpoint: z.url(),
            ingressProtocols: z.array(computeIngressProtocolSchema).max(8),
            grant: computeRouteGrantSchema,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type ComputeRouteRevision = z.infer<typeof computeRouteRevisionSchema>;
/**
 * The gateway's routing table. The gateway asks again at least every couple of
 * seconds, passing the `signal` it last saw; Control answers at once when its
 * routes changed since (publication, pause, fence, drain, readiness), or after
 * a short wait otherwise. `signingKeys` verify route intents.
 */
export const computeRouteTableOperation = {
  method: "POST",
  path: "/v1/ingress/routes",
  input: z
    .object({
      protocolVersion: computeProtocolVersionSchema,
      ingressProtocols: z.array(computeIngressProtocolSchema).min(1).max(8),
      after: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  output: z
    .object({
      protocolVersion: computeProtocolVersionSchema,
      signal: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      generatedAt: computeTimestampSchema,
      signingKeys: z.array(z.string().min(1).max(4_096)).min(1).max(2),
      revisions: z.array(computeRouteRevisionSchema).max(5_000),
    })
    .strict(),
} as const;
export type ComputeRouteTable = z.infer<typeof computeRouteTableOperation.output>;
export type ComputeRouteCopy = ComputeRouteRevision["instances"][number];
export type ComputeRouteDecision =
  | { kind: "route"; copies: ComputeRouteCopy[] }
  /** `starting`: no ready copy yet (a wakeup); `stale`: the table predates the intent. */
  | { kind: "wait"; reason: "starting" | "stale" }
  | {
      kind: "refuse";
      code: "COMPUTE_REVISION_UNAVAILABLE" | "COMPUTE_SERVICE_UNAVAILABLE" | "COMPUTE_AUTHORITY_REVOKED";
    };
/**
 * How a gateway treats a verified route intent against its table: route it to
 * one of the copies listed, wait (for a cold start, or for a table newer than
 * the intent), or refuse it. A table generated after the intent was issued is
 * authoritative: a revision missing from it, or whose route generation moved
 * on, no longer serves. Only `ready` copies that serve `protocol` take new
 * requests, candidate copies only for intents that may reach them.
 */
export function computeRouteDecision(
  table: Pick<ComputeRouteTable, "generatedAt">,
  revision: ComputeRouteRevision | undefined,
  intent: ComputeRouteIntent,
  protocol: number = COMPUTE_INGRESS_PROTOCOL,
): ComputeRouteDecision {
  const current = Date.parse(table.generatedAt) >= Date.parse(intent.issuedAt);
  if (!revision)
    return current ? { kind: "refuse", code: "COMPUTE_REVISION_UNAVAILABLE" } : { kind: "wait", reason: "stale" };
  if (
    revision.appId !== intent.appId ||
    revision.environment !== intent.environment ||
    revision.developmentSessionId !== intent.developmentSessionId ||
    revision.workloadName !== intent.workloadName
  )
    return { kind: "refuse", code: "COMPUTE_AUTHORITY_REVOKED" };
  if (revision.routeGeneration > intent.routeGeneration)
    return { kind: "refuse", code: "COMPUTE_REVISION_UNAVAILABLE" };
  if (revision.routeGeneration < intent.routeGeneration) return { kind: "wait", reason: "stale" };
  if (revision.serving === "retired" || (revision.serving === "candidate" && !intent.candidate))
    return { kind: "refuse", code: "COMPUTE_REVISION_UNAVAILABLE" };
  if (revision.paused && !intent.candidate) return { kind: "refuse", code: "COMPUTE_SERVICE_UNAVAILABLE" };
  const copies = revision.instances.filter(
    (copy) =>
      copy.state === "ready" &&
      copy.ingressProtocols.includes(protocol) &&
      copy.grant.binding.revisionId === revision.revisionId &&
      (!copy.grant.candidate || intent.candidate),
  );
  return copies.length ? { kind: "route", copies } : { kind: "wait", reason: "starting" };
}
/**
 * Demand per revision as one gateway sees it: requests in flight, requests
 * waiting for a slot, and wakeups (a request that found no ready instance)
 * since its last report. Control sums fresh reports to scale services and wake
 * one scaled to zero.
 */
export const computeIngressDemandOperation = {
  method: "POST",
  path: "/v1/ingress/demand",
  input: z
    .object({
      protocolVersion: computeProtocolVersionSchema,
      revisions: z
        .array(
          z
            .object({
              revisionId: computeIdSchema,
              active: z.number().int().min(0).max(1_000_000),
              waiting: z.number().int().min(0).max(1_000_000),
              wakeups: z.number().int().min(0).max(1_000_000),
            })
            .strict(),
        )
        .max(1_000),
    })
    .strict(),
  output: z.object({ accepted: z.literal(true) }).strict(),
} as const;
export type ComputeIngressDemand = z.infer<typeof computeIngressDemandOperation.input>;
/**
 * Long-lived streams: Control rechecks each intent's caller authority (a
 * revoked session, an app no longer public). `accepted` keeps a stream,
 * `rejected` ends it, `retry` leaves it for the next round.
 */
export const computeStreamCheckOperation = {
  method: "POST",
  path: "/v1/ingress/streams",
  input: z
    .object({
      protocolVersion: computeProtocolVersionSchema,
      intents: z.array(z.string().min(1).max(16_384)).min(1).max(COMPUTE_BATCH_LIMIT),
    })
    .strict(),
  output: computeBatchResultSchema,
} as const;

export type ComputeNetworkAllowance = z.infer<typeof computeNetworkAllowanceSchema>;

/** The collector never restarts customer code. Its authority is distinct from a running lease. */
export const computeOutputCollectionRequestSchema = z
  .object({
    ...requestFields,
    executionId: computeIdSchema,
    attempt: z.number().int().min(1).max(5),
    publicationId: computeIdSchema,
    outputs: computeOutputPolicySchema,
    collectionDeadline: computeTimestampSchema,
    /** Files token names the winning stopped instance, generation and publication. */
    collectionToken: z.string().min(32).max(8_192),
  })
  .strict();
export const computeOutputFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(240)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !/[\\\u0000-\u001f\u007f]/.test(value) &&
          value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
      ),
    contentType: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !/[\r\n\0]/.test(value)),
    sizeBytes: computeIntegerSchema,
    sha256: computeSha256Schema,
  })
  .strict();
export const computeOutputCollectionResponseSchema = z
  .object({
    publicationId: computeIdSchema,
    state: z.enum(["collecting", "published"]),
    outputFileIds: z.array(computeIdSchema).max(16),
  })
  .strict();
export type ComputeOutputCollectionRequest = z.infer<typeof computeOutputCollectionRequestSchema>;
export type ComputeOutputCollectionResponse = z.infer<typeof computeOutputCollectionResponseSchema>;
/** Control releases retained stopped scratch only after output disposition and committed usage. */
export const computeCleanupRequestSchema = z
  .object({
    ...requestFields,
    usageThroughSequence: computeIntegerSchema,
    outputPublicationId: computeIdSchema.nullable(),
  })
  .strict();
export const computeCleanupResponseSchema = z.object({ released: z.literal(true) }).strict();
export type ComputeCleanupRequest = z.infer<typeof computeCleanupRequestSchema>;
export type ComputeCleanupResponse = z.infer<typeof computeCleanupResponseSchema>;

/** Control owns connection authorization and credential custody. Its trusted runtime
 * fetcher receives host-scoped credentials over mTLS and retains OCI bytes. Sandbox
 * launches receive only the resulting mirrored digest, never registry credentials. */
export const computeResolveImageRequestSchema = z
  .object({
    /** Control allocates and persists this identity before resolving a mutable tag. */
    retentionId: computeIdSchema,
    sourceReference: computeImageReferenceSchema,
    registryConnectionId: computeIdSchema.optional(),
  })
  .strict();
export const computeResolvedImageSchema = computePrepareImageResponseSchema.extend({ retentionId: computeIdSchema });
/** Secret transport only, supplied by Control after checking connection custody and host scope. */
export const computeImageFetchRequestSchema = computeResolveImageRequestSchema
  .omit({ registryConnectionId: true })
  .extend({
    registryAuthorization: z
      .object({
        registryHost: z
          .string()
          .min(1)
          .max(253)
          .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/),
        username: z.string().min(1).max(1_024),
        password: z.string().min(1).max(16_384),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ComputeResolvedImage = z.infer<typeof computeResolvedImageSchema>;
export type ComputeImageFetchRequest = z.infer<typeof computeImageFetchRequestSchema>;
export const computeReleaseImageRequestSchema = z
  .object({
    retentionId: computeIdSchema,
    /** Null requires an unresolved retention under the shared resolve/release lock;
     * a completed resolution must match its exact pinned digest. */
    imageDigest: computePinnedImageSchema.nullable(),
    /** Durable Control receipt proving no retained definition, release, dev or execution references. */
    proofId: computeIdSchema,
  })
  .strict();
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
  resolveAndRetain: {
    method: "POST",
    path: "/v1/images/resolve",
    input: computeImageFetchRequestSchema,
    output: computeResolvedImageSchema,
  },
  release: {
    method: "POST",
    path: "/v1/images/release",
    input: computeReleaseImageRequestSchema,
    output: computeReleaseImageResponseSchema,
  },
} as const;

export const CONTAINER_RUNTIME_ENV = Object.freeze({
  gatewayUrl: "OPENCLOUD_CONTAINER_GATEWAY_URL",
  capabilityToken: "OPENCLOUD_CONTAINER_CAPABILITY",
  capabilityFile: "OPENCLOUD_CONTAINER_CAPABILITY_FILE",
  instanceId: "OPENCLOUD_CONTAINER_INSTANCE_ID",
  executionId: "OPENCLOUD_EXECUTION_ID",
  executionAttempt: "OPENCLOUD_EXECUTION_ATTEMPT",
});

export type ComputeSignaturePurpose =
  | "opencloud.compute.v1.lease"
  | "opencloud.compute.v1.network"
  | "opencloud.compute.v1.route-grant";
/** Control signs leases, network allowances and route grants with its Ed25519
 * key (route intents are tokens, signed over their encoded body). Sign UTF-8
 * bytes; only the outer signature is omitted. */
export function canonicalComputeSignaturePayload(
  purpose: ComputeSignaturePurpose,
  binding: ComputeInstanceBinding,
  payload: object,
): string {
  if (
    !["opencloud.compute.v1.lease", "opencloud.compute.v1.network", "opencloud.compute.v1.route-grant"].includes(
      purpose,
    )
  )
    throw new TypeError("Unsupported compute signature purpose");
  const seen = new Set<object>();
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || !value || seen.has(value))
      throw new TypeError("Signature payload must be finite acyclic JSON");
    seen.add(value);
    let result: unknown;
    if (Array.isArray(value)) result = value.map(canonical);
    else {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
        throw new TypeError("Signature payload must contain plain JSON objects");
      result = Object.fromEntries(
        Object.entries(value)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    seen.delete(value);
    return result;
  };
  const unsigned = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "signature"));
  return JSON.stringify(
    canonical({ purpose, binding: computeInstanceBindingSchema.parse(binding), payload: unsigned }),
  );
}

/** All routes require the authenticated installation/worker transport binding. */
export const computeWorkerOperations = {
  proveHostQuiescence: {
    method: "POST",
    path: "/v1/host/quiescence-proof",
    input: computeProveHostQuiescenceRequestSchema,
    output: computeProveHostQuiescenceResponseSchema,
  },
  prepareImage: {
    method: "POST",
    path: "/v1/images/prepare",
    input: computePrepareImageRequestSchema,
    output: computePrepareImageResponseSchema,
  },
  start: {
    method: "POST",
    path: "/v1/instances/start",
    input: computeLaunchRequestSchema,
    output: computeLaunchResponseSchema,
  },
  inspect: {
    method: "POST",
    path: "/v1/instances/inspect",
    input: computeInspectRequestSchema,
    output: computeInspectResponseSchema,
  },
  renewLease: {
    method: "POST",
    path: "/v1/instances/lease",
    input: computeLeaseRenewRequestSchema,
    output: computeLeaseRenewResponseSchema,
  },
  stop: {
    method: "POST",
    path: "/v1/instances/stop",
    input: computeStopRequestSchema,
    output: computeStopResponseSchema,
  },
  retireUnstarted: {
    method: "POST",
    path: "/v1/instances/retire-unstarted",
    input: computeRetireUnstartedRequestSchema,
    output: computeRetireUnstartedResponseSchema,
  },
  retireUndeliveredAllowances: {
    method: "POST",
    path: "/v1/instances/retire-undelivered-allowances",
    input: computeRetireUndeliveredAllowancesRequestSchema,
    output: computeRetireUndeliveredAllowancesResponseSchema,
  },
  listManaged: {
    method: "POST",
    path: "/v1/instances/list",
    input: computeListManagedRequestSchema,
    output: computeListManagedResponseSchema,
  },
  collectUsage: {
    method: "POST",
    path: "/v1/instances/usage",
    input: computeCollectUsageRequestSchema,
    output: computeCollectUsageResponseSchema,
  },
  acknowledgeUsage: {
    method: "POST",
    path: "/v1/instances/usage/acknowledge",
    input: computeAcknowledgeUsageRequestSchema,
    output: computeAcknowledgeUsageResponseSchema,
  },
  collectOutputs: {
    method: "POST",
    path: "/v1/instances/outputs",
    input: computeOutputCollectionRequestSchema,
    output: computeOutputCollectionResponseSchema,
  },
  observeResources: {
    method: "POST",
    path: "/v1/instances/resources",
    input: computeInspectRequestSchema,
    output: computeResourceObservationSchema.nullable(),
  },
  cleanup: {
    method: "POST",
    path: "/v1/instances/cleanup",
    input: computeCleanupRequestSchema,
    output: computeCleanupResponseSchema,
  },
  collectNetworkUsage: {
    method: "POST",
    path: "/v1/instances/network-usage",
    input: computeCollectUsageRequestSchema,
    output: computeNetworkUsagePageSchema,
  },
} as const;

/** Runtime adapters implement this port; orchestration and prices belong elsewhere. */
export interface ComputeBackend {
  proveHostQuiescence(request: ComputeProveHostQuiescenceRequest): Promise<ComputeProveHostQuiescenceResponse>;
  prepareImage(request: ComputePrepareImageRequest): Promise<ComputePrepareImageResponse>;
  start(request: ComputeLaunchRequest): Promise<ComputeLaunchResponse>;
  inspect(request: ComputeInspectRequest): Promise<ComputeInspectResponse>;
  renewLease(request: ComputeLeaseRenewRequest): Promise<ComputeLeaseRenewResponse>;
  stop(request: ComputeStopRequest): Promise<ComputeStopResponse>;
  retireUnstarted(request: ComputeRetireUnstartedRequest): Promise<ComputeRetireUnstartedResponse>;
  retireUndeliveredAllowances(
    request: ComputeRetireUndeliveredAllowancesRequest,
  ): Promise<ComputeRetireUndeliveredAllowancesResponse>;
  listManaged(request: ComputeListManagedRequest): Promise<ComputeListManagedResponse>;
  collectUsage(request: ComputeCollectUsageRequest): Promise<ComputeCollectUsageResponse>;
  acknowledgeUsage(request: ComputeAcknowledgeUsageRequest): Promise<ComputeAcknowledgeUsageResponse>;
  collectOutputs(request: ComputeOutputCollectionRequest): Promise<ComputeOutputCollectionResponse>;
  observeResources(request: ComputeInspectRequest): Promise<ComputeResourceObservation | null>;
  cleanup(request: ComputeCleanupRequest): Promise<ComputeCleanupResponse>;
  collectNetworkUsage(request: ComputeCollectUsageRequest): Promise<ComputeNetworkUsagePage>;
}
