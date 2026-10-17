import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * A fetch for the control-plane client that lets a JSON request wait as long
 * as its own signal allows. Global fetch abandons any response whose headers
 * take longer than 300 seconds, whatever the request's timeout, but a
 * validation that builds the frontend or a development verification can wait
 * longer. JSON POSTs therefore go through node:http(s); everything else, such
 * as downloads and multipart uploads, keeps using global fetch.
 *
 * Failures keep fetch's shape: an aborted request rejects with the signal's
 * reason, and a network failure with TypeError("fetch failed").
 */
export async function slowResponseFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body;
  if (method !== "POST" || typeof body !== "string" || input instanceof Request) {
    return fetch(input, init);
  }
  const url = new URL(String(input));
  const send =
    url.protocol === "https:" ? httpsRequest : url.protocol === "http:" ? httpRequest : null;
  if (!send) return fetch(input, init);
  const signal = init.signal ?? undefined;
  signal?.throwIfAborted();
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  headers["content-length"] = String(Buffer.byteLength(body));
  return new Promise<Response>((resolve, reject) => {
    const fail = (error: unknown) =>
      reject(signal?.aborted ? signal.reason : new TypeError("fetch failed", { cause: error }));
    const request = send(url, { method, headers, ...(signal ? { signal } : {}) }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", fail);
      // A connection that drops mid-body may close without an error event.
      response.once("close", () => {
        if (!response.complete) fail(new Error("The connection closed before the response was complete"));
      });
      response.once("end", () => {
        if (!response.complete) {
          fail(new Error("The response ended before it was complete"));
          return;
        }
        const status = response.statusCode ?? 502;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
            responseHeaders.append(name, item);
          }
        }
        const empty = [101, 204, 205, 304].includes(status);
        resolve(new Response(empty ? null : Buffer.concat(chunks), {
          status,
          statusText: response.statusMessage ?? "",
          headers: responseHeaders,
        }));
      });
    });
    request.once("error", fail);
    request.end(body);
  });
}
