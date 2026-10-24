const callerFailures = new WeakSet<object>();

/**
 * Marks a failure the caller resolves, such as signing in, a missing or
 * invalid option, or an invalid manifest. It prints exactly as before but,
 * like an API 4xx answer, is never sent as an error report.
 */
export function callerFailure<T>(error: T): T {
  if (error && typeof error === "object") callerFailures.add(error);
  return error;
}

export function isCallerFailure(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && callerFailures.has(error),
  );
}
