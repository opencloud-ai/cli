import { z } from "zod";
import {
  integrationCapabilitySchema,
  integrationDefinitionSchema,
} from "./integration-manifest.js";

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const webUrl = (maximumLength = 8_192) =>
  z
    .url()
    .max(maximumLength)
    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
      message: "URL must use HTTP or HTTPS",
    });
const httpsUrl = (maximumLength = 8_192) =>
  z
    .url()
    .max(maximumLength)
    .refine((value) => new URL(value).protocol === "https:", {
      message: "URL must use HTTPS",
    });
export const dashboardIntegrationNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/);
const integrationName = dashboardIntegrationNameSchema;
const boundedLabel = z.string().trim().min(1).max(160);

export const accountIntegrationProviderSchema = z.enum([
  "google-workspace",
  "gocardless-bank-account-data",
  "wise-balance-webhook",
  "slack",
  "telegram",
  "asana",
  "hubspot-crm",
]);

export const accountIntegrationUsageSchema = z.object({
  bindingId: uuid,
  appId: uuid,
  appName: z.string().min(1).max(160),
  appUrl: webUrl(2_048).optional(),
  integrationName,
  label: boundedLabel,
});

/** Browser-safe provider connection metadata. Credential material is absent. */
export const accountIntegrationConnectionSchema = z.object({
  id: uuid,
  provider: accountIntegrationProviderSchema,
  accountLabel: z.string().min(1).max(320),
  status: z.enum(["active", "reconnect_required", "revoked"]),
  capabilities: z.array(integrationCapabilitySchema).max(100),
  createdAt: timestamp,
  updatedAt: timestamp.optional(),
  lastUsedAt: timestamp.nullable(),
  institutionId: z.string().max(200).nullable().optional(),
  country: z.string().length(2).nullable().optional(),
  webhookUrl: webUrl(2_048).nullable().optional(),
  webhookVerifiedAt: timestamp.nullable().optional(),
  webhookLastEventAt: timestamp.nullable().optional(),
  webhookEventTypes: z.array(z.string().min(1).max(100)).max(20).optional(),
  telegramChatType: z
    .enum(["private", "group", "supergroup"])
    .nullable()
    .optional(),
  telegramBotUsername: z.string().min(1).max(100).nullable().optional(),
  usages: z.array(accountIntegrationUsageSchema).max(500),
});

export const providerAuthorizationDestinationSchema = z.object({
  authorizationUrl: httpsUrl(),
  expiresAt: timestamp,
});

export const providerOAuthRequestSchema = z
  .object({
    capabilities: z
      .array(integrationCapabilitySchema)
      .min(1)
      .max(20)
      .optional(),
    existingConnectionId: uuid.optional(),
    appId: uuid.optional(),
    integrationName: integrationName.optional(),
    returnTo: z.string().max(2_048).optional(),
  })
  .strict()
  .refine((input) => Boolean(input.appId) === Boolean(input.integrationName), {
    message: "appId and integrationName must be provided together",
  });

export const bankConnectionRequestSchema = z
  .object({
    institutionId: z.string().trim().min(1).max(200),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/),
    existingConnectionId: uuid.optional(),
    appId: uuid.optional(),
    integrationName: integrationName.optional(),
    returnTo: z.string().max(2_048).optional(),
  })
  .strict()
  .refine((input) => Boolean(input.appId) === Boolean(input.integrationName), {
    message: "appId and integrationName must be provided together",
  });

export const bankInstitutionSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(320),
  bic: z.string().max(100).nullable().optional(),
  countries: z.array(z.string().length(2)).max(100),
  transactionTotalDays: z.number().int().nonnegative().optional(),
  maxAccessValidForDays: z.number().int().positive().optional(),
});

export const googleCalendarResourceSchema = z.object({
  id: z.string().min(1).max(1_024),
  label: boundedLabel,
  primary: z.boolean(),
  accessRole: z.string().min(1).max(100),
  timeZone: z.string().max(200).nullable(),
});

export const googleAnalyticsPropertySchema = z.object({
  id: z.string().min(1).max(1_024),
  label: boundedLabel,
  accountId: z.string().min(1).max(1_024),
  accountLabel: z.string().min(1).max(320),
  propertyType: z.string().max(100).nullable(),
});

export const googleSearchConsoleSiteSchema = z.object({
  id: z.string().min(1).max(1_024),
  label: boundedLabel,
  permissionLevel: z.string().min(1).max(100),
});

export const googleAdsCustomerSchema = z.object({
  id: z.string().min(1).max(1_024),
  label: boundedLabel,
  currencyCode: z.string().max(20).nullable(),
  timeZone: z.string().max(200).nullable(),
});

export const bankAccountSummarySchema = z.object({
  id: z.string().min(1).max(1_024),
  label: boundedLabel,
  status: z.string().max(100).nullable(),
});

export const slackChannelSchema = z.object({
  id: z.string().min(1).max(1_024),
  name: z.string().min(1).max(320),
  label: boundedLabel,
  isPrivate: z.boolean(),
});

export const asanaProjectSchema = z.object({
  id: z.string().min(1).max(1_024),
  name: z.string().min(1).max(500),
  archived: z.boolean(),
  workspaceId: z.string().min(1).max(1_024),
  workspaceName: z.string().min(1).max(500),
  modifiedAt: timestamp.nullable(),
});

export const appIntegrationBindingSchema = z.object({
  id: uuid,
  integrationName,
  connectionId: uuid,
  callingUserId: uuid.nullable().optional(),
  resourceId: z.string().min(1).max(1_024),
  label: boundedLabel,
  accountLabel: z.string().min(1).max(320).nullable(),
  status: z.enum(["active", "reconnect_required", "revoked"]).nullable(),
  capabilities: z.array(integrationCapabilitySchema).max(100).optional(),
  triggerMode: z.enum(["mention", "directed", "all_messages"]).nullable(),
  createdAt: timestamp.optional(),
  updatedAt: timestamp.optional(),
});

export const appIntegrationsOutputSchema = z.object({
  declarations: z.record(integrationName, integrationDefinitionSchema),
  bindings: z.array(appIntegrationBindingSchema).max(500),
});

export const bindAppIntegrationRequestSchema = z
  .object({
    connectionId: uuid,
    resourceId: z.string().trim().min(1).max(1_024),
    label: boundedLabel.default("Connected account"),
    triggerMode: z.enum(["mention", "directed", "all_messages"]).optional(),
  })
  .strict();

export const telegramPairingRequestSchema = z
  .object({
    appId: uuid,
    integrationName,
    triggerMode: z.enum(["directed", "all_messages"]).optional(),
  })
  .strict();

export const telegramPairingDestinationSchema = z.object({
  pairingId: uuid,
  botUsername: z.string().min(1).max(100),
  privateChatUrl: httpsUrl(2_048),
  groupChatUrl: httpsUrl(2_048),
  triggerMode: z.enum(["directed", "all_messages"]).nullable(),
  expiresAt: timestamp,
});

export const aiProviderSchema = z.enum(["openai", "anthropic"]);
export const aiAuthMethodSchema = z.enum([
  "device_oauth",
  "manual_oauth",
  "api_key",
]);
export const aiAuthorizationStatusSchema = z.enum([
  "pending",
  "exchanging",
  "completed",
  "denied",
  "failed",
  "expired",
  "cancelled",
]);

export const aiProviderConnectionSchema = z.object({
  schemaVersion: z.literal(1),
  id: uuid,
  provider: aiProviderSchema,
  label: z.string().trim().min(1).max(200),
  authMethod: aiAuthMethodSchema,
  status: z.enum(["pending", "connected", "expired", "error", "revoked"]),
  stateVersion: z.number().int().positive(),
  expiresAt: timestamp.nullable(),
  errorClass: z.string().trim().min(1).max(200).nullable(),
  accountHint: z.string().trim().min(1).max(320).nullable().optional(),
  isDefault: z.boolean().optional(),
  connectedAt: timestamp.nullable().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  revokedAt: timestamp.nullable(),
});

const aiAuthorizationBase = {
  schemaVersion: z.literal(1),
  attemptId: uuid,
  connection: aiProviderConnectionSchema,
  status: aiAuthorizationStatusSchema,
  authorizationUrl: httpsUrl(),
  expiresAt: timestamp,
  errorClass: z.string().trim().min(1).max(200).nullable(),
};

const aiAuthorizationStartBase = {
  schemaVersion: z.literal(1),
  attemptId: uuid,
  connection: aiProviderConnectionSchema,
  authorizationUrl: httpsUrl(),
  expiresAt: timestamp,
};

export const aiAuthorizationStartSchema = z.discriminatedUnion("method", [
  z.object({
    ...aiAuthorizationStartBase,
    method: z.literal("device_oauth"),
    userCode: z.string().trim().min(2).max(100),
    instructions: z.string().trim().min(1).max(1_000),
  }),
  z.object({
    ...aiAuthorizationStartBase,
    method: z.literal("manual_oauth"),
    instructions: z.string().trim().min(1).max(1_000),
  }),
]);

export const aiAuthorizationSchema = z.discriminatedUnion("method", [
  z.object({
    ...aiAuthorizationBase,
    method: z.literal("device_oauth"),
    userCode: z.string().trim().min(2).max(100),
    instructions: z.string().trim().min(1).max(1_000),
  }),
  z.object({
    ...aiAuthorizationBase,
    method: z.literal("manual_oauth"),
    instructions: z.string().trim().min(1).max(1_000),
  }),
]);

export const aiIntegrationOverviewSchema = z.object({
  schemaVersion: z.literal(1),
  providers: z
    .array(
      z.object({
        id: aiProviderSchema,
        displayName: z.string().min(1).max(200),
        authMethods: z
          .array(
            z.object({
              method: aiAuthMethodSchema,
              label: z.string().min(1).max(200),
              available: z.boolean(),
              unavailableReason: z.string().min(1).max(500).nullable(),
            }),
          )
          .max(10),
      }),
    )
    .max(10),
  models: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        label: z.string().min(1).max(200),
        provider: aiProviderSchema,
        userAvailable: z.boolean(),
        platformAvailable: z.boolean(),
      }),
    )
    .max(100),
  reasoningEfforts: z
    .array(
      z.object({
        id: z.enum(["none", "low", "medium", "high", "xhigh", "max"]),
        label: z.string().min(1).max(100),
      }),
    )
    .max(10),
  connections: z.array(aiProviderConnectionSchema).max(100),
  apps: z
    .array(
      z.object({
        id: uuid,
        name: z.string().min(1).max(160),
        slug: z.string().min(1).max(200),
        appUrl: webUrl(2_048),
        aiCredentialSource: z.enum(["owner", "user", "platform"]),
        providerConnectionId: uuid.nullable(),
        model: z.string().min(1).max(200),
        reasoningEffort: z.enum([
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ]),
        usage: z
          .object({
            appId: uuid,
            callCount: z.string().regex(/^\d+$/),
            completedCallCount: z.string().regex(/^\d+$/),
            inputTokens: z.string().regex(/^\d+$/),
            cachedInputTokens: z.string().regex(/^\d+$/),
            outputTokens: z.string().regex(/^\d+$/),
            reasoningTokens: z.string().regex(/^\d+$/),
            totalTokens: z.string().regex(/^\d+$/),
            lastUsedAt: timestamp.nullable(),
          })
          .strip()
          .nullable(),
        platformUsage: z
          .object({
            spentNanodollars: z.string().regex(/^\d+$/),
            reservedNanodollars: z.string().regex(/^\d+$/),
            agentSpentNanodollars: z.string().regex(/^\d+$/),
            functionSpentNanodollars: z.string().regex(/^\d+$/),
          })
          .nullable(),
      }),
    )
    .max(500),
});

export const createAiConnectionRequestSchema = z.discriminatedUnion(
  "authMethod",
  [
    z
      .object({
        provider: aiProviderSchema.default("openai"),
        authMethod: z.literal("device_oauth"),
        label: z.string().trim().min(1).max(200).optional(),
        reconnectConnectionId: uuid.optional(),
      })
      .strict(),
    z
      .object({
        provider: aiProviderSchema.default("openai"),
        authMethod: z.literal("manual_oauth"),
        label: z.string().trim().min(1).max(200).optional(),
        reconnectConnectionId: uuid.optional(),
      })
      .strict(),
    z
      .object({
        provider: aiProviderSchema.default("openai"),
        authMethod: z.literal("api_key"),
        label: z.string().trim().min(1).max(200).optional(),
        apiKey: z.string().trim().min(8).max(100_000),
        reconnectConnectionId: uuid.optional(),
      })
      .strict(),
  ],
);

export const createAiConnectionOutputSchema = z.union([
  aiAuthorizationStartSchema,
  z.object({
    schemaVersion: z.literal(1),
    connection: aiProviderConnectionSchema,
  }),
]);

export const updateAiConnectionRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    makeDefault: z.literal(true).optional(),
  })
  .strict()
  .refine((value) => value.label !== undefined || value.makeDefault === true, {
    message: "At least one AI connection setting is required",
  });

export const updateAppAiRequestSchema = z
  .object({
    aiCredentialSource: z.enum(["owner", "user", "platform"]),
    providerConnectionId: uuid.nullable(),
    model: z.string().trim().min(1).max(200),
    reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]),
  })
  .strict();

export const appAiAssignmentSchema = z.object({
  appId: uuid,
  providerConnectionId: uuid.nullable(),
  model: z.string().min(1).max(200),
  reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export type AccountIntegrationConnection = z.infer<
  typeof accountIntegrationConnectionSchema
>;
export type AiIntegrationOverview = z.infer<typeof aiIntegrationOverviewSchema>;
