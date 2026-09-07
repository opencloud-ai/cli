export * from "@opencloud/control-plane-client";
import { OpenCloudClient as PlatformClient, type ClientOptions } from "@opencloud/control-plane-client";
import { apiErrorFromResponse } from "../vendor/control-plane-client/src/errors.js";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

/** CLI disk transfers remain outside the portable platform client snapshot. */
export class OpenCloudClient extends PlatformClient {
  constructor(private readonly transferOptions: ClientOptions) { super(transferOptions); }

  private async transferHeaders(): Promise<Record<string, string>> {
    const token = this.transferOptions.tokenProvider ? await this.transferOptions.tokenProvider() : this.transferOptions.token;
    if (!token) throw new Error("An OpenCloud credential is required");
    return { authorization: `Bearer ${token}` };
  }

  async uploadFile(method: "POST" | "PUT", requestPath: string, filePath: string,
    options: { contentType?: string; idempotencyKey?: string; timeoutMs?: number } = {}): Promise<unknown> {
    const headers = await this.transferHeaders();
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error("Upload source must be a file");
    const source = createReadStream(filePath);
    try {
      const response = await (this.transferOptions.fetch ?? fetch)(`${this.transferOptions.apiUrl.replace(/\/$/, "")}${requestPath}`, {
        method, headers: { ...headers, accept: "application/json",
          ...(options.contentType ? { "content-type": options.contentType } : {}),
          "content-length": String(metadata.size), "idempotency-key": options.idempotencyKey ?? randomUUID() },
        body: Readable.toWeb(source) as BodyInit, duplex: "half",
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      } as RequestInit & { duplex: "half" });
      const body = await transferResponseBody(response);
      if (!response.ok) throw apiErrorFromResponse(response, body);
      return body;
    } finally { source.destroy(); }
  }

  async download(requestPath: string, timeoutMs = 120_000): Promise<Response> {
    const response = await (this.transferOptions.fetch ?? fetch)(`${this.transferOptions.apiUrl.replace(/\/$/, "")}${requestPath}`, {
      method: "GET", headers: { ...await this.transferHeaders(), accept: "*/*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const body = await transferResponseBody(response);
      throw apiErrorFromResponse(response, body);
    }
    return response;
  }
}

async function transferResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}
