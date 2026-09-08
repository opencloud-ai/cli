import { describe, expect, it } from "vitest";
import { jobFileReadOptionsSchema, jobFileReadClaimSchema, jobFileDelegationErrorCodeSchema } from "./job-file-delegation.js";

const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
describe("job file delegation", () => {
  it("canonicalizes equivalent input selections", () => {
    expect(jobFileReadOptionsSchema.parse({ read: [b, a.toUpperCase(), a] })).toEqual({ read: [a, b] });
  });
  it.each([{}, { read: [] }, { read: ["invalid"] }, { read: Array(17).fill(a) }, { read: [a], write: [a] }])("rejects invalid inputs %j", (input) => {
    expect(jobFileReadOptionsSchema.safeParse(input).success).toBe(false);
  });
  it("requires an exact job and attempt reference", () => {
    expect(jobFileReadClaimSchema.parse({ jobId: a, attemptId: b })).toEqual({ jobId: a, attemptId: b });
    for (const input of [{ jobId: a }, { jobId: a, attemptId: "bad" }, { jobId: a, attemptId: b, userId: a }]) {
      expect(jobFileReadClaimSchema.safeParse(input).success).toBe(false);
    }
    expect(jobFileDelegationErrorCodeSchema.options).toHaveLength(4);
  });
});
