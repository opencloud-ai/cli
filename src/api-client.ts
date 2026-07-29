import { randomUUID } from "node:crypto";

export interface ClientOptions {
  apiUrl: string;
  token: string;
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

  constructor(private readonly options: ClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
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
    const form = new FormData();
    form.append("manifest", JSON.stringify(manifest));
    const bytes = new Uint8Array(archive.byteLength);
    bytes.set(archive);
    form.append(
      "artifact",
      new Blob([bytes], { type: "application/gzip" }),
      "opencloud-bundle.tgz",
    );
    const response = await fetch(
      `${this.apiUrl}/v1/apps/${encodeURIComponent(appId)}/deployments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "idempotency-key": idempotencyKey,
        },
        body: form,
        signal: AbortSignal.timeout(120_000),
      },
    );
    return this.parse(response);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    return this.parse(response);
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
