import { z } from "zod";

export const taskInstructionsSchema = z.string().trim().min(1).max(16_000).refine(value => !value.includes("\0"), "Instructions cannot contain null characters");
export const taskPreparationResultSchema = z.object({ instructions: taskInstructionsSchema }).strict();

/** Captured with run.start; app code runs only in the declared Function runtime. */
export const taskPreparationRequestSchema = z.object({
  deploymentId: z.uuid(),
  functionName: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  input: z.object({
    taskRunId: z.uuid(),
    task: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    assignments: z.array(z.object({
      id: z.string().min(1).max(128),
      input: z.record(z.string(), z.union([z.string().max(8_192), z.number().finite(), z.boolean()])),
      submissionKey: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict()).min(1).max(50),
  }).strict(),
}).strict();

export const runtimeTaskPreparationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("running"), operationId: z.uuid() }).strict(),
  z.object({
    state: z.literal("ready"), operationId: z.uuid(),
    instructions: taskInstructionsSchema, preparedAt: z.iso.datetime(),
  }).strict(),
  z.object({
    state: z.literal("failed"), operationId: z.uuid().nullable(),
    code: z.string().min(1).max(80), message: z.string().min(1).max(500),
  }).strict(),
]);
export type RuntimeTaskPreparation = z.infer<typeof runtimeTaskPreparationSchema>;
