import { describe, expect, it } from "vitest";
import { devNotificationCaptureLimit } from "./notifications.js";

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
