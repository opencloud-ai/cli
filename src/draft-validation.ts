import { createHash } from "node:crypto";
import { draftValidationInProgressSchema } from "@opencloud/contracts/control-plane";
import { ApiError, DraftValidationWaitTimeoutError, draftValidationWaitTimeoutMs, waitForDraftValidation, type OpenCloudClient } from "./api-client.js";
import type { MutationRun } from "./mutation-journal.js";
import { CliContractError } from "./owner-parity.js";

// Only named API refusals establish that validation did not remain in flight.
// A proxy timeout, generic execution failure or unrelated busy response does
// not acknowledge the dispatched request, even when it has an HTTP status.
const DEFINITE_REFUSALS = new Set([
  "400:invalid_request", "400:bad_request", "401:unauthorized", "403:forbidden",
  "404:not_found", "405:method_not_allowed", "409:DRAFT_REVISION_CHANGED",
  "413:payload_too_large", "415:unsupported_media_type",
]);

/** Wait only on explicit progress for the journaled revision, never a lost reply. */
export async function validateDraftWithProgress(control: OpenCloudClient, input: {
  appId: string;
  draftId: string;
  revision: number;
  version?: string;
  idempotencyKey?: string;
  manifest?: { containerCount: number; frontendBuild: boolean };
  journal: Pick<MutationRun, "checkpoint" | "checkpointValidation" | "markAttempted" | "markUnknown" | "failIfUnknown">;
}) {
  input.journal.failIfUnknown();
  const retained = input.journal.checkpoint?.validation;
  const requestSha256 = createHash("sha256").update(JSON.stringify({ appId: input.appId, draftId: input.draftId,
    revision: input.revision, version: input.version ?? null, idempotencyKey: input.idempotencyKey ?? null })).digest("hex");
  const timeoutMs = draftValidationWaitTimeoutMs(input.manifest);
  const progress = retained?.state === "progress" ? retained : null;
  if (progress && (progress.draftId !== input.draftId || progress.revision !== input.revision || progress.requestSha256 !== requestSha256)) {
    throw new CliContractError("MUTATION_REPLAY_MISMATCH", "Validation progress belongs to a different request; no validation was repeated");
  }
  const deadline = progress ? Date.parse(progress.deadline) : Date.now() + timeoutMs;
  if (progress) {
    const delayMs = Math.max(0, Date.parse(progress.retryNotBefore) - Date.now());
    if (deadline - Date.now() < delayMs + 30_000) throw new DraftValidationWaitTimeoutError(input.appId, input.draftId, input.revision);
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  const coordinates = { draftId: input.draftId, revision: input.revision, requestSha256, deadline: new Date(deadline).toISOString() };
  const journaled: Pick<OpenCloudClient, "call"> = { call: async (operation, request, options) => {
    if (operation !== "validateDraft") throw new Error("Unexpected operation during journaled validation");
    if (deadline - Date.now() < 25_000) throw new DraftValidationWaitTimeoutError(input.appId, input.draftId, input.revision);
    await input.journal.markAttempted();
    await input.journal.checkpointValidation({ ...coordinates, state: "dispatched" });
    try {
      const remaining = deadline - Date.now();
      if (remaining < 25_000) throw new DraftValidationWaitTimeoutError(input.appId, input.draftId, input.revision);
      const result = await control.call(operation, request, { ...options, timeoutMs: Math.min(options?.timeoutMs ?? 30_000, remaining) });
      const validation = result as { id: string; draftId: string; revision: number; passed: boolean; artifactSha256: string | null };
      if (validation.draftId !== input.draftId || validation.revision !== input.revision) throw new Error("Validation returned a different draft revision");
      await input.journal.checkpointValidation({ ...coordinates, state: "result", validationId: validation.id,
        passed: validation.passed, artifactSha256: validation.artifactSha256 });
      return result;
    } catch (error) {
      if (error instanceof ApiError) {
        const parsed = error.status === 429 && error.retryable ? draftValidationInProgressSchema.safeParse(error.body) : null;
        if (parsed?.success && parsed.data.details.appId === input.appId && parsed.data.details.draftId === input.draftId &&
            parsed.data.details.revision === input.revision) {
          await input.journal.checkpointValidation({ ...coordinates, state: "progress",
            retryNotBefore: new Date(Date.now() + parsed.data.details.retryAfterSeconds * 1_000).toISOString() });
        } else if (!error.retryable && DEFINITE_REFUSALS.has(`${error.status}:${error.code}`)) {
          await input.journal.checkpointValidation({ ...coordinates, state: "refused" });
        }
      }
      throw error;
    }
  } };
  let lastProgress = -Infinity;
  try {
    const remaining = deadline - Date.now();
    if (remaining < (progress ? 30_000 : 25_000)) throw new DraftValidationWaitTimeoutError(input.appId, input.draftId, input.revision);
    return await waitForDraftValidation(journaled, {
      appId: input.appId, draftId: input.draftId,
      body: { expectedRevision: input.revision, ...(input.version ? { version: input.version } : {}) },
    }, {
      timeoutMs: progress ? remaining : timeoutMs,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      onProgress: () => {
        if (Date.now() - lastProgress < 30_000) return;
        lastProgress = Date.now();
        process.stderr.write(`Validation is still running for draft ${input.draftId}, revision ${input.revision}; waiting for its result.\n`);
      },
    });
  } catch (error) {
    if (input.journal.checkpoint?.validation?.state === "dispatched" ||
        (!(error instanceof ApiError) && !(error instanceof DraftValidationWaitTimeoutError))) {
      await input.journal.markUnknown("DRAFT_VALIDATION_OUTCOME_UNKNOWN");
    }
    throw error;
  }
}
