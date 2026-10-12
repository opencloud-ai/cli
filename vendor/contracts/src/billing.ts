import { z } from "zod";

/** Stable API error code for every plan-governed limit. */
export const PLAN_LIMIT_REACHED = "plan_limit_reached";

export const billingProviderSchema = z.enum(["none", "stripe"]);
export type BillingProvider = z.infer<typeof billingProviderSchema>;

const quantity = z.string().regex(/^(0|[1-9][0-9]{0,39})$/);
const positiveQuantity = z.string().regex(/^[1-9][0-9]{0,39}$/);

/** Every limit a plan can set. Null numeric limits are unlimited. */
export const billingPlanLimitsSchema = z
  .object({
    apps: quantity.nullable(),
    /** Decimal bytes (1 GB = 1,000,000,000 bytes) of app files and Agent attachments. */
    storage: quantity.nullable(),
    /** Hosted-Agent runs at once. Zero leaves the hosted Agent out of the plan. */
    agent_concurrency: quantity.nullable(),
    custom_domains: quantity.nullable(),
    email_recipients_month: quantity.nullable(),
    automatic_repairs: z.boolean(),
    /** Scheduled backups kept per app. */
    backup_retention: positiveQuantity.max(4),
    priority_support: z.boolean(),
  })
  .strict();
export type BillingPlanLimits = z.infer<typeof billingPlanLimitsSchema>;

export const planLimitNameSchema = z.enum([
  "apps",
  "storage",
  "agent_concurrency",
  "custom_domains",
  "email_recipients_month",
  "automatic_repairs",
  "backup_retention",
]);
export type PlanLimitName = z.infer<typeof planLimitNameSchema>;

/** `details` of a `plan_limit_reached` error. Scalars only, so MCP keeps them. */
export const planLimitReachedDetailsSchema = z
  .object({
    limit: planLimitNameSchema,
    allowed: quantity.nullable(),
    used: quantity,
    requested: quantity,
    upgradeUrl: z.string().url().nullable(),
  })
  .strict();
export type PlanLimitReachedDetails = z.infer<typeof planLimitReachedDetailsSchema>;

export const billingIntervalSchema = z.enum(["month", "year"]);
export const billingCurrencySchema = z.string().regex(/^[a-z]{3}$/);
export const billingTaxBehaviorSchema = z.enum([
  "exclusive",
  "inclusive",
  "unspecified",
]);
export const billingPlanKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/);

export const billingPriceInputSchema = z
  .object({
    interval: billingIntervalSchema,
    currency: billingCurrencySchema,
    /** Amount in the currency's minor unit. Zero is only valid for free plans. */
    unitAmount: z.number().int().min(0).max(100_000_000),
    taxBehavior: billingTaxBehaviorSchema,
  })
  .strict();

export const billingPlanVersionInputSchema = z
  .object({
    limits: billingPlanLimitsSchema,
    features: z.array(z.string().trim().min(1).max(160)).max(20),
    trialDays: z.number().int().min(0).max(365),
    /** One price per interval and currency; local currencies make this list long. */
    prices: z.array(billingPriceInputSchema).max(40),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.prices.map((price) => `${price.interval}:${price.currency}`))
        .size === value.prices.length,
    "Each interval and currency can have one price",
  )
  .refine(
    (value) => value.prices.every((price) => price.unitAmount > 0),
    "Prices must be greater than zero; a free plan has no prices",
  );
export type BillingPlanVersionInput = z.infer<typeof billingPlanVersionInputSchema>;

export const billingPublicPriceSchema = z.object({
  interval: billingIntervalSchema,
  currency: billingCurrencySchema,
  unitAmount: z.number().int(),
  taxBehavior: billingTaxBehaviorSchema,
});
export const billingPublicPlanSchema = z.object({
  key: billingPlanKeySchema,
  name: z.string(),
  description: z.string(),
  default: z.boolean(),
  version: z.number().int(),
  limits: billingPlanLimitsSchema,
  features: z.array(z.string()),
  trialDays: z.number().int(),
  prices: z.array(billingPublicPriceSchema),
});
export type BillingPublicPlan = z.infer<typeof billingPublicPlanSchema>;

/** A plan includes the hosted Agent unless it allows no hosted-Agent runs at once. */
export function planIncludesHostedAgent(limits: Pick<BillingPlanLimits, "agent_concurrency">): boolean {
  return limits.agent_concurrency !== "0";
}

/** The plan to suggest for the hosted Agent: the first paid plan, in catalog order, that includes it. */
export function hostedAgentPlan(plans: readonly BillingPublicPlan[]): BillingPublicPlan | null {
  return plans.find((plan) => !plan.default && plan.prices.length > 0 && planIncludesHostedAgent(plan.limits)) ?? null;
}

/** True when the free plan leaves the hosted Agent out and a paid plan includes it. */
export function hostedAgentNeedsPaidPlan(plans: readonly BillingPublicPlan[]): boolean {
  const free = plans.find((plan) => plan.default);
  return !!free && !planIncludesHostedAgent(free.limits) && hostedAgentPlan(plans) !== null;
}

/** Whether a person's own plan includes the hosted Agent; read by the Agent service. */
export const hostedAgentAccessSchema = z.object({
  /** False only when the person's own plan leaves the hosted Agent out. */
  included: z.boolean(),
  /** The paid plan to suggest while it isn't included, if one includes it. */
  plan: z
    .object({ key: billingPlanKeySchema, name: z.string(), monthlyPrice: z.string().nullable() })
    .nullable(),
});
export type HostedAgentAccess = z.infer<typeof hostedAgentAccessSchema>;

export const billingSubscriptionStatusSchema = z.enum([
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
]);
export const billingEntitlementSourceSchema = z.enum([
  "free",
  "subscription",
  "complimentary",
]);

const isoTimestamp = z.string();
export const billingUsageSchema = z.object({
  apps: quantity,
  storage: quantity,
  agent_concurrency: quantity,
  custom_domains: quantity,
  email_recipients_month: quantity,
});
export type BillingUsage = z.infer<typeof billingUsageSchema>;

export const billingAccountViewSchema = z.object({
  planKey: billingPlanKeySchema,
  planName: z.string(),
  planVersion: z.number().int(),
  source: billingEntitlementSourceSchema,
  subscription: z
    .object({
      status: billingSubscriptionStatusSchema,
      interval: billingIntervalSchema.nullable(),
      currency: billingCurrencySchema.nullable(),
      unitAmount: z.number().int().nullable(),
      renewsAt: isoTimestamp.nullable(),
      cancelAtPeriodEnd: z.boolean(),
    })
    .nullable(),
  scheduledChange: z
    .object({
      planKey: billingPlanKeySchema,
      planName: z.string(),
      effectiveAt: isoTimestamp.nullable(),
    })
    .nullable(),
  complimentary: z
    .object({ planKey: billingPlanKeySchema, expiresAt: isoTimestamp.nullable() })
    .nullable(),
  grace: z
    .object({
      startedAt: isoTimestamp,
      endsAt: isoTimestamp,
      overLimits: z.array(planLimitNameSchema),
    })
    .nullable(),
  portalAvailable: z.boolean(),
});
export type BillingAccountView = z.infer<typeof billingAccountViewSchema>;

export const billingOverviewSchema = z.object({
  enabled: z.boolean(),
  provider: billingProviderSchema,
  /** Payments can start: the provider is configured for this installation. */
  checkoutAvailable: z.boolean(),
  unavailableReason: z.string().nullable(),
  account: billingAccountViewSchema.nullable(),
  limits: billingPlanLimitsSchema.nullable(),
  usage: billingUsageSchema.nullable(),
  plans: z.array(billingPublicPlanSchema),
  /** Currencies every paid plan has a price in, the default first. */
  currencies: z.array(billingCurrencySchema),
  /**
   * The currency to show and charge: a current subscription's own, otherwise
   * the visitor's local currency when offered, otherwise the default.
   */
  currency: billingCurrencySchema.nullable(),
});
export type BillingOverview = z.infer<typeof billingOverviewSchema>;

export const billingCheckoutRequestSchema = z
  .object({
    planKey: billingPlanKeySchema,
    interval: billingIntervalSchema,
    currency: billingCurrencySchema.optional(),
  })
  .strict();
export const billingRedirectSchema = z.object({ url: z.string().url() });
export const billingPlanChangeRequestSchema = billingCheckoutRequestSchema;
export const billingPlanChangeResultSchema = z.object({
  result: z.enum([
    "upgraded",
    "downgrade_scheduled",
    "cancellation_scheduled",
    "scheduled_change_withdrawn",
    "unchanged",
  ]),
  effectiveAt: isoTimestamp.nullable(),
});
export type BillingPlanChangeResult = z.infer<typeof billingPlanChangeResultSchema>;

/** Platform-admin view of one catalog plan and its current published version. */
const stripeIds = z.object({ live: z.string().nullable(), test: z.string().nullable() });
export const billingAdminPriceSchema = billingPublicPriceSchema.extend({
  id: z.uuid(),
  stripePriceId: stripeIds,
});
export const billingAdminPlanSchema = z.object({
  key: billingPlanKeySchema,
  name: z.string(),
  description: z.string(),
  sortOrder: z.number().int(),
  public: z.boolean(),
  defaultForNewAccounts: z.boolean(),
  status: z.enum(["active", "retired"]),
  revision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  stripeProductId: stripeIds,
  currentVersion: z
    .object({
      id: z.uuid(),
      version: z.number().int(),
      limits: billingPlanLimitsSchema,
      features: z.array(z.string()),
      trialDays: z.number().int(),
      createdAt: isoTimestamp,
      prices: z.array(billingAdminPriceSchema),
    })
    .nullable(),
  versions: z.array(
    z.object({
      id: z.uuid(),
      version: z.number().int(),
      status: z.enum(["enabled", "retired"]),
      createdAt: isoTimestamp,
      accounts: z.number().int(),
    }),
  ),
});
export type BillingAdminPlan = z.infer<typeof billingAdminPlanSchema>;

export const billingAdminCatalogSchema = z.object({
  provider: billingProviderSchema,
  stripe: z.object({
    configured: z.boolean(),
    webhookConfigured: z.boolean(),
    mode: z.enum(["live", "test"]).nullable(),
    apiVersion: z.string(),
    productTaxCode: z.string(),
  }),
  plans: z.array(billingAdminPlanSchema),
});

export const billingAdminPlanInputSchema = z
  .object({
    /** Null creates the plan; otherwise the current revision for optimistic concurrency. */
    revision: z.string().regex(/^[1-9][0-9]{0,18}$/).nullable(),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500),
    sortOrder: z.number().int().min(-1000).max(1000),
    public: z.boolean(),
    defaultForNewAccounts: z.boolean(),
    status: z.enum(["active", "retired"]),
  })
  .strict();

export const billingAdminAccountSchema = z.object({
  userId: z.uuid(),
  email: z.string().nullable(),
  organisationId: z.uuid().nullable(),
  planKey: billingPlanKeySchema.nullable(),
  planName: z.string().nullable(),
  source: billingEntitlementSourceSchema.nullable(),
  subscriptionStatus: billingSubscriptionStatusSchema.nullable(),
  renewsAt: isoTimestamp.nullable(),
  complimentary: z
    .object({
      planKey: billingPlanKeySchema,
      expiresAt: isoTimestamp.nullable(),
      reason: z.string(),
      grantedAt: isoTimestamp,
    })
    .nullable(),
  flaggedAt: isoTimestamp.nullable(),
  flagReason: z.string().nullable(),
  graceEndsAt: isoTimestamp.nullable(),
  prioritySupport: z.boolean(),
});
export type BillingAdminAccount = z.infer<typeof billingAdminAccountSchema>;
