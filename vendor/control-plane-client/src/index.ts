import { randomUUID } from "node:crypto";
import {
  controlPlaneOperations,
  type ControlPlaneOperationId,
  type ControlPlaneOperationInput,
  type ControlPlaneOperationOutput,
} from "@opencloud/contracts";

export const OPEN_CLOUD_CLIENT_CAPABILITIES_HEADER =
  "x-opencloud-client-capabilities";
export const OPEN_CLOUD_DEV_SESSION_CAPABILITIES_V2 =
  "dev-session-capabilities-v2";

const OPEN_CLOUD_CLIENT_CAPABILITIES =
  OPEN_CLOUD_DEV_SESSION_CAPABILITIES_V2;

export interface ClientOptions {
  apiUrl: string;
  token?: string | undefined;
  tokenProvider?: (() => Promise<string | undefined>) | undefined;
  internalMcpSecret?: string | undefined;
  fetch?: typeof fetch | undefined;
}

export interface CallOptions {
  idempotencyKey?: string | undefined;
  timeoutMs?: number | undefined;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(
      `OpenCloud API returned HTTP ${status}: ${
        body && typeof body === "object" && "message" in body
          ? String(body.message)
          : JSON.stringify(body)
      }`,
    );
  }
}

export class OpenCloudClient {
  private readonly apiUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.fetcher = options.fetch ?? fetch;
  }

  async call<T extends ControlPlaneOperationId>(
    operationId: T,
    rawInput: ControlPlaneOperationInput<T>,
    options: CallOptions = {},
  ): Promise<ControlPlaneOperationOutput<T>> {
    const operation = controlPlaneOperations[operationId];
    const input = operation.input.parse(rawInput) as Record<string, unknown>;
    let requestPath = operation.path;
    requestPath = requestPath.replace(
      /\{([^}]+)\}/g,
      (_, name: string) => {
        const value = input[name];
        if (typeof value !== "string") {
          throw new Error(`Operation ${operationId} is missing path ${name}`);
        }
        return encodeURIComponent(value);
      },
    );
    const query = input.query;
    if (query && typeof query === "object") {
      const search = new URLSearchParams();
      for (const [name, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          search.set(name, String(value));
        }
      }
      const encoded = search.toString();
      if (encoded) requestPath += `?${encoded}`;
    }
    const idempotencyKey =
      operation.idempotency === "required"
        ? options.idempotencyKey ?? randomUUID()
        : options.idempotencyKey;
    const response = await this.request(
      operation.method,
      requestPath,
      "body" in input ? input.body : undefined,
      idempotencyKey,
      options.timeoutMs,
    );
    return operation.output.parse(response) as ControlPlaneOperationOutput<T>;
  }

  get(path: string): Promise<unknown> {
    return this.request("GET", path);
  }

  post(
    path: string,
    body?: unknown,
    idempotencyKey = randomUUID(),
  ): Promise<unknown> {
    return this.request("POST", path, body, idempotencyKey);
  }

  patch(
    path: string,
    body: unknown,
    idempotencyKey = randomUUID(),
  ): Promise<unknown> {
    return this.request("PATCH", path, body, idempotencyKey);
  }

  put(
    path: string,
    body: unknown,
    idempotencyKey = randomUUID(),
  ): Promise<unknown> {
    return this.request("PUT", path, body, idempotencyKey);
  }

  delete(path: string, idempotencyKey = randomUUID()): Promise<unknown> {
    return this.request("DELETE", path, undefined, idempotencyKey);
  }

  async uploadDeployment(
    appId: string,
    manifest: unknown,
    archive: Buffer,
    idempotencyKey = randomUUID(),
  ): Promise<unknown> {
    const token = await this.resolveToken();
    if (!token) {
      throw new Error("An OpenCloud credential is required");
    }
    const form = new FormData();
    form.append("manifest", JSON.stringify(manifest));
    const bytes = new Uint8Array(archive.byteLength);
    bytes.set(archive);
    form.append(
      "artifact",
      new Blob([bytes], { type: "application/gzip" }),
      "opencloud-bundle.tgz",
    );
    const response = await this.fetcher(
      `${this.apiUrl}/v1/apps/${encodeURIComponent(appId)}/deployments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": idempotencyKey,
          [OPEN_CLOUD_CLIENT_CAPABILITIES_HEADER]:
            OPEN_CLOUD_CLIENT_CAPABILITIES,
        },
        body: form,
        signal: AbortSignal.timeout(120_000),
      },
    );
    return this.parse(response);
  }

  private async request(
    method: string,
    requestPath: string,
    body?: unknown,
    idempotencyKey?: string,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const token = await this.resolveToken();
    const response = await this.fetcher(`${this.apiUrl}${requestPath}`, {
      method,
      headers: {
        ...(token
          ? { authorization: `Bearer ${token}` }
          : {}),
        ...(this.options.internalMcpSecret
          ? {
              "x-opencloud-mcp-internal":
                this.options.internalMcpSecret,
            }
          : {}),
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        [OPEN_CLOUD_CLIENT_CAPABILITIES_HEADER]:
          OPEN_CLOUD_CLIENT_CAPABILITIES,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.parse(response);
  }

  private resolveToken(): Promise<string | undefined> {
    return this.options.tokenProvider
      ? this.options.tokenProvider()
      : Promise.resolve(this.options.token);
  }

  private async parse(response: Response): Promise<unknown> {
    const text = await response.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        // Preserve non-JSON backend error text.
      }
    }
    if (!response.ok) throw new ApiError(response.status, body);
    return body;
  }
}
