import { describe, expect, it } from "vitest";
import { devNotificationCaptureLimit, notificationHistoryQuery } from "./notifications.js";

describe("production notification history", () => {
  it("preserves bounded filters and opaque cursors", () => {
    expect(notificationHistoryQuery({ limit: "20", cursor: "opaque+/=", status: "partial" }))
      .toEqual({ limit: 20, cursor: "opaque+/=", status: "partial" });
    expect(notificationHistoryQuery({})).toEqual({ limit: 100 });
  });
  it.each([
    { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { status: "delivered" },
    { userId: "not-a-uuid" }, { cursor: "a".repeat(513) }, { from: "yesterday" },
    { from: "2026-09-02T00:00:00Z", to: "2026-09-01T00:00:00Z" },
    { from: "2026-07-01T00:00:00Z", to: "2026-09-01T00:00:00Z" },
  ])("rejects invalid filters: %j", (options) => {
    expect(() => notificationHistoryQuery(options)).toThrow();
  });
});

describe("development notifications", () => {
  it("defaults and validates capture limits", () => {
    expect(devNotificationCaptureLimit(undefined)).toBe(100);
    expect(devNotificationCaptureLimit("200")).toBe(200);
    expect(() => devNotificationCaptureLimit("0")).toThrow(
      /between 1 and 200/,
    );
    expect(() => devNotificationCaptureLimit("1.5")).toThrow(
      /between 1 and 200/,
    );
  });
});
