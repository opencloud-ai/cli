import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest.js";

const valid = {
  schemaVersion: 2,
  appId: "aeea1c71-72a3-4b1d-a32e-213900735091",
  version: "2026.07.27-1",
  frontend: { directory: "frontend", spa: true },
  runtime: { sdk: { version: "2.0.0" } },
  migrations: [
    {
      id: "0001_create_notes",
      file: "migrations/0001_create_notes.sql",
      sha256: "a".repeat(64),
    },
  ],
  functions: [],
  cron: [],
  queues: [],
  email: { addresses: [] },
  health: { path: "/" },
  secrets: {},
};

describe("OpenCloud manifest", () => {
  it("accepts a deterministic app bundle", () => {
    expect(parseManifest(valid)).toMatchObject(valid);
    expect(parseManifest(valid)).not.toHaveProperty("files");
  });

  it("enables files only when declared and defaults to user isolation", () => {
    expect(
      parseManifest({
        ...valid,
        files: {},
      }).files,
    ).toEqual({ access: "user", maxUploadBytes: 50 * 1024 * 1024 });
    expect(parseManifest({ ...valid, files: { access: "app" } }).files).toEqual(
      { access: "app", maxUploadBytes: 50 * 1024 * 1024 },
    );
  });

  it("requires one exact deployment-pinned SDK version", () => {
    expect(
      parseManifest({
        ...valid,
        runtime: {
          sdk: { version: "2.0.0" },
        },
      }).runtime,
    ).toEqual({
      sdk: { version: "2.0.0" },
    });
  });

  it("rejects legacy versions, moving ranges, and tags", () => {
    for (const version of ["1.0.0", "^2.0.0", "latest", "2.0"]) {
      expect(() =>
        parseManifest({
          ...valid,
          runtime: { sdk: { version } },
        }),
      ).toThrow(/installed SDK version 2\.0\.0/);
    }
  });

  it("rejects unknown file access modes", () => {
    expect(() =>
      parseManifest({
        ...valid,
        files: { access: "shared-prefix" },
      }),
    ).toThrow();
  });

  it("rejects stale schema-1 names with migration guidance", () => {
    expect(() =>
      parseManifest({ ...valid, storage: { authorization: "app" } }),
    ).toThrow(/replaces storage with files/);
    expect(() =>
      parseManifest({
        ...valid,
        runtime: { javascriptSdk: { version: "0.2.2" } },
      }),
    ).toThrow(/runtime\.javascriptSdk with runtime\.sdk/);
    expect(() =>
      parseManifest({
        ...valid,
        functions: [
          { name: "old", entrypoint: "functions/old/index.ts", verifyJwt: true },
        ],
      }),
    ).toThrow(/verifyJwt with access/);
  });

  it("rejects unknown keys instead of silently stripping mistakes", () => {
    expect(() => parseManifest({ ...valid, filez: {} })).toThrow(
      /Unrecognized key/,
    );
    expect(() =>
      parseManifest({
        ...valid,
        functions: [
          { name: "tick", entrypoint: "functions/tick/index.ts", acess: "user" },
        ],
      }),
    ).toThrow(/Unrecognized key/);
  });

  it("accepts a bounded deployment-pinned custom metric catalog", () => {
    expect(
      parseManifest({
        ...valid,
        observability: {
          metrics: [
            {
              name: "tasks_created",
              type: "counter",
              unit: "tasks",
              dimensions: {
                assignee_type: { values: ["parent", "child"] },
              },
            },
            {
              name: "overdue_tasks",
              type: "gauge",
              unit: "tasks",
            },
          ],
        },
      }).observability,
    ).toEqual({
      metrics: [
        {
          name: "tasks_created",
          type: "counter",
          unit: "tasks",
          dimensions: {
            assignee_type: { values: ["parent", "child"] },
          },
        },
        {
          name: "overdue_tasks",
          type: "gauge",
          unit: "tasks",
          dimensions: {},
        },
      ],
    });
  });

  it("rejects duplicate or high-cardinality custom metric definitions", () => {
    expect(() =>
      parseManifest({
        ...valid,
        observability: {
          metrics: [
            { name: "tasks_created", type: "counter" },
            { name: "tasks_created", type: "gauge" },
          ],
        },
      }),
    ).toThrow(/must be unique/);
    expect(() =>
      parseManifest({
        ...valid,
        observability: {
          metrics: [
            {
              name: "tasks-created",
              type: "counter",
              dimensions: {
                user_id: {
                  values: Array.from({ length: 21 }, (_, index) => `u${index}`),
                },
              },
            },
          ],
        },
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

  it("requires cron targets to be platform-only system Functions", () => {
    expect(() =>
      parseManifest({
        ...valid,
        functions: [
          { name: "tick", entrypoint: "functions/tick/index.ts", access: "user" },
        ],
        cron: [
          {
            name: "hourly",
            schedule: "0 * * * *",
            function: "tick",
            enabled: true,
          },
        ],
      }),
    ).toThrow(/must declare access: system/);
    expect(
      parseManifest({
        ...valid,
        functions: [
          { name: "tick", entrypoint: "functions/tick/index.ts", access: "system" },
        ],
        cron: [
          {
            name: "hourly",
            schedule: "0 * * * *",
            function: "tick",
            enabled: true,
          },
        ],
      }).functions[0]?.access,
    ).toBe("system");
  });

  it("declares bounded queues with system Function consumers", () => {
    const manifest = parseManifest({
      ...valid,
      functions: [
        {
          name: "process-document",
          entrypoint: "functions/process-document/index.ts",
          access: "system",
        },
      ],
      queues: [
        {
          name: "document-processing",
          function: "process-document",
          concurrency: 4,
          maxAttempts: 5,
          retryDelaySeconds: 10,
          timeoutSeconds: 120,
        },
      ],
    });

    expect(manifest.queues).toEqual([
      {
        name: "document-processing",
        function: "process-document",
        concurrency: 4,
        maxAttempts: 5,
        retryDelaySeconds: 10,
        retryBackoff: true,
        timeoutSeconds: 120,
      },
    ]);
  });

  it("rejects duplicate queues, unknown consumers, and non-system consumers", () => {
    expect(() =>
      parseManifest({
        ...valid,
        queues: [
          { name: "work", function: "missing" },
          { name: "work", function: "missing" },
        ],
      }),
    ).toThrow(/queues entries must be unique|unknown function/);

    expect(() =>
      parseManifest({
        ...valid,
        functions: [
          {
            name: "process-work",
            entrypoint: "functions/process-work/index.ts",
            access: "user",
          },
        ],
        queues: [{ name: "work", function: "process-work" }],
      }),
    ).toThrow(/must declare access: system/);
  });

  it("bounds queue concurrency, attempts, retry delay, and timeout", () => {
    for (const queue of [
      { name: "work", function: "process-work", concurrency: 21 },
      { name: "work", function: "process-work", maxAttempts: 0 },
      { name: "work", function: "process-work", retryDelaySeconds: 3_601 },
      { name: "work", function: "process-work", timeoutSeconds: 901 },
    ]) {
      expect(() =>
        parseManifest({
          ...valid,
          functions: [
            {
              name: "process-work",
              entrypoint: "functions/process-work/index.ts",
              access: "system",
            },
          ],
          queues: [queue],
        }),
      ).toThrow();
    }
  });

  it("declares generated, required, and optional secrets without values", () => {
    expect(
      parseManifest({
        ...valid,
        secrets: {
          SIGNING_SECRET: "generated",
          PROVIDER_KEY: "required",
          ORGANIZATION_LABEL: "optional",
        },
      }).secrets,
    ).toEqual({
      SIGNING_SECRET: "generated",
      PROVIDER_KEY: "required",
      ORGANIZATION_LABEL: "optional",
    });
  });

  it("rejects legacy requiredSecrets with direct migration guidance", () => {
    expect(() =>
      parseManifest({ ...valid, requiredSecrets: ["SIGNING_SECRET"] }),
    ).toThrow(/replaces requiredSecrets with declarative secrets/);
  });

  it("rejects secrets that collide with runtime-owned names", () => {
    for (const name of ["OPENCLOUD_FILES_GRANT", "SUPABASE_SERVICE_ROLE_KEY"]) {
      expect(() =>
        parseManifest({ ...valid, secrets: { [name]: "required" } }),
      ).toThrow(/reserved OpenCloud runtime prefix/);
    }
  });

  it("accepts multiple email aliases and validates inbound handlers", () => {
    const manifest = parseManifest({
      ...valid,
      functions: [
        {
          name: "receive-support",
          entrypoint: "functions/receive-support/index.ts",
          access: "system",
        },
      ],
      email: {
        addresses: [
          {
            name: "support",
            displayName: "Support",
            function: "receive-support",
          },
          { name: "notifications", displayName: "Notifications" },
        ],
      },
    });
    expect(manifest.email.addresses).toHaveLength(2);
    expect(manifest.email.addresses[0]?.function).toBe("receive-support");
  });

  it("rejects duplicate email aliases and unknown inbound handlers", () => {
    expect(() =>
      parseManifest({
        ...valid,
        email: {
          addresses: [
            { name: "support", function: "missing" },
            { name: "support" },
          ],
        },
      }),
    ).toThrow(/email/);
  });

  it("requires inbound email handlers to be system Functions", () => {
    expect(() =>
      parseManifest({
        ...valid,
        functions: [
          {
            name: "receive-support",
            entrypoint: "functions/receive-support/index.ts",
            access: "user",
          },
        ],
        email: {
          addresses: [
            { name: "support", function: "receive-support" },
          ],
        },
      }),
    ).toThrow(/must declare access: system/);
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
          { name: "tick", entrypoint: "functions/tick/index.ts", access: "system" },
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
