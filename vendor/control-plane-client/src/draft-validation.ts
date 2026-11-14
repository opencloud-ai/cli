import {
  draftValidationInProgressSchema,
  type ControlPlaneOperationInput,
  type ControlPlaneOperationOutput,
} from "@opencloud/contracts/control-plane";
import { ApiError } from "./errors.js";
import type { ControlPlaneTransport } from "./transport.js";

const REQUEST_TIMEOUT_MS = 30_000;
const UNKNOWN_MANIFEST_WAIT_MS = 60 * 60_000;

/** Total waiting budget, spread over short requests; never an HTTP timeout. */
export function draftValidationWaitTimeoutMs(manifest?: {
  containerCount: number;
  frontendBuild: boolean;
}): number {
  if (!manifest) return UNKNOWN_MANIFEST_WAIT_MS;
  const { containerCount, frontendBuild } = manifest;
  if (!Number.isInteger(containerCount) || containerCount < 0 || containerCount > 10) {
    throw new RangeError("A manifest may declare zero to ten containers");
  }
  if (!containerCount && !frontendBuild) return REQUEST_TIMEOUT_MS;
  // Ten sequential five-minute image resolutions, the existing nine-minute
  // frontend allowance, and one minute for local validation and short polls.
  return containerCount * 300_000 + (frontendBuild ? 9 * 60_000 : 0) + 60_000;
}

export class DraftValidationWaitTimeoutError extends Error {
  readonly code = "DRAFT_VALIDATION_WAIT_TIMEOUT";
  readonly retryable = true;
  constructor(readonly appId: string, readonly draftId: string, readonly revision: number) {
    super(`Validation is still pending for draft ${draftId}, revision ${revision}. Wait and validate that same revision again; this did not cancel server work.`);
    this.name = "DraftValidationWaitTimeoutError";
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The request was aborted", "AbortError");
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(abortReason(signal!)); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Opt-in waiting for one immutable draft revision. Generic call() remains a
 * single request. Only explicit, matching in-progress responses are repeated;
 * a lost response, arbitrary 429 or network timeout is never retried here.
 */
export async function waitForDraftValidation(
  client: Pick<ControlPlaneTransport, "call">,
  input: ControlPlaneOperationInput<"validateDraft">,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    idempotencyKey?: string;
    onProgress?: (details: { appId: string; draftId: string; revision: number }) => void;
  } = {},
): Promise<ControlPlaneOperationOutput<"validateDraft">> {
  const timeoutMs = options.timeoutMs ?? UNKNOWN_MANIFEST_WAIT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < REQUEST_TIMEOUT_MS || timeoutMs > UNKNOWN_MANIFEST_WAIT_MS) {
    throw new RangeError("Validation waiting must be between 30 seconds and 60 minutes");
  }
  const deadline = Date.now() + timeoutMs;
  const requestOptions = {
    timeoutMs: REQUEST_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  };
  let revision = input.body.expectedRevision;
  if (revision === undefined) {
    revision = (await client.call("getDraft", { appId: input.appId, draftId: input.draftId }, requestOptions)).revision;
  }
  const coordinates = { appId: input.appId, draftId: input.draftId, revision };
  const pinnedInput = { ...input, body: { ...input.body, expectedRevision: revision } };
  let first = true;
  for (;;) {
    options.signal?.throwIfAborted();
    // Do not start another mutation whose reply cannot fit in the remaining
    // budget. Expiring a wait is not a reason to abort a fresh server request.
    const remaining = deadline - Date.now();
    if (remaining < (first ? 25_000 : REQUEST_TIMEOUT_MS)) {
      throw new DraftValidationWaitTimeoutError(input.appId, input.draftId, revision);
    }
    first = false;
    try {
      const result = await client.call("validateDraft", pinnedInput, { ...requestOptions, timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining) });
      if (result.draftId !== input.draftId || result.revision !== revision) {
        throw new Error("Validation returned evidence for a different draft revision; no request was retried");
      }
      return result;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 429 || !error.retryable) throw error;
      const parsed = draftValidationInProgressSchema.safeParse(error.body);
      if (!parsed.success || parsed.data.details.appId !== input.appId ||
          parsed.data.details.draftId !== input.draftId || parsed.data.details.revision !== revision) throw error;
      options.onProgress?.(coordinates);
      const waitMs = parsed.data.details.retryAfterSeconds * 1_000;
      if (deadline - Date.now() < waitMs + REQUEST_TIMEOUT_MS) {
        throw new DraftValidationWaitTimeoutError(input.appId, input.draftId, revision);
      }
      await delay(waitMs, options.signal);
    }
  }
}
