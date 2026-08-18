import { z } from "zod";
import { CronExpressionParser } from "cron-parser";

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

export const integrationAccountSchema = z.enum(["app", "calling_user"]);

export const integrationCardinalitySchema = z.enum(["one", "many"]);

export const integrationCapabilitySchema = z.enum([
  "calendar.events.read",
  "calendar.events.create",
  "drive.files.read",
  "drive.files.write",
  "sheets.spreadsheets.read",
  "sheets.spreadsheets.write",
  "docs.documents.read",
  "docs.documents.write",
  "slides.presentations.read",
  "slides.presentations.write",
  "bank.accounts.read",
  "bank.balances.read",
  "bank.transactions.read",
  "payments.received.reconcile",
  "transfers.sent.read",
  "slack.messages.send",
  "slack.messages.receive",
  "telegram.messages.send",
  "telegram.messages.receive",
  "asana.tasks.read",
  "asana.tasks.create",
  "asana.tasks.update",
  "asana.assignees.read",
  "asana.assignees.write",
  "asana.sections.read",
  "asana.sections.move_tasks",
  "asana.custom_fields.read",
  "asana.custom_field_values.write",
  "asana.attachments.read",
  "asana.attachments.write",
  "asana.stories.read",
  "asana.comments.write",
  "asana.events.receive",
  "crm.contacts.read",
  "crm.contacts.write",
  "crm.companies.read",
  "crm.companies.write",
  "crm.deals.read",
  "crm.deals.write",
  "crm.owners.read",
  "crm.pipelines.read",
  "crm.notes.write",
  "crm.associations.write",
]);

export const integrationProviderSchema = z.enum([
  "google-calendar",
  "google-drive",
  "google-sheets",
  "google-docs",
  "google-slides",
  "gocardless-bank-account-data",
  "wise-balance-webhook",
  "slack",
  "telegram",
  "asana",
  "hubspot-crm",
]);

const capabilitiesForProvider: Record<
  z.infer<typeof integrationProviderSchema>,
  ReadonlySet<z.infer<typeof integrationCapabilitySchema>>
> = {
  "google-calendar": new Set([
    "calendar.events.read",
    "calendar.events.create",
  ]),
  "google-drive": new Set(["drive.files.read", "drive.files.write"]),
  "google-sheets": new Set([
    "sheets.spreadsheets.read",
    "sheets.spreadsheets.write",
  ]),
  "google-docs": new Set(["docs.documents.read", "docs.documents.write"]),
  "google-slides": new Set([
    "slides.presentations.read",
    "slides.presentations.write",
  ]),
  "gocardless-bank-account-data": new Set([
    "bank.accounts.read",
    "bank.balances.read",
    "bank.transactions.read",
  ]),
  "wise-balance-webhook": new Set([
    "payments.received.reconcile",
    "transfers.sent.read",
  ]),
  slack: new Set(["slack.messages.send", "slack.messages.receive"]),
  telegram: new Set(["telegram.messages.send", "telegram.messages.receive"]),
  asana: new Set([
    "asana.tasks.read",
    "asana.tasks.create",
    "asana.tasks.update",
    "asana.assignees.read",
    "asana.assignees.write",
    "asana.sections.read",
    "asana.sections.move_tasks",
    "asana.custom_fields.read",
    "asana.custom_field_values.write",
    "asana.attachments.read",
    "asana.attachments.write",
    "asana.stories.read",
    "asana.comments.write",
    "asana.events.receive",
  ]),
  "hubspot-crm": new Set([
    "crm.contacts.read",
    "crm.contacts.write",
    "crm.companies.read",
    "crm.companies.write",
    "crm.deals.read",
    "crm.deals.write",
    "crm.owners.read",
    "crm.pipelines.read",
    "crm.notes.write",
    "crm.associations.write",
  ]),
};

const integrationEventFunctionSchema = z
  .object({
    function: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  })
  .strict();

export const integrationEventsSchema = z
  .object({
    message: integrationEventFunctionSchema.optional(),
    function: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,62}$/)
      .optional(),
  })
  .strict();

export const integrationDefinitionSchema = z
  .object({
    provider: integrationProviderSchema,
    account: integrationAccountSchema,
    cardinality: integrationCardinalitySchema.default("one"),
    capabilities: z
      .array(integrationCapabilitySchema)
      .min(1)
      .max(20)
      .refine(
        (capabilities) => new Set(capabilities).size === capabilities.length,
        "integration capabilities must be unique",
      ),
    events: integrationEventsSchema.optional(),
  })
  .strict()
  .superRefine((definition, context) => {
    const allowed = capabilitiesForProvider[definition.provider];
    definition.capabilities.forEach((capability, index) => {
      if (!allowed.has(capability)) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", index],
          message: `${capability} is not supported by ${definition.provider}`,
        });
      }
    });
    if (
      definition.provider === "wise-balance-webhook" &&
      definition.account !== "app"
    ) {
      context.addIssue({
        code: "custom",
        path: ["account"],
        message: "wise-balance-webhook integrations must use the app account",
      });
    }
    if (["slack", "telegram", "hubspot-crm"].includes(definition.provider)) {
      if (definition.account !== "app") {
        context.addIssue({
          code: "custom",
          path: ["account"],
          message: `${definition.provider} integrations must use the app account`,
        });
      }
    }
    if (
      definition.provider === "hubspot-crm" &&
      definition.capabilities.includes("crm.associations.write") &&
      !definition.capabilities.some((capability) =>
        [
          "crm.contacts.write",
          "crm.companies.write",
          "crm.deals.write",
          "crm.notes.write",
        ].includes(capability),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message:
          "crm.associations.write requires at least one CRM record write capability",
      });
    }
    if (["slack", "telegram"].includes(definition.provider)) {
      const receivesMessages = definition.capabilities.includes(
        definition.provider === "slack"
          ? "slack.messages.receive"
          : "telegram.messages.receive",
      );
      if (receivesMessages && !definition.events?.message) {
        context.addIssue({
          code: "custom",
          path: ["events", "message"],
          message: `${definition.provider}.messages.receive requires an events.message system Function`,
        });
      } else if (!receivesMessages && definition.events?.message) {
        context.addIssue({
          code: "custom",
          path: ["events", "message"],
          message: `events.message requires the ${definition.provider}.messages.receive capability`,
        });
      }
      if (definition.events?.function) {
        context.addIssue({
          code: "custom",
          path: ["events", "function"],
          message: "events.function is supported only by asana integrations",
        });
      }
    } else if (definition.provider === "asana") {
      const receivesAsanaEvents = definition.capabilities.includes(
        "asana.events.receive",
      );
      const taskStateMutation = [
        "asana.tasks.create",
        "asana.tasks.update",
        "asana.assignees.write",
        "asana.sections.move_tasks",
        "asana.custom_field_values.write",
      ].find((capability) =>
        definition.capabilities.includes(
          capability as z.infer<typeof integrationCapabilitySchema>,
        ),
      );
      if (
        taskStateMutation &&
        !definition.capabilities.includes("asana.tasks.read")
      ) {
        context.addIssue({
          code: "custom",
          path: ["capabilities"],
          message: `${taskStateMutation} requires asana.tasks.read because task mutations return normalized current task state`,
        });
      }
      if (receivesAsanaEvents && definition.account !== "app") {
        context.addIssue({
          code: "custom",
          path: ["account"],
          message: "asana event integrations must use the app account",
        });
      }
      if (receivesAsanaEvents && !definition.events?.function) {
        context.addIssue({
          code: "custom",
          path: ["events", "function"],
          message: "asana.events.receive requires an events.function handler",
        });
      }
      if (definition.events?.function && !receivesAsanaEvents) {
        context.addIssue({
          code: "custom",
          path: ["capabilities"],
          message: "events.function requires asana.events.receive",
        });
      }
      if (
        receivesAsanaEvents &&
        !definition.capabilities.includes("asana.tasks.read")
      ) {
        context.addIssue({
          code: "custom",
          path: ["capabilities"],
          message:
            "asana.events.receive requires asana.tasks.read so OpenCloud can deliver current task state",
        });
      }
      if (definition.events?.message) {
        context.addIssue({
          code: "custom",
          path: ["events", "message"],
          message:
            "events.message is supported only by slack and telegram integrations",
        });
      }
    } else if (definition.events) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message:
          "integration events are currently supported only by slack, telegram, and asana",
      });
    }
  });

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
    queues: z.array(queueSchema).max(50).default([]),
    email: z
      .object({
        addresses: z.array(emailAddressSchema).max(25).default([]),
      })
      .strict()
      .optional(),
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
    integrations: z
      .record(integrationNameSchema, integrationDefinitionSchema)
      .refine((integrations) => Object.keys(integrations).length <= 20, {
        message: "apps may declare at most 20 integrations",
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
        | "queues"
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
    assertUnique(
      (manifest.email?.addresses ?? []).map((address) => address.name),
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
          message: `cron function ${cron.function} must declare access: system`,
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
export type OpenCloudQueue = z.infer<typeof queueSchema>;
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
