import { z } from "zod";
import { computeIdSchema, computeIntegerSchema, computeKindSchema, computeNameSchema, computeResourceSampleSchema, computeTimestampSchema } from "@opencloud/compute-protocol";

/** Availability is independent for each source; missing diagnostics never imply zero. */
export const computeSourceFreshnessSchema = z.object({
  status: z.enum(["available", "partial", "unavailable"]),
  observedAt: computeTimestampSchema.nullable(), lagSeconds: z.number().finite().nonnegative().nullable(),
  truncated: z.boolean(),
}).strict();
export const computeSourceFreshnessSetSchema = z.object({
  control: computeSourceFreshnessSchema, logs: computeSourceFreshnessSchema,
  resources: computeSourceFreshnessSchema, usage: computeSourceFreshnessSchema,
}).strict();
const coordinates = {
  workloadName: computeNameSchema, kind: computeKindSchema, revisionId: computeIdSchema,
  instanceId: computeIdSchema.nullable(), executionId: computeIdSchema.nullable(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  environment: z.enum(["production", "development"]), developmentSessionId: computeIdSchema.nullable(),
};
function sessionIssue(value: { environment: string; developmentSessionId: string | null }, context: z.RefinementCtx) {
  if ((value.environment === "development") !== (value.developmentSessionId !== null)) context.addIssue({ code: "custom", path: ["developmentSessionId"], message: "Development observations require their exact session" });
}
export const computeCoordinatesSchema = z.object(coordinates).strict().superRefine(sessionIssue);
export const computeLogCoordinatesSchema = z.object({
  ...coordinates,
  instanceId: computeIdSchema, generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  attempt: z.number().int().min(1).max(5).nullable(), sourceSequence: computeIntegerSchema,
  stream: z.enum(["stdout", "stderr"]), truncated: z.boolean(),
  droppedLines: z.number().int().nonnegative().optional(),
  gapStartedAt: computeTimestampSchema.optional(), gapEndedAt: computeTimestampSchema.optional(),
}).strict().superRefine((value, context) => {
  sessionIssue(value, context);
  if (Boolean(value.gapStartedAt) !== Boolean(value.gapEndedAt) || (value.gapStartedAt && value.gapEndedAt && Date.parse(value.gapEndedAt) < Date.parse(value.gapStartedAt))) context.addIssue({ code: "custom", path: ["gapEndedAt"], message: "Gap timestamps must be paired and ordered" });
});
export const computeLogGapSchema = z.object({
  instanceId: computeIdSchema.nullable(), workloadName: computeNameSchema.nullable(),
  from: computeTimestampSchema, to: computeTimestampSchema, droppedLines: computeIntegerSchema,
}).strict().refine(value => Date.parse(value.to) >= Date.parse(value.from), "Gap end precedes start");
export const computeLogObservationSchema = computeSourceFreshnessSchema.extend({
  gaps: z.array(computeLogGapSchema).max(100),
  retentionSeconds: z.number().int().positive(),
});
export const computeInstanceDiagnosticsSchema = z.object({
  freshness: computeSourceFreshnessSchema,
  sample: computeResourceSampleSchema.nullable(),
}).strict();
export const computeFeedEventSchema = z.object({
  id: z.string().min(1).max(200), type: z.literal("compute"), state: z.string().min(1).max(80),
  occurredAt: computeTimestampSchema, message: z.string().max(500), deploymentId: computeIdSchema.nullable(),
  compute: computeCoordinatesSchema,
}).strict();
export const computeLogFilterFields = {
  workloadName: computeNameSchema.optional(), kind: computeKindSchema.optional(),
  executionId: computeIdSchema.optional(), instanceId: computeIdSchema.optional(),
};
export type ComputeCoordinates = z.infer<typeof computeCoordinatesSchema>;
export type ComputeLogCoordinates = z.infer<typeof computeLogCoordinatesSchema>;
export type ComputeLogObservation = z.infer<typeof computeLogObservationSchema>;
export type ComputeSourceFreshness = z.infer<typeof computeSourceFreshnessSchema>;
export type ComputeInstanceDiagnostics = z.infer<typeof computeInstanceDiagnosticsSchema>;
