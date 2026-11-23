import { z } from "zod";
import { runtimeTaskPreparationSchema } from "@opencloud/agent-protocol";
import { agentTaskDefinitionSchema, agentTaskStatusSchema } from "./agent-tasks.js";

const amount = z.string().regex(/^\d+$/);
export const agentTaskCostSchema = z.object({
  nanodollars: amount.nullable(),
  tokens: amount.nullable(),
  state: z.enum(["complete", "updating", "unavailable"]),
  source: z.enum(["personal", "organisation", "opencloud"]).nullable(),
});
export const agentTaskRunRecordSchema = agentTaskStatusSchema.extend({
  title: z.string(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  attempts: z.number().int().nonnegative(),
  model: z.string().nullable(),
  error: z.string().nullable(),
  summary: z.string().nullable(),
});
export const agentTaskRunSchema = agentTaskRunRecordSchema.extend({ cost: agentTaskCostSchema });
export const agentTaskRangeSchema = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
}).refine(value => Date.parse(value.to) > Date.parse(value.from)
  && Date.parse(value.to) - Date.parse(value.from) <= 366 * 86_400_000,
{ message: "Choose a date range of at most 366 days" });
export const agentTaskHistoryQuerySchema = z.object({
  from: z.iso.datetime(), to: z.iso.datetime(),
  task: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).optional(),
  state: agentTaskStatusSchema.shape.state.optional(),
  search: z.string().trim().max(200).default(""),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).refine(value => agentTaskRangeSchema.safeParse(value).success,
{ message: "Choose a date range of at most 366 days" });
export const agentTaskHistorySchema = z.object({
  runs: z.array(agentTaskRunRecordSchema).max(50),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export const agentTaskRunsPageSchema = agentTaskHistorySchema.extend({ runs: z.array(agentTaskRunSchema).max(50) });
export const agentTaskRollupSchema = z.object({
  task: z.string(), title: z.string(), runs: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(), lastRun: agentTaskRunRecordSchema,
});
export const agentTasksOverviewSchema = z.object({
  deploymentId: z.uuid().nullable(),
  tasks: z.array(z.object({
    name: z.string(), title: z.string(),
    definition: agentTaskDefinitionSchema.nullable(),
    runs: z.number().int().nonnegative(), active: z.number().int().nonnegative(),
    lastRun: agentTaskRunSchema.nullable(), cost: agentTaskCostSchema,
  })),
  cost: agentTaskCostSchema,
});
export const agentTaskRunEvidenceSchema = z.object({
  run: agentTaskRunRecordSchema,
  deploymentId: z.uuid(),
  definition: agentTaskDefinitionSchema,
  preparation: runtimeTaskPreparationSchema.nullable().default(null),
  output: z.string().nullable(),
  outputTruncated: z.boolean(),
  assignments: z.array(z.object({
    id: z.string(), input: z.record(z.string(), z.unknown()),
    state: z.enum(["pending", "succeeded", "failed"]),
    operationId: z.uuid().nullable(), receipt: z.record(z.string(), z.unknown()).nullable(),
  })).max(50),
});
export const agentTaskRunDetailSchema = agentTaskRunEvidenceSchema.extend({ run: agentTaskRunSchema });
export const agentTaskActivitySchema = z.object({
  status: z.enum(["collecting", "complete", "incomplete", "unavailable", "corrupt"]),
  entries: z.array(z.object({
    id: z.string(), kind: z.string(), title: z.string(), summary: z.string().nullable(),
    detail: z.string().nullable(), detailTruncated: z.boolean(), occurredAt: z.string(),
  })).max(100),
  nextOffset: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative(),
});

export type AgentTaskCost = z.infer<typeof agentTaskCostSchema>;
export type AgentTaskRunRecord = z.infer<typeof agentTaskRunRecordSchema>;
export type AgentTaskHistoryQuery = z.infer<typeof agentTaskHistoryQuerySchema>;
