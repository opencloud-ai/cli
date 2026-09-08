import { z } from "zod";
import { dataSearchDeclarationsSchema } from "./data-search.js";
import { CronExpressionParser } from "cron-parser";
import { agentTaskDefinitionSchema } from "./agent-tasks.js";
import { appRoutesSchema, compileAppRoutes, matchAppRoute, parseAppRouteRequest, AppRouteError } from "./app-routes.js";
import {
  alertAggregationSchema,
  alertOperatorSchema,
  alertRuleIdSchema,
  alertSeveritySchema,
  alertWindowSchema,
  customMetricNameSchema,
  manifestAlertRuleSchema,
} from "./api-core.js";
import {
  integrationAccountSchema,
  integrationCapabilitySchema,
  integrationCardinalitySchema,
  integrationDefinitionSchema,
  integrationEventsSchema,
  integrationProviderSchema,
} from "./integration-manifest.js";

export {
  alertAggregationSchema,
  alertOperatorSchema,
  alertRuleIdSchema,
  alertSeveritySchema,
  alertWindowSchema,
  customMetricNameSchema,
  manifestAlertRuleSchema,
} from "./api-core.js";
export {
  integrationAccountSchema,
  integrationCapabilitySchema,
  integrationCardinalitySchema,
  integrationDefinitionSchema,
  integrationEventsSchema,
  integrationProviderSchema,
};

const relativePath = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) => !value.startsWith("/") && !value.includes("\\"),
    "path must be relative and use forward slashes",
  )
  .refine(
    (value) => value.split("/").every((part) => part !== ".." && part !== ""),
    "path must not traverse outside the bundle",
  );

const sameOriginAbsolutePath = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !value.includes("\\") &&
      !/[\u0000-\u001f\u007f]/.test(value),
    "path must be a same-origin absolute path",
  );

const appHealthPath = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) => isAppOwnedHealthPath(value),
    "health path must be a same-origin app path outside the reserved /_opencloud namespace",
  );

function isAppOwnedHealthPath(value: string): boolean {
  const origin = "https://opencloud-app-health.invalid";
  try {
    const target = new URL(value, `${origin}/`);
    if (
      target.origin !== origin ||
      !value.startsWith("/") ||
      value.startsWith("//") ||
      value.includes("\\") ||
      target.hash ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      return false;
    }
    let pathname = target.pathname;
    for (let pass = 0; pass < 4; pass += 1) {
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) break;
      pathname = decoded;
    }
    if (pathname.split("/").some((part) => part === "." || part === "..")) {
      return false;
    }
    const normalized = pathname.toLowerCase();
    return (
      normalized !== "/_opencloud" && !normalized.startsWith("/_opencloud/")
    );
  } catch {
    return false;
  }
}

const digest = z.string().regex(/^[a-f0-9]{64}$/, "expected a SHA-256 digest");

/** Exact immutable SDK artifacts installed by this platform release. */
export const sdkVersionSchema = z.enum(["2.0.0", "2.1.0", "2.2.0", "2.3.0", "2.4.0", "2.5.0"], {
  error: "expected an installed SDK version: 2.0.0, 2.1.0, 2.2.0, 2.3.0, 2.4.0, or 2.5.0",
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
    timezone: z.string().min(1).max(100).refine(value => {
      try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
    }, "expected an IANA timezone").optional(),
    function: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    enabled: z.boolean().default(true),
  })
  .strict();

export const queueSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    function: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    concurrency: z.number().int().min(1).max(20).default(1),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    retryDelaySeconds: z.number().int().min(1).max(3_600).default(5),
    retryBackoff: z.boolean().default(true),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(15 * 60)
      .default(15 * 60),
  })
  .strict();

export const filesAccessSchema = z.enum(["user", "app"]);

export const secretModeSchema = z.enum(["generated", "required", "optional"]);

const integrationNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "integration names must use lowercase snake_case",
  );

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
      .regex(
        /^[a-z][a-z0-9-]*$/,
        "email address names must be lowercase aliases",
      ),
    displayName: z.string().trim().min(1).max(120).optional(),
    function: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,62}$/)
      .optional(),
  })
  .strict();

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

export const deploymentVersionSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const openCloudManifestFields = {
  data: z.object({ search: dataSearchDeclarationsSchema }).strict().optional(),
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
  queues: z.array(queueSchema).max(50).default([]),
  agentTasks: z.array(agentTaskDefinitionSchema).max(20).optional(),
  email: z
    .object({
      addresses: z.array(emailAddressSchema).max(25).default([]),
    })
    .strict()
    .optional(),
  notifications: z
    .object({
      webPush: z.literal(true),
      icon: sameOriginAbsolutePath.optional(),
    })
    .strict()
    .optional(),
  health: z
    .object({ path: appHealthPath.default("/") })
    .strict()
    .default({ path: "/" }),
  secrets: z
    .record(secretNameSchema, secretModeSchema)
    .refine((secrets) => Object.keys(secrets).length <= 100, {
      message: "apps may declare at most 100 secrets",
    })
    .default({}),
  integrations: z
    .record(integrationNameSchema, integrationDefinitionSchema)
    .refine((integrations) => Object.keys(integrations).length <= 20, {
      message: "apps may declare at most 20 integrations",
    })
    .default({}),
  observability: z
    .object({
      metrics: z.array(customMetricDefinitionSchema).max(20).default([]),
      alertRules: z.array(manifestAlertRuleSchema).max(20).optional(),
    })
    .strict()
    .optional(),
};

export const openCloudManifestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    appId: z.uuid(),
    version: deploymentVersionSchema,
    ...openCloudManifestFields,
  })
  .strict();

export const openCloudManifestV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    appId: z.uuid(),
    ...openCloudManifestFields,
    routes: appRoutesSchema.optional(),
  })
  .strict();

export const openCloudManifestSchema = z
  .discriminatedUnion("schemaVersion", [
    openCloudManifestV2Schema,
    openCloudManifestV3Schema,
  ])
  .superRefine((manifest, context) => {
    if (manifest.data?.search.length && !["2.4.0", "2.5.0"].includes(manifest.runtime.sdk.version)) {
      context.addIssue({ code: "custom", path: ["data", "search"], message: "Data search requires runtime SDK version 2.4.0" });
    }
    if (manifest.schemaVersion === 3 && manifest.routes) {
      manifest.routes.forEach((route, index) => {
        if (!("function" in route)) return;
        const target = manifest.functions.find((definition) => definition.name === route.function);
        if (!target || target.access === "system") {
          context.addIssue({ code: "custom", path: ["routes", index, "function"], message: "Route must reference a declared user or public Function" });
        }
        if (!["2.3.0", "2.4.0", "2.5.0"].includes(manifest.runtime.sdk.version)) {
          context.addIssue({ code: "custom", path: ["routes", index, "function"], message: "Function routes require runtime SDK version 2.3.0 or later" });
        }
        try {
          const healthUrl = new URL(manifest.health.path, "https://opencloud-health.invalid");
          const health = parseAppRouteRequest(`${healthUrl.pathname}${healthUrl.search}`, "GET");
          const matched = matchAppRoute(compileAppRoutes([route]), health);
          if (matched.kind === "matched" || matched.kind === "method-not-allowed") {
            context.addIssue({ code: "custom", path: ["routes", index, "path"], message: "Function routes must not match the manifest health path" });
          }
        } catch (error) {
          if (!(error instanceof AppRouteError)) throw error;
          // Old health paths keep their accepted normalization contract. New
          // route patterns have already received indexed schema validation.
          if (error.code === "INVALID_ROUTE_REQUEST") return;
          context.addIssue({ code: "custom", path: ["routes", index, ...error.path], message: error.message });
        }
      });
    }
    if (
      manifest.notifications?.webPush &&
      manifest.runtime.sdk.version === "2.0.0"
    ) {
      context.addIssue({
        code: "custom",
        path: ["notifications", "webPush"],
        message:
          "Web Push notifications require runtime SDK version 2.1.0 or later",
      });
    }
    for (const [name, integration] of Object.entries(manifest.integrations)) {
      if (
        ["google-analytics", "google-search-console", "google-ads"].includes(
          integration.provider,
        ) &&
        (manifest.runtime.sdk.version === "2.0.0" ||
          manifest.runtime.sdk.version === "2.1.0")
      ) {
        context.addIssue({
          code: "custom",
          path: ["integrations", name, "provider"],
          message: `${integration.provider} requires runtime SDK version 2.2.0 or later`,
        });
      }
    }
    const assertUnique = (
      values: string[],
      path:
        | "migrations"
        | "functions"
        | "cron"
        | "queues"
        | "agentTasks"
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
    assertUnique(
      manifest.cron.map((cron) => cron.name),
      "cron",
    );
    assertUnique(
      manifest.queues.map((queue) => queue.name),
      "queues",
    );
    assertUnique((manifest.agentTasks ?? []).map(task => task.name), "agentTasks");
    for (const [index, task] of (manifest.agentTasks ?? []).entries()) {
      if (manifest.runtime.sdk.version !== "2.5.0") {
        context.addIssue({ code: "custom", path: ["agentTasks", index], message: "Agent tasks require runtime SDK 2.5.0" });
      }
      if (!manifest.functions.some(fn => fn.name === task.resultFunction)) {
        context.addIssue({ code: "custom", path: ["agentTasks", index, "resultFunction"],
          message: "Agent task result Function must be declared" });
      }
    }
    assertUnique(
      (manifest.email?.addresses ?? []).map((address) => address.name),
      "email",
    );
    assertUnique(
      (manifest.observability?.metrics ?? []).map((metric) => metric.name),
      "observability",
    );
    const alertRuleIds = new Set<string>();
    (manifest.observability?.alertRules ?? []).forEach((rule, index) => {
      if (alertRuleIds.has(rule.id)) {
        context.addIssue({
          code: "custom",
          path: ["observability", "alertRules", index, "id"],
          message: `observability alert rule IDs must be unique: ${rule.id}`,
        });
      }
      alertRuleIds.add(rule.id);
      const metric = manifest.observability?.metrics.find(
        (definition) => definition.name === rule.metric,
      );
      if (!metric) {
        context.addIssue({
          code: "custom",
          path: ["observability", "alertRules", index, "metric"],
          message: `alert rule references unknown metric: ${rule.metric}`,
        });
        return;
      }
      const aggregationIsValid =
        metric.type === "counter"
          ? rule.aggregation === "sum" || rule.aggregation === "rate"
          : ["latest", "min", "max", "avg"].includes(rule.aggregation);
      if (!aggregationIsValid) {
        context.addIssue({
          code: "custom",
          path: ["observability", "alertRules", index, "aggregation"],
          message: `${rule.aggregation} is not valid for a ${metric.type} metric`,
        });
      }
    });
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
          message: `cron function ${cron.function} must declare access: system`,
        });
      }
      try {
        CronExpressionParser.parse(cron.schedule, { tz: cron.timezone ?? "Etc/UTC" });
      } catch {
        context.addIssue({
          code: "custom",
          path: ["cron", index, "schedule"],
          message: `invalid cron schedule: ${cron.schedule}`,
        });
      }
    });
    manifest.queues.forEach((queue, index) => {
      const target = manifest.functions.find(
        (definition) => definition.name === queue.function,
      );
      if (!target) {
        context.addIssue({
          code: "custom",
          path: ["queues", index, "function"],
          message: `queue references unknown function: ${queue.function}`,
        });
      } else if (target.access !== "system") {
        context.addIssue({
          code: "custom",
          path: ["queues", index, "function"],
          message: `queue function ${queue.function} must declare access: system`,
        });
      }
    });
    (manifest.email?.addresses ?? []).forEach((address, index) => {
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
          message: `email function ${address.function} must declare access: system`,
        });
      }
    });
    Object.entries(manifest.integrations).forEach(
      ([integrationName, integration]) => {
        const messageHandler = integration.events?.message?.function;
        const asanaHandler = integration.events?.function;
        const handler = messageHandler ?? asanaHandler;
        if (!handler) return;
        const target = manifest.functions.find(
          (definition) => definition.name === handler,
        );
        const handlerPath = messageHandler
          ? ["integrations", integrationName, "events", "message", "function"]
          : ["integrations", integrationName, "events", "function"];
        if (!target) {
          context.addIssue({
            code: "custom",
            path: handlerPath,
            message: `${integration.provider} event references unknown function: ${handler}`,
          });
        } else if (target.access !== "system") {
          context.addIssue({
            code: "custom",
            path: handlerPath,
            message: `${integration.provider} event function ${handler} must declare access: system`,
          });
        }
      },
    );
  });

export type OpenCloudManifest = z.infer<typeof openCloudManifestSchema>;
export type OpenCloudManifestV2 = z.infer<typeof openCloudManifestV2Schema>;
export type OpenCloudManifestV3 = z.infer<typeof openCloudManifestV3Schema>;
export type OpenCloudMigration = z.infer<typeof migrationSchema>;
export type FilesAccess = z.infer<typeof filesAccessSchema>;
export type FunctionAccess = z.infer<typeof functionAccessSchema>;
export type SecretMode = z.infer<typeof secretModeSchema>;
export type IntegrationAccount = z.infer<typeof integrationAccountSchema>;
export type IntegrationCardinality = z.infer<
  typeof integrationCardinalitySchema
>;
export type IntegrationCapability = z.infer<typeof integrationCapabilitySchema>;
export type IntegrationDefinition = z.infer<typeof integrationDefinitionSchema>;
export type SdkVersion = z.infer<typeof sdkVersionSchema>;
export type OpenCloudEmailAddress = z.infer<typeof emailAddressSchema>;
export type OpenCloudNotifications = NonNullable<
  OpenCloudManifest["notifications"]
>;
export type OpenCloudQueue = z.infer<typeof queueSchema>;
export type CustomMetricDefinition = z.infer<
  typeof customMetricDefinitionSchema
>;
export type ManifestAlertRule = z.infer<typeof manifestAlertRuleSchema>;

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
