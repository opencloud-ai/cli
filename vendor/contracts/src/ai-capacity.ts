import { z } from "zod";
import { aiAuthMethodSchema, aiProviderSchema } from "./dashboard-integrations.js";

/**
 * One AI setup per app (docs/product/ai-capacity/REVIEW-AND-PROPOSAL.md).
 *
 * Every kind of work in an app reads the same ordered list:
 *   1. each person's own account, when they allowed this app;
 *   2. accounts shared with the app (app accounts and accounts people shared);
 *   3. the organisation's accounts, in the order its admins set;
 *   4. {productName} AI, while trial or promotional credit is left.
 * A kind of work uses the first entry that can do it. Amounts are exact USD
 * nanodollars; `null` limits are unlimited.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const nanodollars = z.string().regex(/^(0|[1-9][0-9]{0,39})$/);
const count = z.string().regex(/^(0|[1-9][0-9]{0,39})$/);
const limit = nanodollars.nullable();

export const aiWorkKindSchema = z.enum(["building", "automatic", "features"]);
/** `accounts`: people's own, shared and app accounts. `included`: {productName} AI. */
export const aiUsageSourceSchema = z.enum(["accounts", "organisation", "included"]);
export const appAiEntrySchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const appAiSkipReasonSchema = z.enum([
  "off",
  "no_person",
  "not_allowed",
  "not_connected",
  "rate_limited",
  "budget_reached",
  "wrong_provider",
  "api_key_required",
  "scope",
  "trial_ended",
  "credit_used",
  "not_offered",
]);
export const aiReasoningEffortSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);

export const aiAccountSummarySchema = z.object({
  id: uuid,
  provider: aiProviderSchema,
  authMethod: aiAuthMethodSchema,
  label: z.string().trim().min(1).max(200),
  accountHint: z.string().trim().min(1).max(320).nullable(),
  status: z.enum(["pending", "connected", "expired", "error", "revoked"]),
}).strict();

export const appAiSharedEntrySchema = z.object({
  connectionId: uuid,
  kind: z.enum(["app_account", "shared_account"]),
  account: aiAccountSummarySchema,
  /** Null for app accounts, which the app owns. */
  sharedBy: z.object({ userId: uuid, name: z.string().trim().min(1).max(200) }).strict().nullable(),
  /** Migrated permissions keep their original scope until the sharer widens it. */
  scope: z.enum(["all", "agent", "features"]),
  viewerIsSharer: z.boolean(),
}).strict();

export const appAiNextSourceSchema = z.object({
  kind: aiWorkKindSchema,
  /** Null when no entry can do this kind of work right now. */
  entry: appAiEntrySchema.nullable(),
  label: z.string().trim().min(1).max(200).nullable(),
  connectionId: uuid.nullable(),
  skipped: z.array(z.object({ entry: appAiEntrySchema, reason: appAiSkipReasonSchema }).strict()).max(20),
}).strict();

export const aiBudgetLineSchema = z.object({ limit, used: nanodollars, available: limit }).strict();

export const aiTrialEndReasonSchema = z.enum([
  "organisation_account",
  "member_account",
  "personal_account",
  "administrator",
]);

/** {productName} AI: a small trial plus promotional credit that outlives it. */
export const aiIncludedStateSchema = z.object({
  /** The installation funds {productName} AI at all. */
  offered: z.boolean(),
  trial: z.object({
    state: z.enum(["active", "ended", "none"]),
    totalNanodollars: nanodollars.nullable(),
    remainingNanodollars: nanodollars.nullable(),
    endedAt: timestamp.nullable(),
    endReason: aiTrialEndReasonSchema.nullable(),
  }).strict(),
  credit: z.object({
    remainingNanodollars: nanodollars,
    nextExpiresAt: timestamp.nullable(),
  }).strict().nullable(),
}).strict();

export const appAiSetupSchema = z.object({
  schemaVersion: z.literal(1),
  appId: uuid,
  appName: z.string().trim().min(1).max(160),
  /** Optimistic-concurrency guard for updates. */
  version: z.number().int().positive(),
  /** App Admin (Edit) authority: owners, app admins and organisation admins. */
  canEdit: z.boolean(),
  /** App features accept only provider API keys on this installation. */
  appAiApiKeysOnly: z.boolean(),
  ownAccountsFirst: z.boolean(),
  ownUse: z.object({
    viewerAllowed: z.boolean(),
    /** The viewer's default account that their own work would use. */
    viewerAccount: aiAccountSummarySchema.nullable(),
    allowedPeople: z.number().int().nonnegative(),
  }).strict(),
  shared: z.array(appAiSharedEntrySchema).max(20),
  /** Null on personal installations and for apps outside an organisation. */
  organisation: z.object({
    id: uuid,
    name: z.string().trim().min(1).max(200),
    accounts: z.array(aiAccountSummarySchema).max(50),
  }).strict().nullable(),
  included: aiIncludedStateSchema,
  appFeatures: z.object({
    released: z.boolean(),
    model: z.string().trim().min(1).max(200),
    reasoningEffort: aiReasoningEffortSchema,
    models: z.array(z.object({
      id: z.string().trim().min(1).max(200),
      label: z.string().trim().min(1).max(200),
      provider: aiProviderSchema,
    }).strict()).max(100),
    reasoningEfforts: z.array(z.object({ id: aiReasoningEffortSchema, label: z.string().trim().min(1).max(100) }).strict()).max(10),
  }).strict(),
  /** Server-computed: building (for the viewer), automatic work, app features. */
  next: z.array(appAiNextSourceSchema).length(3),
  left: z.object({
    period: z.object({ endsAt: timestamp, timeZone: z.string().min(1).max(100) }).strict(),
    yourBudget: aiBudgetLineSchema.nullable(),
    yourLimit: aiBudgetLineSchema.nullable(),
    organisationBudget: aiBudgetLineSchema.nullable(),
  }).strict(),
  /** The viewer's own accounts, offered for "Share one of my accounts". */
  viewerAccounts: z.array(aiAccountSummarySchema).max(100),
}).strict();

export const updateAppAiSetupRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  ownAccountsFirst: z.boolean(),
  /** Every current shared connection ID, in the new order. Removal uses its own endpoint. */
  sharedOrder: z.array(uuid).max(20),
  appFeatures: z.object({
    model: z.string().trim().min(1).max(200),
    reasoningEffort: aiReasoningEffortSchema,
  }).strict(),
}).strict();

export const shareAppAiAccountRequestSchema = z.object({
  connectionId: uuid,
  /** Idempotency of the sharing permission. */
  intentId: uuid,
}).strict();

export const reorderOrganisationAiAccountsRequestSchema = z.object({
  connectionIds: z.array(uuid).min(1).max(50),
}).strict();

export const aiUsageRowSchema = z.object({
  kind: aiWorkKindSchema,
  source: aiUsageSourceSchema,
  /** Rated for {productName} AI; estimated at catalogue prices for accounts. */
  costNanodollars: nanodollars,
  tokens: count,
  operations: z.number().int().nonnegative(),
}).strict();

export const aiUsageWeekSchema = z.object({
  startsAt: timestamp,
  endsAt: timestamp,
  rows: z.array(aiUsageRowSchema).max(9),
}).strict();

export const appAiUsageSchema = z.object({
  schemaVersion: z.literal(1),
  appId: uuid,
  timeZone: z.string().min(1).max(100),
  /** Oldest first; the last week is the current one. */
  weeks: z.array(aiUsageWeekSchema).min(1).max(26),
}).strict();

export const appAiUsageQuerySchema = z.object({
  weeks: z.coerce.number().int().min(1).max(26).optional(),
}).strict();

export const organisationAiUsageSchema = z.object({
  schemaVersion: z.literal(1),
  organisationId: uuid,
  period: z.object({ startsAt: timestamp, endsAt: timestamp, timeZone: z.string().min(1).max(100) }).strict(),
  apps: z.array(z.object({
    appId: uuid,
    name: z.string().min(1).max(160).nullable(),
    costNanodollars: nanodollars,
    tokens: count,
    operations: z.number().int().nonnegative(),
    bySource: z.object({ accounts: nanodollars, organisation: nanodollars, included: nanodollars }).strict(),
  }).strict()).max(500),
  /** Work in private chats that haven't become apps, aggregated without identities. */
  privateChats: z.object({ costNanodollars: nanodollars, operations: z.number().int().nonnegative() }).strict(),
}).strict();

export const personalAiBudgetSchema = z.object({
  schemaVersion: z.literal(1),
  period: z.object({ startsAt: timestamp, endsAt: timestamp, timeZone: z.literal("UTC") }).strict(),
  budget: aiBudgetLineSchema,
}).strict();

export const setPersonalAiBudgetRequestSchema = z.object({ weeklySpend: limit }).strict();

/** Shown on each finished Agent run: what paid for it. */
export const aiRunFundingSchema = z.object({
  source: z.enum(["own", "shared", "app", "organisation", "included"]),
  label: z.string().trim().min(1).max(200),
  costNanodollars: nanodollars.nullable(),
  tokens: count.nullable(),
}).strict();

export type AiWorkKind = z.infer<typeof aiWorkKindSchema>;
export type AiUsageSource = z.infer<typeof aiUsageSourceSchema>;
export type AppAiSkipReason = z.infer<typeof appAiSkipReasonSchema>;
export type AiAccountSummary = z.infer<typeof aiAccountSummarySchema>;
export type AppAiSharedEntry = z.infer<typeof appAiSharedEntrySchema>;
export type AppAiNextSource = z.infer<typeof appAiNextSourceSchema>;
export type AiBudgetLine = z.infer<typeof aiBudgetLineSchema>;
export type AiIncludedState = z.infer<typeof aiIncludedStateSchema>;
export type AppAiSetup = z.infer<typeof appAiSetupSchema>;
export type UpdateAppAiSetupRequest = z.infer<typeof updateAppAiSetupRequestSchema>;
export type AppAiUsage = z.infer<typeof appAiUsageSchema>;
export type OrganisationAiUsage = z.infer<typeof organisationAiUsageSchema>;
export type PersonalAiBudget = z.infer<typeof personalAiBudgetSchema>;
export type AiRunFunding = z.infer<typeof aiRunFundingSchema>;
