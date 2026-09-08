import { z } from "zod";

/** Explicit file inputs; canonicalization is part of enqueue idempotency. */
export const jobFileReadOptionsSchema = z.object({
  read: z.array(z.uuid()).min(1).max(16).transform((ids) =>
    [...new Set(ids.map((id) => id.toLowerCase()))].sort()),
}).strict();

/** Structural validation only: consumers must verify signed runtime authority. */
export const jobFileReadClaimSchema = z.object({
  jobId: z.uuid(),
  attemptId: z.uuid(),
}).strict();

export const jobFileDelegationErrorCodeSchema = z.enum([
  "FILE_INPUT_UNAVAILABLE", "FILE_INPUT_CHANGED",
  "FILE_DELEGATION_EXPIRED", "FILE_DELEGATION_INVALID",
]);

export type JobFileReadOptions = z.infer<typeof jobFileReadOptionsSchema>;
export type JobFileReadClaim = z.infer<typeof jobFileReadClaimSchema>;
export type JobFileDelegationErrorCode = z.infer<typeof jobFileDelegationErrorCodeSchema>;
