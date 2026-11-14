import { ApiError, DraftValidationWaitTimeoutError, draftValidationWaitTimeoutMs, waitForDraftValidation, type OpenCloudClient } from "./api-client.js";
import type { MutationRun } from "./mutation-journal.js";

/** Wait only on explicit progress for the journaled revision, never a lost reply. */
export async function validateDraftWithProgress(control: OpenCloudClient, input: {
  appId: string;
  draftId: string;
  revision: number;
  version?: string;
  idempotencyKey?: string;
  manifest?: { containerCount: number; frontendBuild: boolean };
  journal: Pick<MutationRun, "markUnknown">;
}) {
  let lastProgress = -Infinity;
  try {
    return await waitForDraftValidation(control, {
      appId: input.appId, draftId: input.draftId,
      body: { expectedRevision: input.revision, ...(input.version ? { version: input.version } : {}) },
    }, {
      timeoutMs: draftValidationWaitTimeoutMs(input.manifest),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      onProgress: () => {
        if (Date.now() - lastProgress < 30_000) return;
        lastProgress = Date.now();
        process.stderr.write(`Validation is still running for draft ${input.draftId}, revision ${input.revision}; waiting for its result.\n`);
      },
    });
  } catch (error) {
    if (!(error instanceof ApiError) && !(error instanceof DraftValidationWaitTimeoutError)) {
      await input.journal.markUnknown("DRAFT_VALIDATION_OUTCOME_UNKNOWN");
    }
    throw error;
  }
}
