import { z } from "zod";
import { isoTimestampSchema } from "./identifiers.js";
import { agentReasoningOptionsSchema } from "./reasoning.js";

/**
 * Provider and model choices (docs/product/ai-capacity/PROVIDERS-AND-MODELS.md).
 *
 * A person picks a provider and a model together in the Agent chat. The
 * provider of the picked model pays. An app's automatic tasks (automatic
 * repairs, scheduled Agent tasks and AI calls from the app's code) follow the
 * latest pick in its chat unless the app sets its own. Nothing ever falls back
 * to another provider: a choice that can't run fails and says why.
 */

/** The API that serves a model. The same model may be reachable through two. */
export const aiModelProviderSchema = z.enum(["openai", "anthropic", "openrouter"]);
export type AiModelProvider = z.infer<typeof aiModelProviderSchema>;

/** A provider-native model id, e.g. `gpt-5.6-sol` or `moonshotai/kimi-k3`. */
export const aiNativeModelIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._:/-]*$/);

/**
 * `provider/model`, split at the first slash:
 * `openai/gpt-5.6-sol`, `openrouter/moonshotai/kimi-k3`.
 */
export const aiQualifiedModelIdSchema = z
  .string()
  .min(3)
  .max(220)
  .regex(/^(openai|anthropic|openrouter)\/[a-z0-9][a-z0-9._:/-]*$/);

export interface AiModelRef {
  provider: AiModelProvider;
  model: string;
}

export function qualifyAiModel(ref: AiModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

/**
 * A model an app's code names for one AI call: a provider-native id
 * (`claude-haiku-5-5`, `moonshotai/kimi-k3`) or a qualified one
 * (`anthropic/claude-haiku-5-5`).
 */
export const requestedAiModelSchema = z
  .string()
  .min(1)
  .max(220)
  .regex(/^[a-z0-9][a-z0-9._:/-]*$/)
  .refine((value) => !value.endsWith("/") && !value.includes("//"), "AI model is invalid");

/**
 * The model a requested id means on the provider that pays. A native id runs
 * on that provider; a qualified id names its provider, which must match.
 * OpenRouter ids already contain a vendor slash (`openai/gpt-5`), so on
 * OpenRouter only an `openrouter/` prefix is a provider.
 */
export function resolveRequestedAiModel(value: string, provider: AiModelProvider): AiModelRef {
  if (value.startsWith(`${provider}/`)) return { provider, model: value.slice(provider.length + 1) };
  if (provider === "openrouter") return { provider, model: value };
  const slash = value.indexOf("/");
  const named = aiModelProviderSchema.safeParse(slash > 0 ? value.slice(0, slash) : "");
  return named.success ? { provider: named.data, model: value.slice(slash + 1) } : { provider, model: value };
}

export function parseQualifiedAiModel(value: string): AiModelRef {
  const parsed = aiQualifiedModelIdSchema.parse(value);
  const slash = parsed.indexOf("/");
  return {
    provider: aiModelProviderSchema.parse(parsed.slice(0, slash)),
    model: parsed.slice(slash + 1),
  };
}

/** A pick: one connected provider and one of its models, or trial credit. */
export const aiModelChoiceSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("connection"),
      connectionId: z.uuid(),
      model: aiQualifiedModelIdSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("included"),
      model: aiQualifiedModelIdSchema,
    })
    .strict(),
]);
export type AiModelChoice = z.infer<typeof aiModelChoiceSchema>;

export function sameAiModelChoice(left: AiModelChoice | null, right: AiModelChoice | null): boolean {
  if (!left || !right || left.source !== right.source || left.model !== right.model) return false;
  return left.source === "included" || (right.source === "connection" && left.connectionId === right.connectionId);
}

/** Why a choice can't take new work now. */
export const aiModelProblemCodeSchema = z.enum([
  "connection_missing",
  "connection_unavailable",
  "out_of_credit",
  "rate_limited",
  "budget_reached",
  "model_off",
  "model_not_enabled",
  "no_engine",
  "trial_ended",
]);
export type AiModelProblemCode = z.infer<typeof aiModelProblemCodeSchema>;

export const aiModelProblemSchema = z
  .object({
    code: aiModelProblemCodeSchema,
    /** One plain sentence, e.g. "Acme OpenRouter key is out of credit". */
    message: z.string().trim().min(1).max(300),
  })
  .strict();
export type AiModelProblem = z.infer<typeof aiModelProblemSchema>;

/** USD nanodollars per million tokens, as decimal strings. */
export const aiModelPriceSchema = z
  .object({
    inputPerMillion: z.string().regex(/^(0|[1-9][0-9]{0,39})$/),
    outputPerMillion: z.string().regex(/^(0|[1-9][0-9]{0,39})$/),
  })
  .strict();

export const aiModelPickerOptionSchema = z
  .object({
    choice: aiModelChoiceSchema,
    label: z.string().trim().min(1).max(200),
    vendor: z.string().trim().min(1).max(100),
    price: aiModelPriceSchema.nullable(),
    problem: aiModelProblemSchema.nullable(),
    /** OpenCode's per-model choices; absent on native/legacy engines. */
    reasoning: agentReasoningOptionsSchema.optional(),
  })
  .strict();
export type AiModelPickerOption = z.infer<typeof aiModelPickerOptionSchema>;

/** One connected provider (or trial credit) and the models switched on for it. */
export const aiModelPickerGroupSchema = z
  .object({
    /** The connection id, or `included` for trial credit. */
    id: z.union([z.uuid(), z.literal("included")]),
    label: z.string().trim().min(1).max(200),
    /** E.g. "OpenAI sign-in", "OpenRouter API key · $41.20 left", "Trial credit · $4.20 left". */
    detail: z.string().trim().min(1).max(200),
    provider: aiModelProviderSchema.nullable(),
    /** Whose connected account pays; no account identity or credentials. */
    accountOwner: z.enum(["you", "app_owner", "organisation"]).optional(),
    options: z.array(aiModelPickerOptionSchema).max(200),
  })
  .strict();
export type AiModelPickerGroup = z.infer<typeof aiModelPickerGroupSchema>;

export const aiChoiceLabelSchema = z
  .object({
    model: aiQualifiedModelIdSchema,
    modelLabel: z.string().trim().min(1).max(200),
    providerLabel: z.string().trim().min(1).max(200),
  })
  .strict();
export type AiChoiceLabel = z.infer<typeof aiChoiceLabelSchema>;

/** Where an app's automatic tasks get their choice from. */
export const aiAutomaticSourceSchema = z.enum(["override", "chat", "default"]);
export type AiAutomaticSource = z.infer<typeof aiAutomaticSourceSchema>;

export const aiAutomaticStatusSchema = z
  .object({
    source: aiAutomaticSourceSchema,
    /** Null only when nothing at all can be picked. */
    choice: aiModelChoiceSchema.nullable(),
    label: aiChoiceLabelSchema.nullable(),
    problem: aiModelProblemSchema.nullable(),
  })
  .strict();
export type AiAutomaticStatus = z.infer<typeof aiAutomaticStatusSchema>;

/**
 * `GET /v1/agent-models?appId=&threadId=` (Agent browser API): what the
 * composer offers this person, and where a chat starts before anyone picks.
 */
export const agentModelPickerSchema = z
  .object({
    schemaVersion: z.literal(2),
    groups: z.array(aiModelPickerGroupSchema).max(100),
    /** The person's last pick, else the harness default, else the first option that can run. */
    defaultChoice: aiModelChoiceSchema.nullable(),
    /** The thread's own pick, when it has one. */
    threadChoice: aiModelChoiceSchema.nullable(),
    /** Personal app admins choose for their messages, without changing the shared thread. */
    selectionScope: z.enum(["conversation", "participant"]).optional(),
    ownerSharingAllowed: z.boolean().optional(),
    reasoningEfforts: z
      .array(z.object({ id: z.string().min(1).max(20), label: z.string().min(1).max(100) }).strict())
      .max(10),
    defaultReasoningEffort: z.string().min(1).max(20),
    /** For an app chat: what its automatic tasks use now. Null outside apps. */
    automatic: aiAutomaticStatusSchema.nullable(),
    /** Whether the viewer may manage providers (link to AI providers vs Connect a provider). */
    canManageProviders: z.boolean(),
  })
  .strict();
export type AgentModelPicker = z.infer<typeof agentModelPickerSchema>;

/**
 * An automatic task that couldn't run, posted to the app's canonical
 * conversation as a run-free system message (`messages.automatic_failure`).
 * Features failures are one message per cause, updated in place with a count.
 */
const automaticFailureBase = {
  schemaVersion: z.literal(1),
  episodeId: z.uuid(),
  choice: aiChoiceLabelSchema.nullable(),
  source: aiAutomaticSourceSchema,
  reason: aiModelProblemSchema,
};

export const agentAutomaticFailureSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...automaticFailureBase,
      kind: z.literal("repair"),
      /** What the repair answered, e.g. "The 18:00 daily summary job failed." */
      signal: z.string().trim().min(1).max(300),
      occurredAt: isoTimestampSchema,
    })
    .strict(),
  z
    .object({
      ...automaticFailureBase,
      kind: z.literal("task"),
      taskTitle: z.string().trim().min(1).max(200).nullable(),
      occurredAt: isoTimestampSchema,
    })
    .strict(),
  z
    .object({
      ...automaticFailureBase,
      kind: z.literal("features"),
      failedCalls: z.number().int().min(1),
      since: isoTimestampSchema,
      lastAt: isoTimestampSchema,
    })
    .strict(),
]);
export type AgentAutomaticFailure = z.infer<typeof agentAutomaticFailureSchema>;

/** The stand-alone sentence stored in the failure message's content. */
export function describeAgentAutomaticFailure(failure: AgentAutomaticFailure): string {
  const model = failure.choice
    ? `${failure.choice.modelLabel} via ${failure.choice.providerLabel}`
    : "no model";
  switch (failure.kind) {
    case "repair":
      return `Automatic repair couldn't start. ${failure.signal} It needed ${model}: ${failure.reason.message}. No other provider was tried.`;
    case "task":
      return `Scheduled task${failure.taskTitle ? ` "${failure.taskTitle}"` : ""} couldn't start. It needed ${model}: ${failure.reason.message}. No other provider was tried.`;
    case "features":
      return `AI calls from the app's code are failing: ${failure.failedCalls} failed. They need ${model}: ${failure.reason.message}. No other provider was tried.`;
  }
}
