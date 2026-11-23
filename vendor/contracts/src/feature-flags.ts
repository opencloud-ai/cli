import { z } from "zod";
import { platformAiModelPricingCatalog } from "@opencloud/agent-protocol";

/**
 * Platform feature flags, owned by the control plane's Feature Flags module.
 * Code defines every flag and its default. Platform administrators can set a
 * flag for everyone, for one company organisation (organisation installations
 * only) or for one person. The most specific setting wins: person, then
 * organisation, then everyone, then the default.
 *
 * On/off flags are `platformFeatureFlags`; flags whose value is a JSON
 * document are `platformJsonFeatureFlags`.
 */
export const platformFeatureFlags = {
  "container-compute": {
    label: "Container compute",
    description: "Allow configured accounts to use container jobs, HTTP services and workers. Payer consent, funded capacity and runtime readiness are still required.",
    defaultEnabled: false,
  },
  "chatgpt-sign-in": {
    label: "ChatGPT sign-in",
    description:
      "Offer Sign in with ChatGPT (a ChatGPT plan, through Codex) when someone connects an AI provider. OpenAI API keys and existing sign-ins are unaffected.",
    defaultEnabled: true,
  },
  "claude-sign-in": {
    label: "Claude sign-in",
    description:
      "Offer Sign in with Claude (a Claude plan, with a pasted code) when someone connects an AI provider. Anthropic API keys and existing sign-ins are unaffected.",
    defaultEnabled: true,
  },
} as const satisfies Record<
  string,
  { label: string; description: string; defaultEnabled: boolean }
>;

export const platformFeatureFlagKeySchema = z.enum(["chatgpt-sign-in", "claude-sign-in", "container-compute"]);
export type PlatformFeatureFlagKey = z.infer<typeof platformFeatureFlagKeySchema>;
export const platformFeatureFlagKeys = platformFeatureFlagKeySchema.options;

export const platformFeatureFlagScopeSchema = z.enum(["installation", "organisation", "user"]);
export type PlatformFeatureFlagScope = z.infer<typeof platformFeatureFlagScopeSchema>;

/** Where a person's value came from, most specific first. */
export const platformFeatureFlagSourceSchema = z.enum(["user", "organisation", "installation", "default"]);
export type PlatformFeatureFlagSource = z.infer<typeof platformFeatureFlagSourceSchema>;

export type PlatformFeatureFlagValues = Record<PlatformFeatureFlagKey, boolean>;

/** The settings that apply to one person; a missing scope has no setting. */
export interface PlatformFeatureFlagSettings {
  readonly user?: boolean;
  readonly organisation?: boolean;
  readonly installation?: boolean;
}

export function resolvePlatformFeatureFlag(
  key: PlatformFeatureFlagKey,
  settings: PlatformFeatureFlagSettings,
): { enabled: boolean; source: PlatformFeatureFlagSource } {
  for (const source of ["user", "organisation", "installation"] as const) {
    const value = settings[source];
    if (value !== undefined) return { enabled: value, source };
  }
  return { enabled: platformFeatureFlags[key].defaultEnabled, source: "default" };
}

/** USD per million tokens. Budgets count nanodollars, so at most nine decimal places. */
const usdPerMillionTokensSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(100_000)
  .refine((value) => Number(value.toFixed(9)) === value, "Use at most nine decimal places");

const aiModelPricesSchema = z.object({
  input: usdPerMillionTokensSchema,
  cachedInput: usdPerMillionTokensSchema,
  cacheWrite: usdPerMillionTokensSchema,
  output: usdPerMillionTokensSchema,
});

/**
 * One OpenAI or Anthropic model and everything the platform needs to offer it,
 * as stored and read. Unknown fields are dropped rather than refused, so a
 * value a later release saved stays readable after a rollback.
 */
export const aiModelsFlagModelSchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  /** The provider's API model ID, e.g. `gpt-6.1-sol` or `claude-haiku-5-5`. */
  model: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, "Use the provider's API model ID, for example gpt-6.1-sol"),
  /** The name people see, e.g. "GPT-6.1 Sol". */
  name: z.string().trim().min(1).max(200),
  /** The provider's standard prices, which budgets and usage estimates use. */
  usdPerMillionTokens: aiModelPricesSchema,
  contextTokens: z.number().int().positive().max(100_000_000).optional(),
});
export type AiModelsFlagModel = z.infer<typeof aiModelsFlagModelSchema>;

const aiModelKey = (entry: Pick<AiModelsFlagModel, "provider" | "model">) => `${entry.provider}/${entry.model}`;

/**
 * The `ai-models` flag's value as read: a setting's, or one person's
 * combined value, which can hold more models than one setting may.
 */
export const aiModelsFlagValueSchema = z.object({ models: z.array(aiModelsFlagModelSchema).max(10_000) });
export type AiModelsFlagValue = z.infer<typeof aiModelsFlagValueSchema>;

/**
 * What an administrator may save: known fields only, at most 200 models, each
 * once, with input and output prices above zero so budgets can limit them.
 * Built-in models already have their names and prices in code, so the flag
 * only adds models.
 */
export const aiModelsFlagInputSchema = z
  .object({
    models: z
      .array(
        aiModelsFlagModelSchema
          .extend({
            usdPerMillionTokens: aiModelPricesSchema.strict().superRefine((prices, context) => {
              for (const field of ["input", "output"] as const) {
                if (prices[field] === 0) {
                  context.addIssue({ code: "custom", path: [field], message: "Must be above zero, or budgets can't limit the model" });
                }
              }
            }),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.models.forEach((entry, index) => {
      const key = aiModelKey(entry);
      if (seen.has(key)) {
        context.addIssue({ code: "custom", path: ["models", index, "model"], message: `${key} is listed twice` });
      }
      seen.add(key);
      const builtin = platformAiModelPricingCatalog.entries.find(
        (candidate) => candidate.provider === entry.provider && candidate.model === entry.model,
      );
      if (builtin) {
        context.addIssue({
          code: "custom",
          path: ["models", index, "model"],
          message: `${builtin.displayName} is built in already; remove it from the list`,
        });
      }
    });
  });

/**
 * A narrower setting's models are added to the broader list. A model keeps the
 * broader entry, which every setting naming it agrees with (`aiModelsFlagConflicts`).
 */
function mergeAiModels(broader: AiModelsFlagValue, narrower: AiModelsFlagValue): AiModelsFlagValue {
  const known = new Set(broader.models.map(aiModelKey));
  return { models: [...broader.models, ...narrower.models.filter((entry) => !known.has(aiModelKey(entry)))] };
}

/**
 * The models `value` gives a different name, price or context size from
 * `other`. Every setting that names a model must agree, because a model has
 * one name and one price for budgets across the installation.
 */
export function aiModelsFlagConflicts(value: AiModelsFlagValue, other: AiModelsFlagValue): AiModelsFlagModel[] {
  const others = new Map(other.models.map((entry) => [aiModelKey(entry), entry]));
  return value.models.filter((entry) => {
    const match = others.get(aiModelKey(entry));
    if (!match) return false;
    const prices = (model: AiModelsFlagModel) => model.usdPerMillionTokens;
    return match.name !== entry.name || (match.contextTokens ?? null) !== (entry.contextTokens ?? null) ||
      (["input", "cachedInput", "cacheWrite", "output"] as const).some((field) => prices(match)[field] !== prices(entry)[field]);
  });
}

/**
 * Flags whose value is a JSON document of a shape defined here. A setting is
 * checked against `input` when it is saved and read with `schema`, which
 * stays lenient so a stored value remains readable when a later release
 * tightens `input`. Settings apply from the broadest to the most specific:
 * everyone's, then the organisation's, then the person's, each combined with
 * `merge`.
 */
export const platformJsonFeatureFlags = {
  "ai-models": {
    label: "AI models",
    description:
      "OpenAI and Anthropic models offered beyond the built-in ones, with their prices. A person's or organisation's setting adds models to everyone's list, so it can be used to try a new model before everyone gets it. A model must have the same name and prices in every setting that names it. Changes reach the Agent within a minute.",
    schema: aiModelsFlagValueSchema,
    input: aiModelsFlagInputSchema,
    defaultValue: { models: [] } as AiModelsFlagValue,
    merge: mergeAiModels,
    conflicts: aiModelsFlagConflicts,
  },
} as const;

export const platformJsonFeatureFlagKeySchema = z.enum(["ai-models"]);
export type PlatformJsonFeatureFlagKey = z.infer<typeof platformJsonFeatureFlagKeySchema>;
export const platformJsonFeatureFlagKeys = platformJsonFeatureFlagKeySchema.options;

/** A JSON flag's value; every JSON flag so far holds a model list. */
export type PlatformJsonFeatureFlagValue = AiModelsFlagValue;

/** Any flag an administrator can set: on/off or JSON. */
export const platformAnyFeatureFlagKeySchema = z.enum(["chatgpt-sign-in", "claude-sign-in", "container-compute", "ai-models"]);
export type PlatformAnyFeatureFlagKey = z.infer<typeof platformAnyFeatureFlagKeySchema>;

export function isPlatformJsonFeatureFlag(key: string): key is PlatformJsonFeatureFlagKey {
  return (platformJsonFeatureFlagKeys as readonly string[]).includes(key);
}

/** The settings of one JSON flag that apply to one person, unparsed. */
export interface PlatformJsonFeatureFlagSettings {
  readonly user?: unknown;
  readonly organisation?: unknown;
  readonly installation?: unknown;
}

/**
 * One person's value of a JSON flag. A stored setting that no longer reads
 * with the flag's schema is skipped rather than failing the evaluation.
 */
export function resolvePlatformJsonFeatureFlag(
  key: PlatformJsonFeatureFlagKey,
  settings: PlatformJsonFeatureFlagSettings,
): { value: PlatformJsonFeatureFlagValue; source: PlatformFeatureFlagSource } {
  const definition = platformJsonFeatureFlags[key];
  let value: PlatformJsonFeatureFlagValue = { models: [...definition.defaultValue.models] };
  let source: PlatformFeatureFlagSource = "default";
  for (const scope of ["installation", "organisation", "user"] as const) {
    if (settings[scope] === undefined) continue;
    const parsed = definition.schema.safeParse(settings[scope]);
    if (!parsed.success) continue;
    value = definition.merge(value, parsed.data);
    source = scope;
  }
  return { value, source };
}

/**
 * One person's values, as the control plane's internal evaluation returns
 * them. Unknown keys from a newer control plane are ignored and keys it
 * doesn't return keep their defaults. `values` holds JSON flags; an older
 * control plane sends none.
 */
export const platformFeatureFlagEvaluationSchema = z.object({
  flags: z.record(z.string(), z.boolean()),
  values: z.record(z.string(), z.unknown()).optional(),
});

export function platformFeatureFlagValues(
  flags: Readonly<Record<string, boolean>>,
): PlatformFeatureFlagValues {
  return Object.fromEntries(
    platformFeatureFlagKeys.map((key) => [
      key,
      Object.hasOwn(flags, key) ? flags[key]! : platformFeatureFlags[key].defaultEnabled,
    ]),
  ) as PlatformFeatureFlagValues;
}

/** One JSON flag's value from an evaluation: its default when missing or unreadable. */
export function platformJsonFeatureFlagValue(
  key: PlatformJsonFeatureFlagKey,
  values: Readonly<Record<string, unknown>> | undefined,
): PlatformJsonFeatureFlagValue {
  const definition = platformJsonFeatureFlags[key];
  const parsed = values && Object.hasOwn(values, key) ? definition.schema.safeParse(values[key]) : null;
  return parsed?.success ? parsed.data : { models: [...definition.defaultValue.models] };
}

/**
 * Every setting of one JSON flag, for a service that needs all of them: the
 * Agent service prices every model any setting names. A person's settings are
 * left out once their account is deleted, and organisation settings on
 * personal installations.
 */
export const platformJsonFeatureFlagSettingsSchema = z.object({
  settings: z
    .array(
      z.object({
        scope: platformFeatureFlagScopeSchema,
        updatedAt: z.iso.datetime({ offset: true }),
        value: z.unknown(),
      }),
    )
    .max(100_000),
});

/** `2.5` USD per million tokens as canonical nanodollars per million: `"2500000000"`. */
export function usdPerMillionToNanodollars(value: number): string {
  return BigInt(value.toFixed(9).replace(".", "")).toString();
}
