import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import WebSocket from "ws";

export interface EdgeResponse {
  ok: boolean;
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  value: unknown;
}

export interface EdgeRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
}

function parseBody(body: string): unknown {
  if (!body) return "";
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function assertHttpUrl(url: URL, label: string): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
}

function publicTarget(publicOrigin: string, pathname: string): {
  origin: URL;
  target: URL;
} {
  const origin = new URL(publicOrigin);
  assertHttpUrl(origin, "Public origin");
  const target = new URL(pathname, origin);
  if (target.origin !== origin.origin) {
    throw new Error("Edge request path must stay within the public origin");
  }
  return { origin, target };
}

export class EdgeTransport {
  private readonly adapterUrl: URL | undefined;

  constructor(adapter?: string) {
    if (adapter) {
      this.adapterUrl = new URL(adapter);
      assertHttpUrl(this.adapterUrl, "Edge adapter URL");
    }
  }

  request(
    publicOrigin: string,
    pathname: string,
    options: EdgeRequestOptions = {},
  ): Promise<EdgeResponse> {
    const resolved = publicTarget(publicOrigin, pathname);
    const target = this.adapterUrl
      ? new URL(
          `${resolved.target.pathname}${resolved.target.search}`,
          this.adapterUrl,
        )
      : resolved.target;
    const client = target.protocol === "https:" ? https : http;
    const headers: Record<string, string> = { ...options.headers };
    if (this.adapterUrl) headers.host = resolved.origin.host;

    return new Promise((resolve, reject) => {
      const request = client.request(
        target,
        {
          method: options.method ?? "GET",
          headers,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const status = response.statusCode ?? 0;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              headers: response.headers,
              body,
              value: parseBody(body),
            });
          });
        },
      );
      request.on("error", reject);
      request.setTimeout(options.timeoutMs ?? 30_000, () =>
        request.destroy(new Error(`Edge request timed out at ${pathname}`)),
      );
      if (options.body !== undefined) request.write(options.body);
      request.end();
    });
  }

  webSocket(
    publicOrigin: string,
    pathname: string,
    headers: Record<string, string>,
  ): WebSocket {
    const resolved = publicTarget(publicOrigin, pathname);
    const target = this.adapterUrl
      ? new URL(
          `${resolved.target.pathname}${resolved.target.search}`,
          this.adapterUrl,
        )
      : resolved.target;
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(target, {
      headers: {
        ...headers,
        ...(this.adapterUrl ? { host: resolved.origin.host } : {}),
      },
      perMessageDeflate: false,
    });
  }
}
