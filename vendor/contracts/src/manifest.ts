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

/** The pre-production hard cutover deliberately installs one SDK contract. */
export const sdkVersionSchema = z.literal("2.0.0", {
  error: "expected the installed SDK version 2.0.0",
});

export const migrationSchema = z
  .object({
    id: z.string().regex(/^[0-9]{4,14}_[a-z0-9][a-z0-9_-]*$/),
    file: relativePath,
    sha256: digest,
  })
  .strict();

export const functionAccessSchema = z.enum(["user", "public", "system"]);

export const functionSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    entrypoint: relativePath,
    access: functionAccessSchema.default("user"),
  })
  .strict();

export const cronSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    schedule: z.string().min(5).max(100),
    function: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    enabled: z.boolean().default(true),
  })
  .strict();

export const filesAccessSchema = z.enum(["user", "app"]);

export const secretModeSchema = z.enum(["generated", "required", "optional"]);

const secretNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,127}$/)
  .refine(
    (name) => !name.startsWith("OPENCLOUD_") && !name.startsWith("SUPABASE_"),
    "secret uses a reserved OpenCloud runtime prefix",
  );

export const emailAddressSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(30)
      .regex(/^[a-z][a-z0-9-]*$/, "email address names must be lowercase aliases"),
    displayName: z.string().trim().min(1).max(120).optional(),
    function: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).optional(),
  })
  .strict();

export const customMetricNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9_]*$/, "metric names must use lowercase snake_case");

export const customMetricDimensionNameSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "metric dimension names must use lowercase snake_case",
  );

export const customMetricDimensionValueSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "metric dimension values must be bounded identifiers",
  );

export const customMetricDefinitionSchema = z
  .object({
    name: customMetricNameSchema,
    type: z.enum(["counter", "gauge"]),
    unit: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_./%*-]*$/)
      .optional(),
    description: z.string().min(1).max(240).optional(),
    dimensions: z
      .record(
        customMetricDimensionNameSchema,
        z
          .object({
            values: z.array(customMetricDimensionValueSchema).min(1).max(20),
          })
          .strict(),
      )
      .refine((dimensions) => Object.keys(dimensions).length <= 3, {
        message: "custom metrics may declare at most three dimensions",
      })
      .default({}),
  })
  .strict();

export const openCloudManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    appId: z.uuid(),
    version: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    frontend: z
      .object({
        directory: relativePath,
        spa: z.boolean().default(true),
      })
      .strict(),
    runtime: z
      .object({
        sdk: z
          .object({
            version: sdkVersionSchema,
          })
          .strict(),
      })
      .strict(),
    files: z
      .object({
        access: filesAccessSchema.default("user"),
        maxUploadBytes: z
          .number()
          .int()
          .min(1)
          .max(100 * 1024 * 1024)
          .default(50 * 1024 * 1024),
      })
      .strict()
      .optional(),
    migrations: z.array(migrationSchema).max(500).default([]),
    functions: z.array(functionSchema).max(100).default([]),
    cron: z.array(cronSchema).max(100).default([]),
    email: z
      .object({
        addresses: z.array(emailAddressSchema).max(25).default([]),
      })
      .strict()
      .default({ addresses: [] }),
    health: z
      .object({ path: z.string().startsWith("/").max(200).default("/") })
      .strict()
      .default({ path: "/" }),
    secrets: z
      .record(secretNameSchema, secretModeSchema)
      .refine((secrets) => Object.keys(secrets).length <= 100, {
        message: "apps may declare at most 100 secrets",
      })
      .default({}),
    observability: z
      .object({
        metrics: z.array(customMetricDefinitionSchema).max(20).default([]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const assertUnique = (
      values: string[],
      path:
        | "migrations"
        | "functions"
        | "cron"
        | "email"
        | "observability",
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
    assertUnique(
      manifest.email.addresses.map((address) => address.name),
      "email",
    );
    assertUnique(
      (manifest.observability?.metrics ?? []).map((metric) => metric.name),
      "observability",
    );
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
      const target = manifest.functions.find(
        (definition) => definition.name === cron.function,
      );
      if (!functions.has(cron.function)) {
        context.addIssue({
          code: "custom",
          path: ["cron", index, "function"],
          message: `cron references unknown function: ${cron.function}`,
        });
      } else if (target?.access !== "system") {
        context.addIssue({
          code: "custom",
          path: ["cron", index, "function"],
          message:
            `cron function ${cron.function} must declare access: system`,
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
    manifest.email.addresses.forEach((address, index) => {
      if (!address.function) return;
      const target = manifest.functions.find(
        (definition) => definition.name === address.function,
      );
      if (!target) {
        context.addIssue({
          code: "custom",
          path: ["email", "addresses", index, "function"],
          message: `email address references unknown function: ${address.function}`,
        });
      } else if (target.access !== "system") {
        context.addIssue({
          code: "custom",
          path: ["email", "addresses", index, "function"],
          message:
            `email function ${address.function} must declare access: system`,
        });
      }
    });
  });

export type OpenCloudManifest = z.infer<typeof openCloudManifestSchema>;
export type OpenCloudMigration = z.infer<typeof migrationSchema>;
export type FilesAccess = z.infer<typeof filesAccessSchema>;
export type FunctionAccess = z.infer<typeof functionAccessSchema>;
export type SecretMode = z.infer<typeof secretModeSchema>;
export type SdkVersion = z.infer<typeof sdkVersionSchema>;
export type OpenCloudEmailAddress = z.infer<typeof emailAddressSchema>;
export type CustomMetricDefinition = z.infer<
  typeof customMetricDefinitionSchema
>;

export function parseManifest(value: unknown): OpenCloudManifest {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const manifest = value as Record<string, unknown>;
    if ("storage" in manifest) {
      throw new Error(
        "Manifest schema 2 replaces storage with files; use files.access: user or app",
      );
    }
    if ("requiredSecrets" in manifest) {
      throw new Error(
        "Manifest schema 2 replaces requiredSecrets with declarative secrets: NAME: generated, required, or optional",
      );
    }
    const runtime = manifest.runtime;
    if (
      runtime &&
      typeof runtime === "object" &&
      !Array.isArray(runtime) &&
      "javascriptSdk" in runtime
    ) {
      throw new Error(
        "Manifest schema 2 replaces runtime.javascriptSdk with runtime.sdk",
      );
    }
    const functions = manifest.functions;
    if (Array.isArray(functions)) {
      const legacyIndex = functions.findIndex(
        (definition) =>
          definition &&
          typeof definition === "object" &&
          !Array.isArray(definition) &&
          "verifyJwt" in definition,
      );
      if (legacyIndex >= 0) {
        throw new Error(
          `Manifest schema 2 replaces functions[${legacyIndex}].verifyJwt with access: user, public, or system`,
        );
      }
    }
  }
  return openCloudManifestSchema.parse(value);
}
