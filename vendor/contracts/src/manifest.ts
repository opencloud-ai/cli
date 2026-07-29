import { z } from "zod";
import { CronExpressionParser } from "cron-parser";

const relativePath = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => !value.startsWith("/") && !value.includes("\\"),
    "path must be relative and use forward slashes")
  .refine(
    (value) => value.split("/").every((part) => part !== ".." && part !== ""),
    "path must not traverse outside the bundle",
  );

const digest = z.string().regex(/^[a-f0-9]{64}$/, "expected a SHA-256 digest");

export const javascriptSdkVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "expected an exact semantic version");

export const migrationSchema = z.object({
  id: z.string().regex(/^[0-9]{4,14}_[a-z0-9][a-z0-9_-]*$/),
  file: relativePath,
  sha256: digest,
});

export const functionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  entrypoint: relativePath,
  verifyJwt: z.boolean().default(true),
});

export const cronSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  schedule: z.string().min(5).max(100),
  function: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  enabled: z.boolean().default(true),
});

export const storageAuthorizationSchema = z.enum(["app", "owner-prefix"]);

export const openCloudManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    appId: z.uuid(),
    version: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    frontend: z.object({
      directory: relativePath,
      spa: z.boolean().default(true),
    }),
    runtime: z
      .object({
        javascriptSdk: z.object({
          version: javascriptSdkVersionSchema,
        }),
      })
      .optional(),
    storage: z
      .object({
        authorization: storageAuthorizationSchema.default("app"),
      })
      .default({ authorization: "app" }),
    migrations: z.array(migrationSchema).max(500).default([]),
    functions: z.array(functionSchema).max(100).default([]),
    cron: z.array(cronSchema).max(100).default([]),
    health: z
      .object({
        path: z.string().startsWith("/").max(200).default("/"),
      })
      .default({ path: "/" }),
    requiredSecrets: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/))
      .max(100)
      .default([]),
  })
  .superRefine((manifest, context) => {
    const assertUnique = (
      values: string[],
      path: "migrations" | "functions" | "cron" | "requiredSecrets",
    ) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            path: [path, index],
            message: `${path} entries must be unique: ${value}`,
          });
        }
        seen.add(value);
      });
    };
    assertUnique(
      manifest.migrations.map((migration) => migration.id),
      "migrations",
    );
    assertUnique(
      manifest.functions.map((definition) => definition.name),
      "functions",
    );
    assertUnique(manifest.cron.map((cron) => cron.name), "cron");
    assertUnique(manifest.requiredSecrets, "requiredSecrets");
    const orderedMigrations = [...manifest.migrations]
      .map((migration) => migration.id)
      .sort();
    manifest.migrations.forEach((migration, index) => {
      if (migration.id !== orderedMigrations[index]) {
        context.addIssue({
          code: "custom",
          path: ["migrations", index, "id"],
          message: "migrations must be ordered by their immutable ID",
        });
      }
    });

    const functions = new Set(
      manifest.functions.map((definition) => definition.name),
    );
    manifest.cron.forEach((cron, index) => {
      if (!functions.has(cron.function)) {
        context.addIssue({
          code: "custom",
          path: ["cron", index, "function"],
          message: `cron references unknown function: ${cron.function}`,
        });
      }
      try {
        CronExpressionParser.parse(cron.schedule, { tz: "Etc/UTC" });
      } catch {
        context.addIssue({
          code: "custom",
          path: ["cron", index, "schedule"],
          message: `invalid cron schedule: ${cron.schedule}`,
        });
      }
    });
  });

export type OpenCloudManifest = z.infer<typeof openCloudManifestSchema>;
export type OpenCloudMigration = z.infer<typeof migrationSchema>;
export type StorageAuthorization = z.infer<typeof storageAuthorizationSchema>;
export type JavaScriptSdkVersion = z.infer<typeof javascriptSdkVersionSchema>;

export function parseManifest(value: unknown): OpenCloudManifest {
  return openCloudManifestSchema.parse(value);
}
