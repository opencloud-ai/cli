import type { ReadableIssue } from "./readable-issues.js";

/**
 * A failure with a stable code that the CLI prints as structured JSON. Kept
 * apart from owner-parity.ts, which re-exports it, so the API client can
 * raise it without an import cycle.
 */
export class CliContractError extends Error {
  readonly retryable: boolean;
  /** One readable line per problem, as `path: what is expected`. */
  readonly issues: ReadableIssue[] | undefined;

  constructor(
    readonly code: string,
    message: string,
    options: { retryable?: boolean; cause?: unknown; issues?: ReadableIssue[] } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "CliContractError";
    this.retryable = options.retryable ?? false;
    this.issues = options.issues;
  }
}
