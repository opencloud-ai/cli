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
