import {
  controlPlaneOperations,
  type ControlPlaneOperationId,
  type ControlPlaneOperationInput,
  type ControlPlaneOperationOutput,
} from "@opencloud/contracts/control-plane";
import { apiErrorFromResponse } from "./errors.js";

export { ApiError, isApiError } from "./errors.js";
export type { ApiErrorOptions } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface OutputParser<T> {
  parse(value: unknown): T;
}

export interface AbortableRequestOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  cacheControl?: "no-cache" | undefined;
}

export interface CallOptions extends AbortableRequestOptions {
  idempotencyKey?: string | undefined;
}

export interface ReadRequestOptions<
  T = unknown,
> extends AbortableRequestOptions {
  schema?: OutputParser<T> | undefined;
}

export interface MutationRequestOptions<
  T = unknown,
> extends ReadRequestOptions<T> {
  idempotencyKey?: string | undefined;
}

export interface TransportOptions {
  apiUrl: string;
  token?: string | undefined;
  tokenProvider?: (() => Promise<string | undefined>) | undefined;
  internalMcpSecret?: string | undefined;
  fetch?: typeof fetch | undefined;
  credentials?: RequestCredentials | undefined;
  timeoutMs?: number | undefined;
  createIdempotencyKey: () => string;
}

interface SendOptions<T> extends AbortableRequestOptions {
  body?: BodyInit | undefined;
  headers?: HeadersInit | undefined;
  idempotencyKey?: string | undefined;
  requireToken?: boolean | undefined;
  schema?: OutputParser<T> | undefined;
}

export { composeRequestSignal } from "./request-signal.js";
import { composeRequestSignal, withAbort } from "./request-signal.js";

function queryPath(
  operationId: ControlPlaneOperationId,
  path: string,
  input: Record<string, unknown>,
): string {
  let requestPath = path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = input[name];
    if (typeof value !== "string") {
      throw new Error(`Operation ${operationId} is missing path ${name}`);
    }
    return encodeURIComponent(value);
  });
  const query = input.query;
  if (query && typeof query === "object") {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined && value !== null)
        search.set(name, String(value));
    }
    const encoded = search.toString();
    if (encoded) requestPath += `?${encoded}`;
  }
  return requestPath;
}

function mutationOptions<T>(
  value: string | MutationRequestOptions<T> | undefined,
): MutationRequestOptions<T> {
  return typeof value === "string" ? { idempotencyKey: value } : (value ?? {});
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Environment-neutral JSON transport shared by the Node and browser clients. */
export class ControlPlaneTransport {
  private readonly apiUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly defaultTimeoutMs: number;

  constructor(private readonly options: TransportOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.fetcher = options.fetch ?? fetch;
    this.defaultTimeoutMs = options.timeoutMs ?? 30_000;
  }

  async call<T extends ControlPlaneOperationId>(
    operationId: T,
    rawInput: ControlPlaneOperationInput<T>,
    options: CallOptions = {},
  ): Promise<ControlPlaneOperationOutput<T>> {
    const operation = controlPlaneOperations[operationId];
    const input = operation.input.parse(rawInput) as Record<string, unknown>;
    const idempotencyKey =
      operation.idempotency === "required"
        ? (options.idempotencyKey ?? this.options.createIdempotencyKey())
        : options.idempotencyKey;
    const result = await this.requestJson(
      operation.method,
      queryPath(operationId, operation.path, input),
      "body" in input ? input.body : undefined,
      {
        ...options,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    );
    return operation.output.parse(result) as ControlPlaneOperationOutput<T>;
  }

  get<T = unknown>(
    path: string,
    options: ReadRequestOptions<T> = {},
  ): Promise<T> {
    return this.send("GET", path, options);
  }

  post<T = unknown>(
    path: string,
    body?: unknown,
    idempotencyKeyOrOptions?: string | MutationRequestOptions<T>,
  ): Promise<T> {
    return this.requestJson(
      "POST",
      path,
      body,
      mutationOptions(idempotencyKeyOrOptions),
      true,
    );
  }

  patch<T = unknown>(
    path: string,
    body: unknown,
    idempotencyKeyOrOptions?: string | MutationRequestOptions<T>,
  ): Promise<T> {
    return this.requestJson(
      "PATCH",
      path,
      body,
      mutationOptions(idempotencyKeyOrOptions),
      true,
    );
  }

  put<T = unknown>(
    path: string,
    body: unknown,
    idempotencyKeyOrOptions?: string | MutationRequestOptions<T>,
  ): Promise<T> {
    return this.requestJson(
      "PUT",
      path,
      body,
      mutationOptions(idempotencyKeyOrOptions),
      true,
    );
  }

  delete<T = unknown>(
    path: string,
    idempotencyKeyOrOptions?: string | MutationRequestOptions<T>,
  ): Promise<T> {
    const options = mutationOptions(idempotencyKeyOrOptions);
    return this.send("DELETE", path, {
      ...options,
      idempotencyKey:
        options.idempotencyKey ?? this.options.createIdempotencyKey(),
    });
  }

  protected requestJson<T = unknown>(
    method: HttpMethod,
    path: string,
    body: unknown,
    options: MutationRequestOptions<T> = {},
    ensureIdempotencyKey = false,
  ): Promise<T> {
    return this.send(method, path, {
      ...options,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
      ...(ensureIdempotencyKey
        ? {
            idempotencyKey:
              options.idempotencyKey ?? this.options.createIdempotencyKey(),
          }
        : {}),
    });
  }

  /** Resolve and require a bearer credential before invoking the fetcher. */
  protected sendRequiringToken<T = unknown>(
    method: HttpMethod,
    requestPath: string,
    options: Omit<SendOptions<T>, "requireToken"> = {},
  ): Promise<T> {
    return this.send(method, requestPath, { ...options, requireToken: true });
  }

  protected async send<T = unknown>(
    method: HttpMethod,
    requestPath: string,
    options: SendOptions<T> = {},
  ): Promise<T> {
    const composed = composeRequestSignal(
      options.signal,
      options.timeoutMs ?? this.defaultTimeoutMs,
    );
    try {
      const token = await withAbort(this.resolveToken(), composed.signal);
      if (options.requireToken && !token) {
        throw new Error("An OpenCloud credential is required");
      }
      const headers = new Headers(options.headers);
      headers.set("accept", "application/json");
      if (token) headers.set("authorization", `Bearer ${token}`);
      if (this.options.internalMcpSecret) {
        headers.set("x-opencloud-mcp-internal", this.options.internalMcpSecret);
      }
      if (options.idempotencyKey) {
        headers.set("idempotency-key", options.idempotencyKey);
      }
      if (options.cacheControl) headers.set("cache-control", options.cacheControl);
      const init: RequestInit = {
        method,
        headers,
        signal: composed.signal,
      };
      if (this.options.credentials) init.credentials = this.options.credentials;
      if (options.body !== undefined) init.body = options.body;
      const response = await this.fetcher(`${this.apiUrl}${requestPath}`, init);
      const body = await responseBody(response);
      if (!response.ok) throw apiErrorFromResponse(response, body);
      return options.schema ? options.schema.parse(body) : (body as T);
    } finally {
      composed.cleanup();
    }
  }

  private resolveToken(): Promise<string | undefined> {
    return this.options.tokenProvider
      ? this.options.tokenProvider()
      : Promise.resolve(this.options.token);
  }
}
