import { describe, expect, it } from "vitest";
import { asksForVersion } from "./version-request.js";

describe("asksForVersion", () => {
  it.each([
    [["--version"]],
    [["-v"]],
    [["--api-url", "https://api.example.test", "--version"]],
    [["--api-url=https://api.example.test", "-v"]],
  ])("prints the version for %j", (args) => {
    expect(asksForVersion(args)).toBe(true);
  });

  it.each([
    [[]],
    [["--cli-version"]],
    [["init", "app", "--version", "2026.10.27"]],
    [["app", "list", "-v"]],
    [["--token", "--version", "app", "list"]],
  ])("leaves %j to the commands", (args) => {
    expect(asksForVersion(args)).toBe(false);
  });
});
