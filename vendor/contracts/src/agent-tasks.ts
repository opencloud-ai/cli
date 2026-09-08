import { z } from "zod";

const name = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export const agentTaskKeySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

// Keep the first release's input vocabulary deliberately small. No references,
// remote schemas, coercion, or executable validation enter a task prompt.
const scalarSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"), maxLength: z.number().int().min(1).max(8_192).default(2_048) }).strict(),
  z.object({ type: z.literal("number") }).strict(),
  z.object({ type: z.literal("boolean") }).strict(),
]);
export const agentTaskInputSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/), scalarSchema)
    .refine(value => Object.keys(value).length <= 32, "At most 32 input fields are supported"),
  required: z.array(z.string()).max(32).default([]),
  additionalProperties: z.literal(false),
}).strict().superRefine((value, context) => {
  if (new Set(value.required).size !== value.required.length || value.required.some(key => !Object.hasOwn(value.properties, key))) {
    context.addIssue({ code: "custom", path: ["required"], message: "Required fields must be unique declared properties" });
  }
});

export const agentTaskDefinitionSchema = z.object({
  name,
  title: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(16_000),
  inputSchema: agentTaskInputSchema,
  resultFunction: name,
  capture: z.literal("website_screenshot").optional(),
  maxAssignments: z.number().int().min(1).max(50).default(10),
  timeoutSeconds: z.number().int().min(60).max(3_600).default(900),
  maxAttempts: z.number().int().min(1).max(3).default(2),
  tokenLimit: z.number().int().min(1_000).max(500_000).default(100_000),
}).strict();
export type AgentTaskDefinition = z.infer<typeof agentTaskDefinitionSchema>;

export const agentTaskSubmissionSchema = z.object({
  task: name,
  assignments: z.array(z.object({
    id: agentTaskKeySchema,
    input: z.record(z.string(), z.union([z.string().max(8_192), z.number().finite(), z.boolean()])),
  }).strict()).min(1).max(50),
  idempotencyKey: agentTaskKeySchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.assignments.map(item => item.id)).size !== value.assignments.length) {
    context.addIssue({ code: "custom", path: ["assignments"], message: "Assignment IDs must be unique" });
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 64 * 1_024) {
    context.addIssue({ code: "custom", message: "Task submission exceeds 64 KiB" });
  }
});
export type AgentTaskSubmission = z.infer<typeof agentTaskSubmissionSchema>;

export function validateAgentTaskSubmission(definition: AgentTaskDefinition, submission: AgentTaskSubmission): void {
  if (submission.task !== definition.name || submission.assignments.length > definition.maxAssignments) {
    throw new Error("Task name or assignment limit does not match its declaration");
  }
  const schema = z.fromJSONSchema(definition.inputSchema);
  for (const assignment of submission.assignments) {
    schema.parse(assignment.input);
    if (definition.capture === "website_screenshot") {
      const url = new URL(z.url().max(2_048).parse(assignment.input.url));
      if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
        throw new Error("Website captures require a public HTTPS URL on port 443");
      }
    }
  }
}

export const agentTaskReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  submissionKey: agentTaskKeySchema,
  observationId: z.string().min(1).max(128),
  outcome: z.enum(["changed", "unchanged", "no_campaign"]),
  calendarCommitted: z.literal(true),
  notification: z.enum(["not_needed", "queued"]),
  screenshotFileId: z.uuid().optional(),
}).strict();
export type AgentTaskReceipt = z.infer<typeof agentTaskReceiptSchema>;

export const agentTaskStateSchema = z.enum(["queued", "running", "processing", "succeeded", "partial", "failed", "stopped"]);
export const agentTaskStatusSchema = z.object({
  id: z.uuid(),
  task: name,
  state: agentTaskStateSchema,
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();
export type AgentTaskStatus = z.infer<typeof agentTaskStatusSchema>;

/** Trusted control-plane to Agent-service boundary; never accepts browser authority. */
export const agentTaskAdmissionSchema = z.object({
  userId: z.uuid(),
  appId: z.uuid(),
  deploymentId: z.uuid(),
  environment: z.literal("production"),
  initiatingRunId: z.uuid().nullable().default(null),
  definition: agentTaskDefinitionSchema,
  submission: agentTaskSubmissionSchema,
}).strict();
export type AgentTaskAdmission = z.infer<typeof agentTaskAdmissionSchema>;
