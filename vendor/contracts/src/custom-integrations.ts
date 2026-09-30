import { z } from "zod";
import {
  customIntegrationCapabilitySchema,
  customIntegrationCredentialNameSchema,
  customIntegrationEventTypeSchema,
  customIntegrationNameSchema,
  customIntegrationOperationNameSchema,
} from "./integration-manifest.js";

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const boundedLabel = z.string().trim().min(1).max(160);
const slotName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

export const customIntegrationConnectionCustodySchema = z.enum([
  "personal",
  "organisation",
]);

/** Browser-safe metadata; credential values are write-only and never returned. */
export const customIntegrationConnectionSchema = z.object({
  id: uuid,
  providerAppId: uuid,
  integration: z.string().min(1).max(63),
  custody: customIntegrationConnectionCustodySchema,
  label: boundedLabel,
  status: z.enum(["pending", "active", "reconnect_required"]),
  fields: z
    .array(
      z.object({
        name: customIntegrationCredentialNameSchema,
        set: z.boolean(),
      }),
    )
    .max(20),
  ownedByCurrentUser: z.boolean(),
  manageable: z.boolean(),
  // Present only for people who manage the connection; it authorizes posting
  // webhook deliveries to the provider for this connection.
  webhookUrl: z.url().max(2_048).nullable(),
  sync: z
    .object({
      nextRunAt: timestamp.nullable(),
      lastStartedAt: timestamp.nullable(),
      lastFinishedAt: timestamp.nullable(),
      lastStatus: z.enum(["succeeded", "failed"]).nullable(),
      lastErrorCode: z.string().max(100).nullable(),
    })
    .nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastUsedAt: timestamp.nullable(),
  usages: z
    .array(
      z.object({
        bindingId: uuid,
        appId: uuid,
        appName: z.string().min(1).max(160),
        integrationName: slotName,
        label: boundedLabel,
        callingUser: z.boolean(),
      }),
    )
    .max(500),
});

export const customIntegrationOperationSummarySchema = z.object({
  name: customIntegrationOperationNameSchema,
  capability: customIntegrationCapabilitySchema,
  description: z.string().min(1).max(500),
  input: z.record(z.string(), z.json()).nullable(),
  output: z.record(z.string(), z.json()).nullable(),
  fake: z.json(),
});

export const customIntegrationCatalogEntrySchema = z.object({
  providerAppId: uuid,
  providerAppName: z.string().min(1).max(160),
  organisationId: uuid,
  name: customIntegrationNameSchema,
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  authorization: z.discriminatedUnion("type", [
    z.object({ type: z.literal("credentials") }),
    z.object({
      type: z.literal("oauth2"),
      scopes: z.array(z.string().min(1).max(200)).max(50),
      // Register this exact callback with the provider's OAuth application.
      redirectUri: z.url().max(2_048),
    }),
  ]),
  events: z
    .array(
      z.object({
        type: customIntegrationEventTypeSchema,
        capability: customIntegrationCapabilitySchema,
        description: z.string().min(1).max(500),
        fake: z.json(),
      }),
    )
    .max(50),
  sync: z
    .object({
      schedule: z.string().min(5).max(100),
      timezone: z.string().min(1).max(100).nullable(),
    })
    .nullable(),
  webhook: z.boolean(),
  credentials: z
    .array(
      z.object({
        name: customIntegrationCredentialNameSchema,
        label: z.string().min(1).max(80),
        description: z.string().min(1).max(240).nullable(),
        secret: z.boolean(),
        optional: z.boolean(),
      }),
    )
    .max(20),
  capabilities: z
    .array(
      z.object({
        name: customIntegrationCapabilitySchema,
        description: z.string().min(1).max(240),
      }),
    )
    .max(50),
  operations: z.array(customIntegrationOperationSummarySchema).max(100),
  canConnectForOrganisation: z.boolean(),
  canAdminister: z.boolean(),
  connections: z.array(customIntegrationConnectionSchema).max(200),
});

export const customIntegrationCatalogSchema = z.object({
  integrations: z.array(customIntegrationCatalogEntrySchema).max(200),
});

const credentialValues = z
  .record(customIntegrationCredentialNameSchema, z.string().min(1).max(8_192))
  .refine((fields) => Object.keys(fields).length <= 20, {
    message: "connections may store at most 20 credential fields",
  });

export const createCustomIntegrationConnectionRequestSchema = z
  .object({
    label: boundedLabel,
    custody: customIntegrationConnectionCustodySchema.default("personal"),
    fields: credentialValues,
  })
  .strict();

export const updateCustomIntegrationConnectionRequestSchema = z
  .object({
    label: boundedLabel.optional(),
    fields: credentialValues.optional(),
  })
  .strict()
  .refine((input) => input.label !== undefined || input.fields !== undefined, {
    message: "Provide a new label or credential values",
  });

/** Starts an OAuth sign-in with the provider; optionally binds for a calling user. */
export const beginCustomIntegrationAuthorizationRequestSchema = z
  .object({
    label: boundedLabel,
    custody: customIntegrationConnectionCustodySchema.default("personal"),
    fields: credentialValues.optional(),
    // Reconnect an existing connection instead of creating another.
    connectionId: uuid.optional(),
    appId: uuid.optional(),
    integrationName: slotName.optional(),
    returnTo: z.string().max(2_048).optional(),
  })
  .strict()
  .refine((input) => Boolean(input.appId) === Boolean(input.integrationName), {
    message: "appId and integrationName must be provided together",
  });

export const customIntegrationAuthorizationDestinationSchema = z.object({
  authorizationUrl: z.url().max(8_192),
  expiresAt: timestamp,
});

export const customIntegrationSyncRunSchema = z.object({
  connectionId: uuid,
  nextRunAt: timestamp,
});

export const integrationEventDeliverySchema = z.object({
  id: uuid,
  eventId: z.string().min(1).max(200),
  eventType: customIntegrationEventTypeSchema,
  integrationName: slotName,
  handlerFunction: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  environment: z.enum(["production", "dev"]),
  status: z.enum(["queued", "processing", "delivered", "failed"]),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().max(1_000).nullable(),
  occurredAt: timestamp,
  createdAt: timestamp,
  deliveredAt: timestamp.nullable(),
});

export const integrationEventDeliveriesSchema = z.object({
  deliveries: z.array(integrationEventDeliverySchema).max(100),
});

export const injectDevIntegrationEventRequestSchema = z
  .object({
    type: customIntegrationEventTypeSchema,
    // Defaults to the provider's declared fake data for this event type.
    data: z.record(z.string(), z.json()).optional(),
    id: z.string().min(1).max(200).optional(),
  })
  .strict();

export const injectDevIntegrationEventResultSchema = z.object({
  eventId: z.string().min(1).max(200),
  delivered: z.boolean(),
  status: z.number().int().min(100).max(599),
  requestId: z.string().min(1).max(200),
  error: z
    .object({ code: z.string().max(100), message: z.string().max(1_000) })
    .nullable(),
});

export const devIntegrationModeSchema = z.enum(["fake", "live"]);

/**
 * Development-only integration behaviour. Slots default to deterministic fake
 * output; live slots use the app's production bindings. Verification sandboxes
 * always use fake output.
 */
export const devSessionIntegrationSettingsSchema = z.object({
  sessionId: uuid,
  slots: z
    .array(
      z.object({
        integrationName: slotName,
        provider: z.string().min(1).max(100),
        mode: devIntegrationModeSchema,
        liveAvailable: z.boolean(),
      }),
    )
    .max(20),
  providedIntegration: z
    .object({
      name: customIntegrationNameSchema,
      testConnectionId: uuid.nullable(),
      eligibleTestConnections: z
        .array(
          z.object({
            id: uuid,
            label: boundedLabel,
            custody: customIntegrationConnectionCustodySchema,
          }),
        )
        .max(200),
    })
    .nullable(),
});

export type CustomIntegrationConnection = z.infer<
  typeof customIntegrationConnectionSchema
>;
export type CustomIntegrationCatalogEntry = z.infer<
  typeof customIntegrationCatalogEntrySchema
>;
export type CustomIntegrationCatalog = z.infer<
  typeof customIntegrationCatalogSchema
>;
export type CreateCustomIntegrationConnectionRequest = z.infer<
  typeof createCustomIntegrationConnectionRequestSchema
>;
export type UpdateCustomIntegrationConnectionRequest = z.infer<
  typeof updateCustomIntegrationConnectionRequestSchema
>;
export type DevIntegrationMode = z.infer<typeof devIntegrationModeSchema>;
export type DevSessionIntegrationSettings = z.infer<
  typeof devSessionIntegrationSettingsSchema
>;
export type BeginCustomIntegrationAuthorizationRequest = z.infer<
  typeof beginCustomIntegrationAuthorizationRequestSchema
>;
export type IntegrationEventDelivery = z.infer<typeof integrationEventDeliverySchema>;
export type InjectDevIntegrationEventRequest = z.infer<
  typeof injectDevIntegrationEventRequestSchema
>;
export type InjectDevIntegrationEventResult = z.infer<
  typeof injectDevIntegrationEventResultSchema
>;
export type CustomIntegrationSyncRun = z.infer<typeof customIntegrationSyncRunSchema>;
