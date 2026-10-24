import { randomUUID } from "node:crypto";

/**
 * Names the CLI on every request to the OpenCloud API and gives each request
 * an ID, so a failure the CLI prints can be followed into the platform's
 * logs. The platform echoes a well-formed x-request-id in its answer.
 *
 * It also remembers, for this process only, which API the CLI last called
 * and the bearer token it sent there, so an error report goes to the same
 * API with the same credential and never to another origin.
 */

let cliVersion = "0.0.0";

/** Set once at startup from the CLI's own version. */
export function setCliVersion(version: string): void {
  cliVersion = version;
}

export function getCliVersion(): string {
  return cliVersion;
}

/** The JavaScript runtime, such as `node 22.12.0`, `bun 1.2.0` or `deno 2.1.0`. */
export function runtimeDescription(): string {
  const versions = process.versions as NodeJS.ProcessVersions & {
    bun?: string;
    deno?: string;
  };
  if (versions.bun) return `bun ${versions.bun}`;
  if (versions.deno) return `deno ${versions.deno}`;
  return `node ${process.versions.node}`;
}

/** For example `opencloud-cli/3.16.0 (darwin arm64; node 22.12.0)`. */
export function cliUserAgent(): string {
  return `opencloud-cli/${cliVersion} (${process.platform} ${process.arch}; ${runtimeDescription()})`;
}

export function newRequestId(): string {
  return `cli-${randomUUID()}`;
}

const sentRequestIds = new WeakMap<object, string>();
const credentialsByApi = new Map<string, { origin: string; token: string }>();
let lastApiUrl: string | null = null;

/** The x-request-id the CLI sent with a request that got no HTTP answer. */
export function requestIdForError(error: unknown): string | null {
  return error && typeof error === "object"
    ? (sentRequestIds.get(error) ?? null)
    : null;
}

function apiKey(apiUrl: string): string {
  try {
    return new URL(apiUrl).href.replace(/\/+$/, "");
  } catch {
    return apiUrl.replace(/\/+$/, "");
  }
}

/** The API base URL of the most recent request through an API client. */
export function lastUsedApiUrl(): string | null {
  return lastApiUrl;
}

/**
 * The bearer token this process last sent to apiUrl. A token is returned
 * only for the API and origin it was sent to.
 */
export function usedApiCredential(apiUrl: string): string | null {
  const key = apiKey(apiUrl);
  const used = credentialsByApi.get(key);
  if (!used) return null;
  try {
    return new URL(key).origin === used.origin ? used.token : null;
  } catch {
    return null;
  }
}

/** Test-only: forget the API and credentials this process used. */
export function resetApiUsage(): void {
  credentialsByApi.clear();
  lastApiUrl = null;
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

function noteApiRequest(apiUrl: string, url: string, authorization: string | null): void {
  lastApiUrl = apiUrl;
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
  if (!token) return;
  try {
    const origin = new URL(url).origin;
    if (origin === new URL(apiUrl).origin) {
      credentialsByApi.set(apiUrl, { origin, token });
    }
  } catch {
    // A request the API URL cannot describe is never remembered.
  }
}

/**
 * An error answer without x-request-id, typically from a proxy, carries the
 * ID the CLI sent, so the CLI's error output can still quote it.
 */
function withRequestId(response: Response, requestId: string): Response {
  if (response.status < 400 || response.status > 599 || response.headers.has("x-request-id")) {
    return response;
  }
  try {
    const headers = new Headers(response.headers);
    headers.set("x-request-id", requestId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

export interface CliFetchOptions {
  /** The API base URL the requests belong to, for error-report attribution. */
  apiUrl?: string | undefined;
}

/**
 * Wraps a fetch so each request carries the CLI's user-agent and an
 * x-request-id, unless the caller already set them. `base` defaults to the
 * global fetch at call time.
 */
export function withCliHeaders(
  base?: typeof fetch,
  options: CliFetchOptions = {},
): typeof fetch {
  const apiUrl = options.apiUrl ? apiKey(options.apiUrl) : null;
  const wrapped = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const headers = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (!headers.has("user-agent")) headers.set("user-agent", cliUserAgent());
    if (!headers.has("x-request-id")) headers.set("x-request-id", newRequestId());
    const requestId = headers.get("x-request-id") ?? "";
    if (apiUrl) noteApiRequest(apiUrl, requestUrl(input), headers.get("authorization"));
    let response: Response;
    try {
      response = await (base ?? globalThis.fetch)(input, { ...init, headers });
    } catch (error) {
      if (error && typeof error === "object" && requestId) {
        sentRequestIds.set(error, requestId);
      }
      throw error;
    }
    return withRequestId(response, requestId);
  };
  return wrapped as typeof fetch;
}
