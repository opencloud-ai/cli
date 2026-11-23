import { z } from "zod";
import { appIdSchema, isoTimestampSchema, userIdSchema } from "./identifiers.js";

/**
 * Money crosses service boundaries as canonical decimal strings. Internally it
 * is parsed as bigint; a JSON number would eventually lose nanodollar precision.
 */
export const aiNanodollarsSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,29})$/, "must be canonical non-negative nanodollars");

export const platformAiProviderSchema = z.enum(["openai", "anthropic"]);
export const platformAiSurfaceSchema = z.enum(["agent", "function"]);
export const platformAiCredentialKindSchema = z.enum([
  "openai_project_service_account",
  "openai_chatgpt_oauth",
  "anthropic_workspace_api_key",
  "anthropic_claude_oauth",
]);
export const platformAiCredentialAuthMethodSchema = z.enum([
  "api_key",
  "device_oauth",
  "manual_oauth",
]);
export const platformAiCredentialLifecycleSchema = z.enum([
  "enabled",
  "draining",
  "disabled",
  "revoked",
  "needs_attention",
]);
export const platformAiPoolLifecycleSchema = z.enum([
  "active",
  "disabled",
  "killed",
]);
export const platformAiCapacityStateSchema = z.enum([
  "ready",
  "below_threshold",
  "rate_limited",
  "exhausted",
  "checking",
  "unknown",
  "needs_attention",
]);
export const platformAiAllowanceScopeSchema = z.enum([
  "installation",
  "payer_user",
  "app",
  "pool",
  "pool_entry",
  "credential",
  "capacity_domain",
  "surface",
  "model",
]);
export const platformAiPeriodSchema = z.enum([
  "calendar_month_utc",
  "calendar_day_utc",
  "fixed",
  "reloadable",
]);

const safeLabelSchema = z.string().trim().min(1).max(200);
const exactModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const nonnegativeCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const platformAiTokenUsageSchema = z
  .object({
    uncachedInputTokens: nonnegativeCountSchema,
    cachedInputTokens: nonnegativeCountSchema,
    cacheWriteTokens: nonnegativeCountSchema,
    outputTokens: nonnegativeCountSchema,
  })
  .strict();

export const platformAiPriceRatesSchema = z
  .object({
    inputPerMillion: aiNanodollarsSchema,
    cachedInputPerMillion: aiNanodollarsSchema,
    cacheWritePerMillion: aiNanodollarsSchema,
    outputPerMillion: aiNanodollarsSchema,
  })
  .strict();

export const platformAiRatesSourceSchema = z.enum(["catalog", "custom"]);

export const platformAiModelPricingCatalogEntrySchema = z
  .object({
    provider: platformAiProviderSchema,
    model: exactModelSchema,
    displayName: safeLabelSchema,
    rates: platformAiPriceRatesSchema,
    sourceName: safeLabelSchema,
    sourceUrl: z.url(),
    cacheWriteBasis: z.string().trim().min(1).max(300),
  })
  .strict();

export const platformAiModelPricingCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    downloadedAt: isoTimestampSchema,
    entries: z.array(platformAiModelPricingCatalogEntrySchema).min(1).max(500),
  })
  .strict();

/**
 * Provider-published standard prices for the exact models OpenCloud exposes.
 * Creating a credential copies these rates into an immutable price card, so a
 * later catalog refresh never rewrites settled or in-flight usage. Newer
 * OpenAI and Anthropic models are added without a release through the control
 * plane's `ai-models` feature flag; the platform's own AI accounts (trial
 * credit) serve only the models listed here.
 */
export const platformAiModelPricingCatalog =
  platformAiModelPricingCatalogSchema.parse({
    schemaVersion: 1,
    downloadedAt: "2026-11-03T00:00:00.000Z",
    entries: [
      {
        provider: "openai",
        model: "gpt-6-astra",
        displayName: "GPT-6 Astra",
        rates: {
          inputPerMillion: "10000000000",
          cachedInputPerMillion: "1000000000",
          cacheWritePerMillion: "12500000000",
          outputPerMillion: "50000000000",
        },
        sourceName: "OpenAI model pricing",
        sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6-astra",
        cacheWriteBasis: "Provider-published 1.25x cache-write multiplier.",
      },
      {
        provider: "openai",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        rates: {
          inputPerMillion: "4000000000",
          cachedInputPerMillion: "400000000",
          cacheWritePerMillion: "5000000000",
          outputPerMillion: "20000000000",
        },
        sourceName: "OpenAI model pricing",
        sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
        cacheWriteBasis: "Provider-published 1.25x cache-write multiplier.",
      },
      {
        provider: "openai",
        model: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        rates: {
          inputPerMillion: "2000000000",
          cachedInputPerMillion: "200000000",
          cacheWritePerMillion: "2500000000",
          outputPerMillion: "12000000000",
        },
        sourceName: "OpenAI model pricing",
        sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
        cacheWriteBasis: "Provider-published 1.25x cache-write multiplier.",
      },
      {
        provider: "openai",
        model: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        rates: {
          inputPerMillion: "200000000",
          cachedInputPerMillion: "20000000",
          cacheWritePerMillion: "250000000",
          outputPerMillion: "1200000000",
        },
        sourceName: "OpenAI model pricing",
        sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
        cacheWriteBasis: "Provider-published 1.25x cache-write multiplier.",
      },
      {
        provider: "anthropic",
        model: "claude-fable-5",
        displayName: "Claude Fable 5",
        rates: {
          inputPerMillion: "10000000000",
          cachedInputPerMillion: "1000000000",
          cacheWritePerMillion: "12500000000",
          outputPerMillion: "50000000000",
        },
        sourceName: "Anthropic model pricing",
        sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
        cacheWriteBasis: "Five-minute cache-write price; one-hour writes have a separate higher rate.",
      },
      {
        provider: "anthropic",
        model: "claude-opus-5",
        displayName: "Claude Opus 5",
        rates: {
          inputPerMillion: "5000000000",
          cachedInputPerMillion: "500000000",
          cacheWritePerMillion: "6250000000",
          outputPerMillion: "25000000000",
        },
        sourceName: "Anthropic model pricing",
        sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
        cacheWriteBasis: "Five-minute cache-write price; one-hour writes have a separate higher rate.",
      },
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        displayName: "Claude Sonnet 5",
        rates: {
          inputPerMillion: "2000000000",
          cachedInputPerMillion: "200000000",
          cacheWritePerMillion: "2500000000",
          outputPerMillion: "10000000000",
        },
        sourceName: "Anthropic model pricing",
        sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
        cacheWriteBasis: "Five-minute cache-write price; one-hour writes have a separate higher rate.",
      },
      {
        provider: "anthropic",
        model: "claude-fable-5-1",
        displayName: "Claude Fable 5.1",
        rates: {
          inputPerMillion: "10000000000",
          cachedInputPerMillion: "250000000",
          cacheWritePerMillion: "12500000000",
          outputPerMillion: "50000000000",
        },
        sourceName: "Anthropic model pricing",
        sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
        cacheWriteBasis: "Five-minute cache-write price; one-hour writes have a separate higher rate.",
      },
      {
        provider: "anthropic",
        model: "claude-opus-5-5",
        displayName: "Claude Opus 5.5",
        rates: {
          inputPerMillion: "4000000000",
          cachedInputPerMillion: "200000000",
          cacheWritePerMillion: "5000000000",
          outputPerMillion: "20000000000",
        },
        sourceName: "Anthropic model pricing",
        sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
        cacheWriteBasis: "Five-minute cache-write price; one-hour writes have a separate higher rate.",
      },
      {
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        displayName: "Claude Sonnet 5.5",
        rates: {
          inputPerMillion: "2000000000",
          cachedInputPerMillion: "100000000",
          cacheWritePerMillion: "2500000000",
          outputPerMillion: "10000000000",
        },
        sourceName: "Anthropic model pricing",
        sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
        cacheWriteBasis: "Five-minute cache-write price; one-hour writes have a separate higher rate.",
      },
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        displayName: "Claude Haiku 4.5",
        rates: {
          inputPerMillion: "1000000000",
          cachedInputPerMillion: "100000000",
          cacheWritePerMillion: "1250000000",
          outputPerMillion: "5000000000",
        },
        sourceName: "Anthropic model pricing",
        sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
        cacheWriteBasis: "Five-minute cache-write price; one-hour writes have a separate higher rate.",
      },
    ],
  });

const positiveNanodollarsSchema = aiNanodollarsSchema.refine(
  (value) => BigInt(value) > 0n,
  "must be greater than zero",
);

/**
 * The administrator-facing AI Capacity contract. It deliberately combines the
 * vault, price-card, allowance, and route primitives into one write-only
 * credential operation so the public console does not expose those internals.
 */
export const platformAiCapacityCredentialCreateSchema = z
  .object({
    provider: platformAiProviderSchema,
    authMethod: z.literal("api_key").default("api_key"),
    label: safeLabelSchema,
    secret: z.string().min(8).max(100_000),
    model: exactModelSchema,
    rates: platformAiPriceRatesSchema,
    ratesSource: platformAiRatesSourceSchema.default("custom"),
    monthlyLimitNanodollars: positiveNanodollarsSchema.nullable().default(null),
    switchBelowNanodollars: aiNanodollarsSchema.default("0"),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.monthlyLimitNanodollars === null &&
      BigInt(value.switchBelowNanodollars) > 0n
    ) {
      context.addIssue({
        code: "custom",
        path: ["switchBelowNanodollars"],
        message: "a reserve requires a monthly credential capacity",
      });
    }
    if (
      value.monthlyLimitNanodollars !== null &&
      BigInt(value.switchBelowNanodollars) >=
        BigInt(value.monthlyLimitNanodollars)
    ) {
      context.addIssue({
        code: "custom",
        path: ["switchBelowNanodollars"],
        message: "switch threshold must be below the monthly capacity",
      });
    }
    if (value.ratesSource === "catalog") {
      const catalogEntry = platformAiModelPricingCatalog.entries.find(
        (entry) =>
          entry.provider === value.provider && entry.model === value.model,
      );
      if (!catalogEntry) {
        context.addIssue({
          code: "custom",
          path: ["model"],
          message: "model is not present in the downloaded pricing catalog",
        });
      } else {
        for (const key of [
          "inputPerMillion",
          "cachedInputPerMillion",
          "cacheWritePerMillion",
          "outputPerMillion",
        ] as const) {
          if (value.rates[key] !== catalogEntry.rates[key]) {
            context.addIssue({
              code: "custom",
              path: ["rates", key],
              message: "catalog pricing must match the downloaded model rate",
            });
          }
        }
      }
    }
  });

const platformAiCapacityCredentialConfigurationShape = {
  provider: platformAiProviderSchema,
  label: safeLabelSchema,
  model: exactModelSchema,
  rates: platformAiPriceRatesSchema,
  ratesSource: platformAiRatesSourceSchema.default("custom"),
  monthlyLimitNanodollars: positiveNanodollarsSchema.nullable().default(null),
  switchBelowNanodollars: aiNanodollarsSchema.default("0"),
  switchBelowPercent: z.number().min(0).max(99).default(10),
};

/**
 * Starts a native provider-account authorization owned by AI Capacity. The
 * returned OAuth state is encrypted as a platform credential and is never
 * attached to the administrator's personal provider connections.
 */
export const platformAiCapacityCredentialAuthorizationCreateSchema = z
  .object({
    ...platformAiCapacityCredentialConfigurationShape,
    authMethod: z.enum(["device_oauth", "manual_oauth"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.provider === "openai" && value.authMethod !== "device_oauth") ||
      (value.provider === "anthropic" && value.authMethod !== "manual_oauth")
    ) {
      context.addIssue({
        code: "custom",
        path: ["authMethod"],
        message:
          value.provider === "openai"
            ? "OpenAI account credentials use Codex device login"
            : "Anthropic account credentials use Claude pasted-code login",
      });
    }
    if (value.monthlyLimitNanodollars === null && BigInt(value.switchBelowNanodollars) > 0n) {
      context.addIssue({
        code: "custom",
        path: ["switchBelowNanodollars"],
        message: "a dollar reserve requires a monthly credential capacity",
      });
    }
    if (
      value.monthlyLimitNanodollars !== null &&
      BigInt(value.switchBelowNanodollars) >= BigInt(value.monthlyLimitNanodollars)
    ) {
      context.addIssue({
        code: "custom",
        path: ["switchBelowNanodollars"],
        message: "dollar reserve must be below the monthly capacity",
      });
    }
    if (value.ratesSource === "catalog") {
      const catalogEntry = platformAiModelPricingCatalog.entries.find(
        (entry) => entry.provider === value.provider && entry.model === value.model,
      );
      if (!catalogEntry) {
        context.addIssue({
          code: "custom",
          path: ["model"],
          message: "model is not present in the downloaded pricing catalog",
        });
      } else {
        for (const key of [
          "inputPerMillion",
          "cachedInputPerMillion",
          "cacheWritePerMillion",
          "outputPerMillion",
        ] as const) {
          if (value.rates[key] !== catalogEntry.rates[key]) {
            context.addIssue({
              code: "custom",
              path: ["rates", key],
              message: "catalog pricing must match the downloaded model rate",
            });
          }
        }
      }
    }
  });

export const platformAiCredentialAuthorizationStatusSchema = z.enum([
  "pending",
  "completed",
  "failed",
  "expired",
  "cancelled",
]);

const platformAiCredentialAuthorizationBase = {
  schemaVersion: z.literal(1),
  attemptId: z.uuid(),
  credentialId: z.uuid(),
  provider: platformAiProviderSchema,
  label: safeLabelSchema,
  status: platformAiCredentialAuthorizationStatusSchema,
  expiresAt: isoTimestampSchema,
  errorClass: z.string().trim().min(1).max(200).nullable(),
  credential: z.lazy(() => platformAiCredentialViewSchema).nullable(),
};

export const platformAiCredentialAuthorizationViewSchema = z.discriminatedUnion(
  "authMethod",
  [
    z
      .object({
        ...platformAiCredentialAuthorizationBase,
        authMethod: z.literal("device_oauth"),
        authorizationUrl: z.url(),
        userCode: z.string().trim().min(2).max(100),
        instructions: z.string().trim().min(1).max(1_000),
      })
      .strict(),
    z
      .object({
        ...platformAiCredentialAuthorizationBase,
        authMethod: z.literal("manual_oauth"),
        authorizationUrl: z.url(),
        instructions: z.string().trim().min(1).max(1_000),
      })
      .strict(),
  ],
);

export const platformAiSubscriptionRateLimitWindowSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    usedPercent: z.number().min(0).max(100),
    remainingPercent: z.number().min(0).max(100),
    windowDurationMinutes: z.number().positive().nullable(),
    resetsAt: isoTimestampSchema.nullable(),
  })
  .strict();

export const platformAiSubscriptionCapacitySchema = z
  .object({
    schemaVersion: z.literal(1),
    planType: z.string().trim().min(1).max(100).nullable(),
    windows: z.array(platformAiSubscriptionRateLimitWindowSchema).max(50),
    remainingPercent: z.number().min(0).max(100).nullable(),
    resetsAt: isoTimestampSchema.nullable(),
    observedAt: isoTimestampSchema,
  })
  .strict();

export const platformAiCapacityCredentialOrderSchema = z
  .object({ credentialIds: z.array(z.uuid()).max(500) })
  .strict()
  .refine(
    (value) => new Set(value.credentialIds).size === value.credentialIds.length,
    { path: ["credentialIds"], message: "credential order contains duplicates" },
  );

export const platformAiMonthlyBudgetSchema = z
  .object({ weeklyBudgetNanodollars: positiveNanodollarsSchema.nullable() })
  .strict();

export const platformAiAppBudgetSchema = z
  .object({ weeklyBudgetNanodollars: positiveNanodollarsSchema })
  .strict();

export const platformAiPromotionCadenceSchema = z.enum([
  "one_off",
  "weekly",
  "monthly",
]);

export const platformAiPromotionDistributionSchema = z.enum(["email", "link"]);

export const platformAiPromotionTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "must be a private promotion token");

const platformAiPromotionEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(320));

export const platformAiPromotionCreateSchema = z
  .object({
    schemaVersion: z.literal(1),
    label: safeLabelSchema,
    distribution: platformAiPromotionDistributionSchema.default("email"),
    targetEmail: platformAiPromotionEmailSchema.nullable(),
    claimLimit: z.number().int().min(1).max(100_000).default(1),
    amountNanodollars: positiveNanodollarsSchema,
    cadence: platformAiPromotionCadenceSchema,
    claimExpiresAt: isoTimestampSchema,
    grantEndsAt: isoTimestampSchema,
  })
  .strict()
  .refine(
    (value) =>
      new Date(value.grantEndsAt).getTime() >
      new Date(value.claimExpiresAt).getTime(),
    {
      path: ["grantEndsAt"],
      message: "grant end must be after the claim deadline",
    },
  )
  .superRefine((value, context) => {
    if (value.distribution === "email") {
      if (value.targetEmail === null) {
        context.addIssue({
          code: "custom",
          path: ["targetEmail"],
          message: "an email promotion requires a target email",
        });
      }
      if (value.claimLimit !== 1) {
        context.addIssue({
          code: "custom",
          path: ["claimLimit"],
          message: "an email promotion can be claimed only once",
        });
      }
      return;
    }
    if (value.targetEmail !== null) {
      context.addIssue({
        code: "custom",
        path: ["targetEmail"],
        message: "a shareable-link promotion cannot target an email",
      });
    }
  });

export const platformAiPromotionClaimSchema = z
  .object({
    token: platformAiPromotionTokenSchema,
    userId: userIdSchema,
    email: platformAiPromotionEmailSchema,
  })
  .strict();

export const platformAiPromotionEmailDeliverySchema = z
  .object({
    status: z.enum(["sent", "failed"]),
    providerMessageId: z.string().trim().min(1).max(200).nullable().default(null),
  })
  .strict()
  .refine(
    (value) => value.status !== "sent" || value.providerMessageId !== null,
    {
      path: ["providerMessageId"],
      message: "a sent promotion email requires a provider message id",
    },
  );

export const platformAiPriceCardCreateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .default("default"),
    provider: platformAiProviderSchema,
    model: exactModelSchema,
    rates: platformAiPriceRatesSchema,
    fixedComponents: z.record(z.string().trim().min(1).max(100), aiNanodollarsSchema).default({}),
    effectiveAt: isoTimestampSchema,
  })
  .strict();

export const platformAiPriceCardViewSchema = platformAiPriceCardCreateSchema.extend({
  id: z.uuid(),
  version: z.number().int().positive(),
  retiredAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
});

const platformAiCredentialMetadataSchema = z
  .object({
    provider: platformAiProviderSchema,
    kind: platformAiCredentialKindSchema,
    authMethod: platformAiCredentialAuthMethodSchema.default("api_key"),
    environment: z.string().trim().min(1).max(100),
    label: safeLabelSchema,
    capacityDomainId: z.uuid(),
    allowedSurfaces: z.array(platformAiSurfaceSchema).min(1).max(2),
    exactModels: z.array(exactModelSchema).min(1).max(100),
    providerMetadata: z.record(z.string(), z.unknown()).default({}),
    replacesCredentialId: z.uuid().nullable().default(null),
  })
  .strict();

export const platformAiCredentialCreateSchema = platformAiCredentialMetadataSchema
  .extend({ secret: z.string().min(8).max(100_000) })
  .superRefine((value, context) => {
    if (
      (value.provider === "openai" && value.kind !== "openai_project_service_account") ||
      (value.provider === "anthropic" && value.kind !== "anthropic_workspace_api_key")
    ) {
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "credential kind does not match provider",
      });
    }
  });

export const platformAiCredentialViewSchema = platformAiCredentialMetadataSchema.extend({
    id: z.uuid(),
    credentialVersion: z.number().int().positive(),
    lifecycle: platformAiCredentialLifecycleSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    stateVersion: z.number().int().positive().default(1),
    expiresAt: isoTimestampSchema.nullable().default(null),
    accountHint: z.string().trim().min(1).max(320).nullable().default(null),
    lastVerifiedAt: isoTimestampSchema.nullable(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  });

export const platformAiCapacityDomainCreateSchema = z
  .object({
    provider: platformAiProviderSchema,
    environment: z.string().trim().min(1).max(100),
    label: safeLabelSchema,
    providerOrganization: z.string().trim().min(1).max(200).nullable().default(null),
    providerProject: z.string().trim().min(1).max(200).nullable().default(null),
    providerWorkspace: z.string().trim().min(1).max(200).nullable().default(null),
    parentDomainId: z.uuid().nullable().default(null),
  })
  .strict();

export const platformAiPoolCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/),
    environment: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
  })
  .strict();

export const platformAiCredentialLifecycleUpdateSchema = z
  .object({
    lifecycle: platformAiCredentialLifecycleSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const platformAiPoolLifecycleUpdateSchema = z
  .object({
    lifecycle: platformAiPoolLifecycleSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const platformAiPoolEntryLifecycleUpdateSchema = z
  .object({
    enabled: z.boolean(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const platformAiEntryLimitsSchema = z
  .object({
    hardLimitNanodollars: aiNanodollarsSchema.nullable().default(null),
    reloadableBalanceNanodollars: aiNanodollarsSchema.nullable().default(null),
    requestsPerMinute: z.number().int().positive().nullable().default(null),
    inputTokensPerMinute: z.number().int().positive().nullable().default(null),
    outputTokensPerMinute: z.number().int().positive().nullable().default(null),
    concurrency: z.number().int().positive().nullable().default(null),
  })
  .strict();

export const platformAiPoolEntryCreateSchema = z
  .object({
    credentialId: z.uuid(),
    priceCardId: z.uuid(),
    priority: z.number().int().min(1).max(1_000_000),
    allowedSurfaces: z.array(platformAiSurfaceSchema).min(1).max(2),
    exactModels: z.array(exactModelSchema).min(1).max(100),
    switchBelowNanodollars: aiNanodollarsSchema,
    recoverAboveNanodollars: aiNanodollarsSchema,
    limits: platformAiEntryLimitsSchema,
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine(
    (value) =>
      BigInt(value.recoverAboveNanodollars) >
      BigInt(value.switchBelowNanodollars),
    {
      path: ["recoverAboveNanodollars"],
      message: "recovery threshold must exceed switch threshold",
    },
  );

export const platformAiAllowanceUpsertSchema = z
  .object({
    scope: platformAiAllowanceScopeSchema,
    scopeId: z.string().trim().min(1).max(200),
    period: platformAiPeriodSchema,
    limitNanodollars: aiNanodollarsSchema,
    periodStart: isoTimestampSchema,
    resetAt: isoTimestampSchema.nullable(),
  })
  .strict();

export const platformAiAdmissionRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    reservationId: z.uuid(),
    idempotencyKey: z.string().trim().min(1).max(200),
    poolName: z.string().trim().min(1).max(120),
    actorUserId: userIdSchema.nullable(),
    payerUserId: userIdSchema,
    appId: appIdSchema,
    surface: platformAiSurfaceSchema,
    model: exactModelSchema,
    maximumUsage: platformAiTokenUsageSchema,
    fixedComponents: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    credentialAccessMode: z.enum(["embedded", "brokered"]).optional(),
    runId: z.uuid().nullable().default(null),
    callId: z.uuid().nullable().default(null),
    expiresAt: isoTimestampSchema,
  })
  .strict()
  .refine((value) => value.runId !== null || value.callId !== null, {
    message: "an Agent run or Function call identity is required",
  })
  .refine(
    (value) =>
      value.surface !== "agent" ||
      (value.runId !== null && value.actorUserId !== null),
    {
      message: "an Agent reservation requires its run and actor identities",
    },
  )
  .refine(
    (value) =>
      value.credentialAccessMode !== "brokered" || value.surface === "agent",
    {
      path: ["credentialAccessMode"],
      message: "brokered credential access is only available to Agent runs",
    },
  );

export const platformAiAdmissionResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    reservationId: z.uuid(),
    provider: platformAiProviderSchema,
    model: exactModelSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict();

export const platformAiSettlementSchema = z
  .object({
    schemaVersion: z.literal(1),
    reservationId: z.uuid(),
    outcome: z.enum(["completed", "failed", "cancelled", "timed_out", "unknown"]),
    usage: platformAiTokenUsageSchema,
    fixedComponents: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    providerRequestId: z.string().trim().min(1).max(500).nullable().default(null),
    providerReportedCostNanodollars: aiNanodollarsSchema.nullable().default(null),
    definitelyUnsent: z.boolean().default(false),
    settledAt: isoTimestampSchema,
  })
  .strict();

export type AiNanodollars = z.infer<typeof aiNanodollarsSchema>;
export type PlatformAiProvider = z.infer<typeof platformAiProviderSchema>;
export type PlatformAiSurface = z.infer<typeof platformAiSurfaceSchema>;
export type PlatformAiTokenUsage = z.infer<typeof platformAiTokenUsageSchema>;
export type PlatformAiPriceRates = z.infer<typeof platformAiPriceRatesSchema>;
export type PlatformAiRatesSource = z.infer<typeof platformAiRatesSourceSchema>;
export type PlatformAiCredentialAuthMethod = z.infer<
  typeof platformAiCredentialAuthMethodSchema
>;
export type PlatformAiModelPricingCatalogEntry = z.infer<
  typeof platformAiModelPricingCatalogEntrySchema
>;
export type PlatformAiModelPricingCatalog = z.infer<
  typeof platformAiModelPricingCatalogSchema
>;
export type PlatformAiCapacityCredentialCreate = z.infer<typeof platformAiCapacityCredentialCreateSchema>;
export type PlatformAiCapacityCredentialAuthorizationCreate = z.infer<
  typeof platformAiCapacityCredentialAuthorizationCreateSchema
>;
export type PlatformAiCredentialAuthorizationView = z.infer<
  typeof platformAiCredentialAuthorizationViewSchema
>;
export type PlatformAiSubscriptionCapacity = z.infer<
  typeof platformAiSubscriptionCapacitySchema
>;
export type PlatformAiCapacityCredentialOrder = z.infer<typeof platformAiCapacityCredentialOrderSchema>;
export type PlatformAiMonthlyBudget = z.infer<typeof platformAiMonthlyBudgetSchema>;
export type PlatformAiAppBudget = z.infer<typeof platformAiAppBudgetSchema>;
export type PlatformAiPromotionCadence = z.infer<
  typeof platformAiPromotionCadenceSchema
>;
export type PlatformAiPromotionDistribution = z.infer<
  typeof platformAiPromotionDistributionSchema
>;
export type PlatformAiPromotionCreate = z.infer<
  typeof platformAiPromotionCreateSchema
>;
export type PlatformAiPromotionClaim = z.infer<
  typeof platformAiPromotionClaimSchema
>;
export type PlatformAiPromotionEmailDelivery = z.infer<
  typeof platformAiPromotionEmailDeliverySchema
>;
export type PlatformAiPriceCardCreate = z.infer<typeof platformAiPriceCardCreateSchema>;
export type PlatformAiCredentialCreate = z.infer<typeof platformAiCredentialCreateSchema>;
export type PlatformAiCredentialView = z.infer<typeof platformAiCredentialViewSchema>;
export type PlatformAiCredentialLifecycleUpdate = z.infer<typeof platformAiCredentialLifecycleUpdateSchema>;
export type PlatformAiPoolCreate = z.infer<typeof platformAiPoolCreateSchema>;
export type PlatformAiPoolLifecycleUpdate = z.infer<typeof platformAiPoolLifecycleUpdateSchema>;
export type PlatformAiPoolEntryLifecycleUpdate = z.infer<typeof platformAiPoolEntryLifecycleUpdateSchema>;
export type PlatformAiPoolEntryCreate = z.infer<typeof platformAiPoolEntryCreateSchema>;
export type PlatformAiAllowanceUpsert = z.infer<typeof platformAiAllowanceUpsertSchema>;
export type PlatformAiAdmissionRequest = z.infer<typeof platformAiAdmissionRequestSchema>;
export type PlatformAiAdmissionResponse = z.infer<typeof platformAiAdmissionResponseSchema>;
export type PlatformAiSettlement = z.infer<typeof platformAiSettlementSchema>;
