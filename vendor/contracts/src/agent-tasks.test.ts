import { describe, expect, it } from "vitest";
import { agentTaskDefinitionSchema, agentTaskReceiptSchema, agentTaskSubmissionSchema, validateAgentTaskSubmission } from "./agent-tasks.js";

const definition = agentTaskDefinitionSchema.parse({
  name: "inspect-competitors", title: "Check competitor campaigns",
  instructions: "Capture each assigned website and record its campaign.",
  inputSchema: { type: "object", properties: { url: { type: "string", maxLength: 2_048 } }, required: ["url"], additionalProperties: false },
  resultFunction: "record-observation", maxAssignments: 2,
});
const submission = agentTaskSubmissionSchema.parse({
  task: definition.name, idempotencyKey: "daily:2026-09-08",
  assignments: [{ id: "forma", input: { url: "https://forma.test" } }],
});

describe("agent task admission contracts", () => {
  it("checks every assignment against the pinned strict schema", () => {
    expect(() => validateAgentTaskSubmission(definition, submission)).not.toThrow();
    for (const input of [{}, { url: true }, { url: "https://forma.test", undeclared: "value" }, { url: "x".repeat(2_049) }]) {
      expect(() => validateAgentTaskSubmission(definition, { ...submission, assignments: [{ id: "forma", input }] })).toThrow();
    }
    expect(() => validateAgentTaskSubmission(definition, { ...submission, assignments: ["a", "b", "c"].map(id => ({ id, input: { url: "https://forma.test" } })) })).toThrow();
  });

  it("rejects duplicate assignments, conflicting required fields and unbounded schemas", () => {
    expect(agentTaskSubmissionSchema.safeParse({ ...submission, assignments: [...submission.assignments, ...submission.assignments] }).success).toBe(false);
    expect(agentTaskDefinitionSchema.safeParse({ ...definition, inputSchema: { ...definition.inputSchema, required: ["missing"] } }).success).toBe(false);
    expect(agentTaskDefinitionSchema.safeParse({ ...definition, inputSchema: { ...definition.inputSchema, $ref: "https://schema.test" } }).success).toBe(false);
    expect(agentTaskSubmissionSchema.safeParse({ ...submission, assignments: Array.from({ length: 50 }, (_, i) => ({ id: String(i), input: { url: "x".repeat(8_192) } })) }).success).toBe(false);
  });

  it("requires a committed application receipt, without claiming notification delivery", () => {
    const receipt = { schemaVersion: 1, submissionKey: "forma:2026-09-08", observationId: "observation-1", outcome: "changed", calendarCommitted: true, notification: "queued" };
    expect(agentTaskReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(agentTaskReceiptSchema.safeParse({ ...receipt, calendarCommitted: false }).success).toBe(false);
    expect(agentTaskReceiptSchema.safeParse({ ...receipt, notification: "delivered" }).success).toBe(false);
    expect(agentTaskReceiptSchema.safeParse({ message: "Calendar updated" }).success).toBe(false);
  });
});
