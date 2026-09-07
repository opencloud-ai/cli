import { z } from "zod";

const apiErrorBodySchema = z
  .object({
    statusCode: z.number().int().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    requestId: z.string().optional(),
    retryable: z.boolean().optional(),
    details: z.unknown().optional(),
    operation: z.unknown().optional(),
    operationId: z.string().optional(),
  })
  .passthrough();

interface ApiErrorEvidence {
  code: string | null;
  requestId: string | null;
  retryable: boolean;
  details: unknown | null;
  operation: unknown | null;
}

export interface ApiErrorOptions {
  code?: string | null;
  requestId?: string | null;
  responseRequestId?: string | null;
  retryable?: boolean;
  details?: unknown;
  operation?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function operationEvidence(
  value: z.infer<typeof apiErrorBodySchema>,
): unknown | null {
  if (value.operation !== undefined && value.operation !== null) {
    return value.operation;
  }
  if (isRecord(value.details)) {
    if (value.details.operation !== undefined) return value.details.operation;
    if (typeof value.details.operationId === "string") {
      return { id: value.details.operationId };
    }
  }
  return value.operationId ? { id: value.operationId } : null;
}

function parseEvidence(
  status: number,
  body: unknown,
  responseRequestId?: string | null,
): ApiErrorEvidence {
  const parsed = apiErrorBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      code: null,
      requestId: responseRequestId ?? null,
      retryable: retryableStatus(status),
      details: null,
      operation: null,
    };
  }
  const detailsRetryable = isRecord(parsed.data.details)
    ? parsed.data.details.retryable
    : undefined;
  return {
    code: parsed.data.code ?? null,
    requestId: parsed.data.requestId ?? responseRequestId ?? null,
    retryable:
      parsed.data.retryable ??
      (typeof detailsRetryable === "boolean"
        ? detailsRetryable
        : retryableStatus(status)),
    details: parsed.data.details ?? null,
    operation: operationEvidence(parsed.data),
  };
}

function errorMessage(status: number, body: unknown): string {
  const parsed = apiErrorBodySchema.safeParse(body);
  const message = parsed.success ? parsed.data.message?.trim() : undefined;
  return message
    ? `OpenCloud API returned HTTP ${status}: ${message}`
    : `OpenCloud API returned HTTP ${status}`;
}

/** A parsed, request-correlated HTTP failure from the control-plane API. */
export class ApiError extends Error {
  readonly code: string | null;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly details: unknown | null;
  readonly operation: unknown | null;

  constructor(
    readonly status: number,
    readonly body: unknown,
    options: ApiErrorOptions = {},
  ) {
    super(errorMessage(status, body));
    this.name = "ApiError";
    const evidence = parseEvidence(status, body, options.responseRequestId);
    this.code = options.code ?? evidence.code;
    this.requestId = options.requestId ?? evidence.requestId;
    this.retryable = options.retryable ?? evidence.retryable;
    this.details = options.details ?? evidence.details;
    this.operation = options.operation ?? evidence.operation;
  }
}

export function apiErrorFromResponse(
  response: Response,
  body: unknown,
): ApiError {
  return new ApiError(response.status, body, {
    responseRequestId: response.headers.get("x-request-id"),
  });
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
