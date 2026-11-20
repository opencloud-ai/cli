import { createHash } from "node:crypto";
import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import { lookup } from "node:dns";
import type { LookupFunction } from "node:net";
import WebSocket from "ws";
import { callerFailure } from "./caller-failure.js";

export interface EdgeResponse {
  ok: boolean;
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  value: unknown;
}

/** A response read as it arrives: counted and hashed, with only its first bytes kept. */
export interface EdgeStreamedResponse {
  ok: boolean;
  status: number;
  headers: IncomingHttpHeaders;
  bodyBytes: number;
  bodySha256: string;
  /** At most the requested number of bytes from the start of the body. */
  head: Buffer;
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
    throw callerFailure(new Error("Edge request path must stay within the public origin"));
  }
  return { origin, target };
}

export class EdgeTransport {
  private readonly adapterUrl: URL | undefined;
  private readonly lookup: LookupFunction | undefined;

  constructor(adapter?: string, publicEdgeHost?: string) {
    if (publicEdgeHost) {
      if (adapter || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(publicEdgeHost)) {
        throw new Error("Public edge host must be a hostname without an edge adapter");
      }
      // Change only address resolution. Keep the canonical Host, TLS SNI,
      // certificate hostname verification, protocol, and port intact.
      this.lookup = (_hostname, options, callback) => lookup(publicEdgeHost, options, callback);
    }
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
    return this.send(publicOrigin, pathname, options, (response, resolve) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const status = response.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, headers: response.headers, body, value: parseBody(body) });
      });
    });
  }

  /**
   * One request whose body is never held in memory: it is counted and hashed
   * as it arrives, and only its first `keepBytes` bytes are kept.
   */
  streamRequest(
    publicOrigin: string,
    pathname: string,
    options: EdgeRequestOptions & { keepBytes: number },
  ): Promise<EdgeStreamedResponse> {
    return this.send(publicOrigin, pathname, options, (response, resolve) => {
      const hash = createHash("sha256");
      const kept: Buffer[] = [];
      let bodyBytes = 0;
      let keptBytes = 0;
      response.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        bodyBytes += chunk.length;
        if (keptBytes < options.keepBytes) {
          const part = chunk.subarray(0, options.keepBytes - keptBytes);
          kept.push(part);
          keptBytes += part.length;
        }
      });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, headers: response.headers, bodyBytes,
          bodySha256: hash.digest("hex"), head: Buffer.concat(kept) });
      });
    });
  }

  private send<T>(
    publicOrigin: string,
    pathname: string,
    options: EdgeRequestOptions,
    read: (response: IncomingMessage, resolve: (value: T) => void) => void,
  ): Promise<T> {
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
          ...(this.lookup ? { lookup: this.lookup } : {}),
        },
        (response) => {
          response.on("error", reject);
          read(response, resolve);
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
      ...(this.lookup ? { lookup: this.lookup } : {}),
      headers: {
        ...headers,
        ...(this.adapterUrl ? { host: resolved.origin.host } : {}),
      },
      perMessageDeflate: false,
    });
  }
}
