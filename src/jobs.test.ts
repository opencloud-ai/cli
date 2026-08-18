import { describe, expect, it } from "vitest";
import { backgroundJobPath, backgroundJobsQuery } from "./jobs.js";

describe("background job CLI inputs", () => {
  it("builds a bounded metadata-history query", () => {
    expect(
      backgroundJobsQuery({
        queue: "task-processing",
        state: "retry_wait",
        from: "2026-08-18T09:00:00.000Z",
        to: "2026-08-18T12:00:00.000Z",
        cursor: "page-2",
        limit: "25",
      }).toString(),
    ).toBe(
      "limit=25&queue=task-processing&state=retry_wait&from=2026-08-18T09%3A00%3A00.000Z&to=2026-08-18T12%3A00%3A00.000Z&cursor=page-2",
    );
  });

  it("rejects unsupported states, queue names, and limits", () => {
    expect(() => backgroundJobsQuery({ state: "cancelled" })).toThrow(
      "state must be",
    );
    expect(() => backgroundJobsQuery({ queue: "Task Queue" })).toThrow(
      "lowercase kebab-case",
    );
    expect(() => backgroundJobsQuery({ limit: 201 })).toThrow(
      "1 through 200",
    );
  });

  it("requires offset timestamps and an ordered creation-time range", () => {
    expect(() =>
      backgroundJobsQuery({ from: "2026-08-18T09:00" }),
    ).toThrow("with an offset");
    expect(() =>
      backgroundJobsQuery({
        from: "2026-08-18T12:00:00.000Z",
        to: "2026-08-18T09:00:00.000Z",
      }),
    ).toThrow("after from");
  });

  it("encodes app and job identifiers as path segments", () => {
    expect(backgroundJobPath("app/id", "job id")).toBe(
      "/v1/apps/app%2Fid/jobs/job%20id",
    );
  });
});
