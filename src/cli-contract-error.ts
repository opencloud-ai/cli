import type { ReadableIssue } from "./readable-issues.js";

const hints = new WeakMap<object, string>();

/**
 * Adds what to run next to any failure, including an API error the CLI
 * passes on. Printed as the structured error's `hint`; never in reports.
 */
export function withHint<T>(error: T, hint: string): T {
  if (error && typeof error === "object") hints.set(error, hint);
  return error;
}

export function hintOf(error: unknown): string | undefined {
  return error && typeof error === "object" ? hints.get(error) : undefined;
}

/** Identifiers and states a structured error may name; never request content. */
export type CliErrorFields = Record<string, string | number | boolean | null>;

/**
 * A failure with a stable code that the CLI prints as structured JSON. Kept
 * apart from owner-parity.ts, which re-exports it, so the API client can
 * raise it without an import cycle.
 */
export class CliContractError extends Error {
  readonly retryable: boolean;
  /** One readable line per problem, as `path: what is expected`. */
  readonly issues: ReadableIssue[] | undefined;
  /** Extra identifiers printed beside the code, such as release IDs. */
  readonly fields: CliErrorFields | undefined;
  /** What the refused input should have been, shaped as OpenCloud's own details. */
  readonly details: Record<string, unknown> | undefined;

  constructor(
    readonly code: string,
    message: string,
    options: {
      retryable?: boolean; cause?: unknown; issues?: ReadableIssue[]; hint?: string; fields?: CliErrorFields;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "CliContractError";
    this.retryable = options.retryable ?? false;
    this.issues = options.issues;
    this.fields = options.fields;
    this.details = options.details;
    if (options.hint) withHint(this, options.hint);
  }
}
