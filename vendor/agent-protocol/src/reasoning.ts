import { z } from "zod";

export const nativeReasoningEffortSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);

/** OpenCode variant identifiers, including its provider-default selection. */
export const agentReasoningVariantSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

export const agentReasoningOptionsSchema = z.object({
  options: z.array(z.object({ id: agentReasoningVariantSchema, label: z.string().min(1).max(100) }).strict()).max(65),
  defaultValue: agentReasoningVariantSchema,
}).strict();
export type AgentReasoningOptions = z.infer<typeof agentReasoningOptionsSchema>;
