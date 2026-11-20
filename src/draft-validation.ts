import { createHash } from "node:crypto";
import { draftValidationInProgressSchema } from "@opencloud/contracts/control-plane";
import { ApiError, DraftValidationWaitTimeoutError, draftValidationWaitTimeoutMs, waitForDraftValidation, type OpenCloudClient } from "./api-client.js";
import { withHint } from "./cli-contract-error.js";
import { MutationJournalError, type MutationRun } from "./mutation-journal.js";
import { CliContractError, isDefiniteRefusal } from "./owner-parity.js";

/**
 * The least any app waits for its validation. OpenCloud holds a pinned
 * request for up to 25 seconds before it says the validation is still
 * running, so a plain app (no containers, no frontend build) gets a few
 * of those answers before its wait ends.
 */
const MINIMUM_WAIT_MS = 90_000;
/** A kept window with less than this left cannot send another request: a fresh one opens. */
const MINIMUM_REMAINING_MS = 30_000;
/** OpenCloud's admission was too busy to start the validation: try again this soon. */
const ADMISSION_BUSY_DELAY_MS = 2_000;
/**
 * 3.20's flow, for an OpenCloud without pinned validation (2.35.x and older):
 * a frontend build's request may take up to 70 seconds before
 * FRONTEND_BUILD_BUSY, which is retried on the same revision.
 */
const FRONTEND_BUILD_REQUEST_MS = 9 * 60_000;
const FRONTEND_BUILD_BUSY_RETRIES = 20;
const FRONTEND_BUILD_BUSY_DELAY_MS = 6_000;

type ValidationJournal = Pick<MutationRun, "checkpoint" | "checkpointValidation" | "markAttempted" | "failIfUnknown" | "settleValidation">;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 503 APP_LOCK_BUSY: OpenCloud says this request did not start validation. */
function admissionBusy(error: ApiError): boolean {
  return error.status === 503 && error.code === "APP_LOCK_BUSY";
}

type ValidationInput = {
  appId: string;
  draftId: string;
  revision: number;
  version?: string;
  idempotencyKey?: string;
  manifest?: { containerCount: number; frontendBuild: boolean };
  /** OpenCloud advertises contracts.pinnedDraftValidation; see releaseContracts. */
  pinned: boolean;
  journal: ValidationJournal;
};

/**
 * Validates one draft revision and waits for OpenCloud's result, journaling
 * each request. Where OpenCloud pins validation to a revision, validating it
 * again joins its run, so a request whose reply never came is sent again when
 * the command runs again, never marked unknown. When this wait ends without a
 * result, the entry is settled: it holds nothing back, and the very same
 * request run again rejoins the validation, in a fresh window if the kept one
 * has passed. An OpenCloud without pinned validation gets 3.20's requests.
 */
export async function validateDraftWithProgress(control: OpenCloudClient, input: ValidationInput) {
  input.journal.failIfUnknown();
  const retained = input.journal.checkpoint?.validation;
  const requestSha256 = createHash("sha256").update(JSON.stringify({ appId: input.appId, draftId: input.draftId,
    revision: input.revision, version: input.version ?? null, idempotencyKey: input.idempotencyKey ?? null })).digest("hex");
  if (!input.pinned) return validateUnpinned(control, input, requestSha256);
  const timeoutMs = Math.max(draftValidationWaitTimeoutMs(input.manifest), MINIMUM_WAIT_MS);
  const pending = retained?.state === "progress" || retained?.state === "dispatched" ? retained : null;
  if (pending && (pending.draftId !== input.draftId || pending.revision !== input.revision || pending.requestSha256 !== requestSha256)) {
    throw new CliContractError("MUTATION_REPLAY_MISMATCH", "Validation in progress belongs to a different request; no validation was repeated");
  }
  // The kept window while it still has room for a request; otherwise a fresh
  // one for the same revision, never longer than this manifest's budget.
  const kept = pending ? Date.parse(pending.deadline) : Number.NaN;
  const deadline = Number.isFinite(kept) && kept - Date.now() >= MINIMUM_REMAINING_MS
    ? Math.min(kept, Date.now() + timeoutMs)
    : Date.now() + timeoutMs;
  if (pending?.state === "progress") {
    const delayMs = Math.max(0, Date.parse(pending.retryNotBefore) - Date.now());
    if (delayMs) await sleep(delayMs);
  }
  const coordinates = { draftId: input.draftId, revision: input.revision, requestSha256, deadline: new Date(deadline).toISOString() };
  const journaled: Pick<OpenCloudClient, "call"> = { call: async (operation, request, options) => {
    if (operation !== "validateDraft") throw new Error("Unexpected operation during journaled validation");
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining < 25_000) throw new DraftValidationWaitTimeoutError(input.appId, input.draftId, input.revision);
      await input.journal.markAttempted();
      await input.journal.checkpointValidation({ ...coordinates, state: "dispatched" });
      try {
        const result = await control.call(operation, request, { ...options, timeoutMs: Math.min(options?.timeoutMs ?? 30_000, remaining) });
        const validation = result as { id: string; draftId: string; revision: number; passed: boolean; artifactSha256: string | null };
        if (validation.draftId !== input.draftId || validation.revision !== input.revision) throw new Error("Validation returned a different draft revision");
        await input.journal.checkpointValidation({ ...coordinates, state: "result", validationId: validation.id,
          passed: validation.passed, artifactSha256: validation.artifactSha256 });
        return result;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        const parsed = error.status === 429 && error.retryable ? draftValidationInProgressSchema.safeParse(error.body) : null;
        if (parsed?.success && parsed.data.details.appId === input.appId && parsed.data.details.draftId === input.draftId &&
            parsed.data.details.revision === input.revision) {
          await input.journal.checkpointValidation({ ...coordinates, state: "progress",
            retryNotBefore: new Date(Date.now() + parsed.data.details.retryAfterSeconds * 1_000).toISOString() });
        } else if (admissionBusy(error)) {
          // Nothing started, so the same request goes again while time allows.
          await input.journal.checkpointValidation({ ...coordinates, state: "refused" });
          if (deadline - Date.now() < ADMISSION_BUSY_DELAY_MS + 25_000) throw error;
          await sleep(ADMISSION_BUSY_DELAY_MS);
          continue;
        } else if (isDefiniteRefusal(error)) {
          // OpenCloud's own non-retryable 4xx: this validation is not running.
          // A proxy's answer, a timeout or a busy code proves nothing.
          await input.journal.checkpointValidation({ ...coordinates, state: "refused" });
        }
        throw error;
      }
    }
  } };
  let lastProgress = -Infinity;
  try {
    return await waitForDraftValidation(journaled, {
      appId: input.appId, draftId: input.draftId,
      body: { expectedRevision: input.revision, ...(input.version ? { version: input.version } : {}) },
    }, {
      timeoutMs: Math.max(30_000, deadline - Date.now()),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      onProgress: () => {
        if (Date.now() - lastProgress < 30_000) return;
        lastProgress = Date.now();
        process.stderr.write(`Validation is still running for draft ${input.draftId}, revision ${input.revision}; waiting for its result.\n`);
      },
    });
  } catch (error) {
    return settleEndedValidation(input, error);
  }
}

/**
 * Settles a validation this run stopped waiting for, then rethrows: refused
 * when OpenCloud answered (the next run starts afresh), otherwise waiting
 * (the same request rejoins it), with the next step as the error's hint.
 */
async function settleEndedValidation(input: ValidationInput, error: unknown): Promise<never> {
  const validation = input.journal.checkpoint?.validation;
  // The journal's own refusals, and anything after the result, settle nothing.
  if (validation?.state === "result" || error instanceof MutationJournalError || error instanceof CliContractError) throw error;
  if (validation?.state === "refused" && error instanceof ApiError && !admissionBusy(error)) {
    await input.journal.settleValidation("refused");
    throw error;
  }
  // OpenCloud may still be validating (or its admission stayed busy): this
  // run stops waiting, and the same request run again rejoins it.
  const settled = await input.journal.settleValidation("waiting");
  if (error instanceof DraftValidationWaitTimeoutError) {
    throw new MutationJournalError("DRAFT_VALIDATION_WAIT_TIMEOUT",
      `OpenCloud is still validating draft ${input.draftId}, revision ${input.revision}; this did not cancel it, and this command stopped waiting.`,
      true, settled);
  }
  if (error instanceof ApiError && admissionBusy(error)) {
    withHint(error, `OpenCloud was too busy to start validating draft ${input.draftId}, revision ${input.revision}, so nothing started. Run the same command again shortly.`);
  } else if (error instanceof Error) {
    withHint(error, `OpenCloud may still be validating draft ${input.draftId}, revision ${input.revision}. Run the same command again: it validates that revision again and waits for the result.`);
  }
  throw error;
}

/**
 * 3.20's validation, for an OpenCloud that does not advertise
 * pinnedDraftValidation (2.35.x and older). That server ignores
 * expectedRevision and validates the draft as it is; it holds a frontend
 * build's request up to 70 seconds, then answers FRONTEND_BUILD_BUSY while
 * the build goes on, and validating the same revision again waits on it. So:
 * one request at a time, nine minutes for a build, that answer retried on the
 * same revision, journaled as the pinned path is.
 */
async function validateUnpinned(control: OpenCloudClient, input: ValidationInput, requestSha256: string) {
  const built = input.manifest?.frontendBuild === true;
  const coordinates = { draftId: input.draftId, revision: input.revision, requestSha256,
    deadline: new Date(Date.now() + (FRONTEND_BUILD_BUSY_RETRIES + 1) * (FRONTEND_BUILD_REQUEST_MS + FRONTEND_BUILD_BUSY_DELAY_MS)).toISOString() };
  try {
    for (let attempt = 0; ; attempt += 1) {
      await input.journal.markAttempted();
      await input.journal.checkpointValidation({ ...coordinates, state: "dispatched" });
      try {
        const result = await control.call("validateDraft",
          { appId: input.appId, draftId: input.draftId, body: input.version ? { version: input.version } : {} },
          { ...(built ? { timeoutMs: FRONTEND_BUILD_REQUEST_MS } : {}), ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) });
        if (result.draftId !== input.draftId || result.revision !== input.revision) {
          // That server validated the draft as it is now: it changed meanwhile.
          await input.journal.checkpointValidation({ ...coordinates, state: "refused" });
          await input.journal.settleValidation("refused");
          throw new CliContractError("DRAFT_REVISION_CHANGED",
            `OpenCloud validated revision ${result.revision} of draft ${result.draftId}, not revision ${input.revision}, which this command uploaded: the draft changed meanwhile. Run the command again.`);
        }
        await input.journal.checkpointValidation({ ...coordinates, state: "result", validationId: result.id,
          passed: result.passed, artifactSha256: result.artifactSha256 });
        return result;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (built && error.code === "FRONTEND_BUILD_BUSY" && attempt < FRONTEND_BUILD_BUSY_RETRIES) {
          // This request ended; the build goes on, and validating again waits on it.
          await input.journal.checkpointValidation({ ...coordinates, state: "refused" });
          process.stderr.write("OpenCloud is still building this app's frontend (or another build for it); validating the same revision again.\n");
          await sleep(FRONTEND_BUILD_BUSY_DELAY_MS);
          continue;
        }
        if (isDefiniteRefusal(error)) await input.journal.checkpointValidation({ ...coordinates, state: "refused" });
        throw error;
      }
    }
  } catch (error) {
    return settleEndedValidation(input, error);
  }
}
