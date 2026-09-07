import { randomUUID } from "node:crypto";
import { ControlPlaneTransport, type TransportOptions } from "./transport.js";

export { ApiError, isApiError } from "./errors.js";
export type { ApiErrorOptions } from "./errors.js";
export type {
  AbortableRequestOptions,
  CallOptions,
  MutationRequestOptions,
  OutputParser,
  ReadRequestOptions,
} from "./transport.js";

export interface ClientOptions {
  apiUrl: string;
  token?: string | undefined;
  tokenProvider?: (() => Promise<string | undefined>) | undefined;
  internalMcpSecret?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/** Node-oriented client retaining bearer-token and deployment-upload support. */
export class OpenCloudClient extends ControlPlaneTransport {
  constructor(options: ClientOptions) {
    const transportOptions: TransportOptions = {
      ...options,
      createIdempotencyKey: randomUUID,
    };
    super(transportOptions);
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
    return this.sendRequiringToken(
      "POST",
      `/v1/apps/${encodeURIComponent(appId)}/deployments`,
      {
        body: form,
        idempotencyKey,
        timeoutMs: 120_000,
      },
    );
  }
}
