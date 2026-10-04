interface ComposedSignal {
  signal: AbortSignal;
  cleanup(): void;
}

function abortException(message: string, name: "AbortError" | "TimeoutError") {
  if (typeof DOMException === "function")
    return new DOMException(message, name);
  const error = new Error(message);
  error.name = name;
  return error;
}

function signalReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? abortException("The request was aborted", "AbortError")
  );
}

export function composeRequestSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): ComposedSignal {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("timeoutMs must be a non-negative finite number");
  }
  const controller = new AbortController();
  const relayCallerAbort = () => controller.abort(signalReason(callerSignal!));

  if (callerSignal?.aborted) {
    relayCallerAbort();
  } else {
    callerSignal?.addEventListener("abort", relayCallerAbort, { once: true });
  }

  const timeout = controller.signal.aborted
    ? undefined
    : setTimeout(() => {
        controller.abort(
          abortException(
            `The request timed out after ${timeoutMs}ms`,
            "TimeoutError",
          ),
        );
      }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      callerSignal?.removeEventListener("abort", relayCallerAbort);
      if (timeout !== undefined) clearTimeout(timeout);
    },
  };
}

export async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signalReason(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signalReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
