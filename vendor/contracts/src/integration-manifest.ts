import { z } from "zod";

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
  "analytics.reports.read",
  "search.performance.read",
  "ads.reporting.read",
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
  "google-analytics",
  "google-search-console",
  "google-ads",
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
  "google-analytics": new Set(["analytics.reports.read"]),
  "google-search-console": new Set(["search.performance.read"]),
  "google-ads": new Set(["ads.reporting.read"]),
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

/** Built-in providers whose operations OpenCloud implements directly. */
export const builtInIntegrationDefinitionSchema = z
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
    if (
      [
        "slack",
        "telegram",
        "hubspot-crm",
        "google-analytics",
        "google-search-console",
        "google-ads",
      ].includes(definition.provider)
    ) {
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

const MAX_CONTRACT_DOCUMENT_BYTES = 16 * 1024;

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;
}

/** Organisation-unique name of an integration published by an OpenCloud app. */
export const customIntegrationNameSchema = z
  .string()
  .min(2)
  .max(63)
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    "custom integration names use lowercase kebab-case such as acme-erp",
  );

export const customIntegrationCapabilitySchema = z
  .string()
  .min(3)
  .max(100)
  .regex(
    /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/,
    "custom integration capabilities use lowercase dotted names such as orders.read",
  );

/** Matches the operation names accepted by `integrations.use(slot).call()`. */
export const customIntegrationOperationNameSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(
    /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/,
    "operation names use dotted camelCase segments such as orders.list",
  )
  .refine(
    (name) => name !== "bindings.list" && !name.endsWith(".bindings.list"),
    "bindings.list operation names are reserved by OpenCloud",
  );

export const customIntegrationCredentialNameSchema = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9_]{0,127}$/,
    "credential names use uppercase secret names such as ERP_API_KEY",
  )
  .refine(
    (name) => !name.startsWith("OPENCLOUD_") && !name.startsWith("SUPABASE_"),
    "credential uses a reserved OpenCloud runtime prefix",
  );

const contractDocumentSchema = z
  .record(z.string(), z.json())
  .refine((value) => jsonBytes(value) <= MAX_CONTRACT_DOCUMENT_BYTES, {
    message: "contract documents are limited to 16 KiB",
  });

const functionNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

const boundedFakeSchema = z
  .json()
  .refine((value) => jsonBytes(value) <= MAX_CONTRACT_DOCUMENT_BYTES, {
    message: "fake output is limited to 16 KiB",
  });

export const customIntegrationEventTypeSchema = z
  .string()
  .min(3)
  .max(100)
  .regex(
    /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/,
    "event types use lowercase dotted names such as order.created",
  );

/** A consumer app slot that uses an integration published in its organisation. */
export const customIntegrationDefinitionSchema = z
  .object({
    provider: z.literal("custom"),
    integration: customIntegrationNameSchema,
    account: integrationAccountSchema,
    cardinality: integrationCardinalitySchema.default("one"),
    capabilities: z
      .array(customIntegrationCapabilitySchema)
      .min(1)
      .max(50)
      .refine(
        (capabilities) => new Set(capabilities).size === capabilities.length,
        "integration capabilities must be unique",
      ),
    // Delivers the provider's events for bound connections to a system Function.
    events: z
      .object({
        function: functionNameSchema,
        types: z
          .array(customIntegrationEventTypeSchema)
          .min(1)
          .max(50)
          .refine(
            (types) => new Set(types).size === types.length,
            "event types must be unique",
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((definition, context) => {
    if (definition.events && definition.account !== "app") {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "custom integration events require account: app",
      });
    }
  });

export const integrationDefinitionSchema = z.discriminatedUnion("provider", [
  builtInIntegrationDefinitionSchema,
  customIntegrationDefinitionSchema,
]);

export const providedIntegrationCredentialSchema = z
  .object({
    name: customIntegrationCredentialNameSchema,
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(240).optional(),
    secret: z.boolean().default(true),
    optional: z.boolean().default(false),
  })
  .strict();

export const providedIntegrationCapabilitySchema = z
  .object({
    name: customIntegrationCapabilitySchema,
    description: z.string().trim().min(1).max(240),
  })
  .strict();

export const providedIntegrationOperationSchema = z
  .object({
    name: customIntegrationOperationNameSchema,
    capability: customIntegrationCapabilitySchema,
    function: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    description: z.string().trim().min(1).max(500),
    input: contractDocumentSchema.optional(),
    output: contractDocumentSchema.optional(),
    // Deterministic development output returned instead of calling the
    // provider while a consumer slot is in fake mode.
    fake: boundedFakeSchema,
  })
  .strict();

const httpsUrlSchema = z
  .string()
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" && !url.username && !url.password && !url.hash
      );
    } catch {
      return false;
    }
  }, "must be an https URL without credentials or a fragment");

/**
 * How a person connects. `credentials` stores the declared fields; `oauth2`
 * sends the person to the provider's authorization page and lets the provider
 * app's own system Functions exchange and refresh tokens, so OpenCloud never
 * contacts provider token endpoints itself.
 */
export const providedIntegrationAuthorizationSchema = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("credentials") }).strict(),
    z
      .object({
        type: z.literal("oauth2"),
        authorizationUrl: httpsUrlSchema,
        clientId: z.string().trim().min(1).max(512),
        scopes: z
          .array(z.string().trim().min(1).max(200).regex(/^\S+$/))
          .max(50)
          .default([]),
        pkce: z.boolean().default(true),
        exchange: functionNameSchema,
        refresh: functionNameSchema.optional(),
        // Credential name under which operation Functions read the access token.
        accessToken: customIntegrationCredentialNameSchema.default(
          "OAUTH_ACCESS_TOKEN",
        ),
      })
      .strict(),
  ],
);

export const providedIntegrationEventSchema = z
  .object({
    type: customIntegrationEventTypeSchema,
    capability: customIntegrationCapabilitySchema,
    description: z.string().trim().min(1).max(500),
    // Synthetic event data used for development injection.
    fake: boundedFakeSchema,
  })
  .strict();

export const providedIntegrationSyncSchema = z
  .object({
    function: functionNameSchema,
    schedule: z.string().min(5).max(100),
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value }).format();
          return true;
        } catch {
          return false;
        }
      }, "expected an IANA timezone")
      .optional(),
  })
  .strict();

/** Contract published by an app that provides an integration to its organisation. */
export const providedIntegrationSchema = z
  .object({
    name: customIntegrationNameSchema,
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    authorization: providedIntegrationAuthorizationSchema.default({
      type: "credentials",
    }),
    credentials: z.array(providedIntegrationCredentialSchema).max(20).default([]),
    capabilities: z.array(providedIntegrationCapabilitySchema).min(1).max(50),
    operations: z.array(providedIntegrationOperationSchema).min(1).max(100),
    // Runs once per bound connection on a schedule.
    sync: providedIntegrationSyncSchema.optional(),
    // Receives requests posted to each connection's webhook URL.
    webhook: z.object({ function: functionNameSchema }).strict().optional(),
    events: z.array(providedIntegrationEventSchema).max(50).default([]),
  })
  .strict()
  .superRefine((contract, context) => {
    const unique = (
      values: string[],
      path: "credentials" | "capabilities" | "operations" | "events",
      field: "name" | "type" = "name",
    ) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            path: [path, index, field],
            message: `${path} ${field}s must be unique: ${value}`,
          });
        }
        seen.add(value);
      });
    };
    unique(
      contract.credentials.map((credential) => credential.name),
      "credentials",
    );
    unique(
      contract.capabilities.map((capability) => capability.name),
      "capabilities",
    );
    unique(
      contract.operations.map((operation) => operation.name),
      "operations",
    );
    const capabilities = new Set(
      contract.capabilities.map((capability) => capability.name),
    );
    contract.operations.forEach((operation, index) => {
      if (!capabilities.has(operation.capability)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "capability"],
          message: `operation ${operation.name} references undeclared capability ${operation.capability}`,
        });
      }
    });
    unique(
      contract.events.map((event) => event.type),
      "events",
      "type",
    );
    contract.events.forEach((event, index) => {
      if (!capabilities.has(event.capability)) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "capability"],
          message: `event ${event.type} references undeclared capability ${event.capability}`,
        });
      }
    });
    if (
      contract.authorization.type === "oauth2" &&
      contract.credentials.some(
        (credential) =>
          contract.authorization.type === "oauth2" &&
          credential.name === contract.authorization.accessToken,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["authorization", "accessToken"],
        message: "the OAuth access token name must differ from every credential name",
      });
    }
  });

export type BuiltInIntegrationDefinition = z.infer<
  typeof builtInIntegrationDefinitionSchema
>;
export type CustomIntegrationDefinition = z.infer<
  typeof customIntegrationDefinitionSchema
>;
export type ProvidedIntegration = z.infer<typeof providedIntegrationSchema>;
export type ProvidedIntegrationOperation = z.infer<
  typeof providedIntegrationOperationSchema
>;
export type ProvidedIntegrationCredential = z.infer<
  typeof providedIntegrationCredentialSchema
>;
export type ProvidedIntegrationAuthorization = z.infer<
  typeof providedIntegrationAuthorizationSchema
>;
export type ProvidedIntegrationEvent = z.infer<
  typeof providedIntegrationEventSchema
>;
