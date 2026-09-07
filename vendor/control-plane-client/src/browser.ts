import { ControlPlaneTransport } from "./transport.js";

export { ApiError, isApiError } from "./errors.js";
export type { ApiErrorOptions } from "./errors.js";
export type {
  AbortableRequestOptions,
  CallOptions,
  MutationRequestOptions,
  OutputParser,
  ReadRequestOptions,
} from "./transport.js";

export interface BrowserClientOptions {
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

function sameOriginApiUrl(): string {
  const origin = globalThis.location?.origin;
  if (!origin || origin === "null") {
    throw new Error(
      "The browser control-plane client requires a same-origin document",
    );
  }
  return origin;
}

function browserIdempotencyKey(): string {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) {
    throw new Error("The browser does not support crypto.randomUUID()");
  }
  return id;
}

/** Same-origin, cookie-authenticated control-plane client for dashboard code. */
export class OpenCloudClient extends ControlPlaneTransport {
  constructor(options: BrowserClientOptions = {}) {
    super({
      apiUrl: sameOriginApiUrl(),
      credentials: "same-origin",
      createIdempotencyKey: browserIdempotencyKey,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      timeoutMs: options.timeoutMs,
    });
  }
}
