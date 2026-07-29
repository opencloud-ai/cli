import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest.js";

const valid = {
  schemaVersion: 1,
  appId: "aeea1c71-72a3-4b1d-a32e-213900735091",
  version: "2026.07.27-1",
  frontend: { directory: "frontend", spa: true },
  migrations: [
    {
      id: "0001_create_notes",
      file: "migrations/0001_create_notes.sql",
      sha256: "a".repeat(64),
    },
  ],
  functions: [],
  cron: [],
  health: { path: "/" },
  requiredSecrets: [],
};

describe("OpenCloud manifest", () => {
  it("accepts a deterministic app bundle", () => {
    expect(parseManifest(valid)).toMatchObject({
      ...valid,
      storage: { authorization: "app" },
    });
  });

  it("accepts owner-prefixed Storage authorization as an opt-in", () => {
    expect(
      parseManifest({
        ...valid,
        storage: { authorization: "owner-prefix" },
      }).storage,
    ).toEqual({ authorization: "owner-prefix" });
  });

  it("accepts an exact deployment-pinned JavaScript SDK version", () => {
    expect(
      parseManifest({
        ...valid,
        runtime: {
          javascriptSdk: {
            version: "0.2.0",
          },
        },
      }).runtime,
    ).toEqual({
      javascriptSdk: {
        version: "0.2.0",
      },
    });
  });

  it("rejects moving JavaScript SDK ranges and tags", () => {
    for (const version of ["^0.2.0", "latest", "0.2"]) {
      expect(() =>
        parseManifest({
          ...valid,
          runtime: {
            javascriptSdk: {
              version,
            },
          },
        }),
      ).toThrow(/exact semantic version/);
    }
  });

  it("rejects unknown Storage authorization modes", () => {
    expect(() =>
      parseManifest({
        ...valid,
        storage: { authorization: "shared-prefix" },
      }),
    ).toThrow();
  });

  it("rejects archive traversal paths", () => {
    expect(() =>
      parseManifest({
        ...valid,
        frontend: { directory: "../outside", spa: true },
      }),
    ).toThrow(/path must not traverse/);
  });

  it("rejects mutable migration digests", () => {
    expect(() =>
      parseManifest({
        ...valid,
        migrations: [{ ...valid.migrations[0], sha256: "not-a-digest" }],
      }),
    ).toThrow(/SHA-256/);
  });

  it("rejects a cron that targets an undeclared function", () => {
    expect(() =>
      parseManifest({
        ...valid,
        cron: [
          {
            name: "hourly",
            schedule: "0 * * * *",
            function: "missing",
            enabled: true,
          },
        ],
      }),
    ).toThrow(/unknown function/);
  });

  it("rejects reordered migration history", () => {
    expect(() =>
      parseManifest({
        ...valid,
        migrations: [
          {
            id: "0002_second",
            file: "migrations/0002_second.sql",
            sha256: "b".repeat(64),
          },
          valid.migrations[0],
        ],
      }),
    ).toThrow(/ordered/);
  });

  it("rejects invalid cron syntax before deployment", () => {
    expect(() =>
      parseManifest({
        ...valid,
        functions: [
          { name: "tick", entrypoint: "functions/tick/index.ts", verifyJwt: true },
        ],
        cron: [
          {
            name: "broken",
            schedule: "not a cron",
            function: "tick",
            enabled: true,
          },
        ],
      }),
    ).toThrow(/invalid cron/);
  });
});
