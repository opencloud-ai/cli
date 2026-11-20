import { z } from "zod";
import { EdgeTransport } from "./edge-transport.js";
import { callerFailure } from "./caller-failure.js";
import { CliContractError } from "./cli-contract-error.js";

const appEdgeRecordSchema = z.object({
  id: z.uuid(),
  visibility: z.enum(["public", "private"]),
  state: z.string(),
  activeDeploymentId: z.uuid().nullable(),
  appUrl: z.url(),
  authUrl: z.url(),
});

type AppEdgeRecord = z.infer<typeof appEdgeRecordSchema>;

export const APP_REQUEST_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type AppRequestMethod = (typeof APP_REQUEST_METHODS)[number];
/** The most of a response body `--show-body` prints, in bytes; the rest is only counted and hashed. */
export const APP_REQUEST_BODY_SHOWN = 64 * 1024;

export interface AppRequestSummary {
  appId: string;
  url: string;
  method: AppRequestMethod;
  /** The credential sent: an app access token, or none (signed out). */
  credential: "app_access_token" | null;
  ok: boolean;
  status: number;
  contentType: string | null;
  bodyBytes: number;
  bodySha256: string;
  /** Only when asked for: the start of the body, as text. */
  body?: string;
  bodyTruncated?: boolean;
}

export interface AppSmokeSummary {
  passed: boolean;
  appId: string;
  appUrl: string;
  visibility: "public" | "private";
  checks: Array<{
    name: string;
    passed: boolean;
    status?: number;
    detail: string;
  }>;
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function appTarget(app: AppEdgeRecord, requestPath: string): URL {
  const origin = new URL(app.appUrl);
  const target = new URL(requestPath, origin);
  if (target.origin !== origin.origin) {
    throw callerFailure(new Error(
      "App request path must stay within the canonical app origin",
    ));
  }
  target.hash = "";
  return target;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Where an app access token may go: only to the app's own address, over
 * HTTPS (plain HTTP only when that address is this machine, as in a local
 * test). OPENCLOUD_EDGE_URL sends the request to another host, so it is
 * refused with a token. OPENCLOUD_PUBLIC_EDGE_HOST only changes the address
 * the app's hostname resolves to; TLS still proves the app's own host.
 */
function assertTokenDestination(app: AppEdgeRecord, options: { edgeUrl?: string; publicEdgeHost?: string }): void {
  const origin = new URL(app.appUrl);
  const reason = options.edgeUrl !== undefined
    ? "OPENCLOUD_EDGE_URL sends the request to another host"
    : origin.protocol !== "https:" && (!LOOPBACK.has(origin.hostname) || options.publicEdgeHost !== undefined)
      ? "the app's address does not use HTTPS"
      : null;
  if (reason) {
    throw callerFailure(new CliContractError("ACCESS_TOKEN_DESTINATION_REFUSED",
      `An app access token is sent only to the app's own address over HTTPS, and ${reason}; no request was sent.`));
  }
}

/**
 * The start of a body as text, cut at a whole UTF-8 character. With a token,
 * every copy of it is redacted, and so is a start of it the cut left at the end.
 */
function shownText(head: Buffer, truncated: boolean, accessToken: string | undefined): string {
  let text = new TextDecoder().decode(head, { stream: truncated });
  if (!accessToken) return text;
  text = text.split(accessToken).join("[REDACTED]");
  if (truncated) {
    for (let length = accessToken.length - 1; length >= 4; length -= 1) {
      if (text.endsWith(accessToken.slice(0, length))) return `${text.slice(0, -length)}[REDACTED]`;
    }
  }
  return text;
}

/**
 * One request to the app's canonical origin, sent once and never retried.
 * Without a credential it is signed out. With an app access token, the edge
 * acts as the app's owner on runtime routes, as for any program the owner
 * gave the token; the token goes only to that origin over HTTPS (see
 * assertTokenDestination) and appears in no output. The response is read as
 * it arrives: counted and hashed, and only its first 64 KiB kept for
 * `showBody`, so a large one never fills memory.
 */
export async function requestApp(
  rawApp: unknown,
  requestPath = "/",
  options: {
    edgeUrl?: string;
    publicEdgeHost?: string;
    method?: AppRequestMethod;
    body?: { content: Buffer; contentType: string };
    accessToken?: string;
    showBody?: boolean;
    timeoutMs?: number;
    transport?: EdgeTransport;
  } = {},
): Promise<AppRequestSummary> {
  const app = appEdgeRecordSchema.parse(rawApp);
  const target = appTarget(app, requestPath);
  const method = options.method ?? "GET";
  if (options.accessToken) assertTokenDestination(app, options);
  const transport = options.transport ?? new EdgeTransport(options.edgeUrl, options.publicEdgeHost);
  const response = await transport.streamRequest(
    app.appUrl,
    `${target.pathname}${target.search}`,
    {
      method,
      headers: {
        ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
        ...(options.body ? { "content-type": options.body.contentType, "content-length": String(options.body.content.length) } : {}),
      },
      ...(options.body ? { body: options.body.content } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      keepBytes: options.showBody ? APP_REQUEST_BODY_SHOWN : 0,
    },
  );
  const truncated = response.bodyBytes > APP_REQUEST_BODY_SHOWN;
  return {
    appId: app.id,
    url: target.href,
    method,
    credential: options.accessToken ? "app_access_token" : null,
    ok: response.ok,
    status: response.status,
    contentType: firstHeader(response.headers["content-type"]),
    bodyBytes: response.bodyBytes,
    bodySha256: response.bodySha256,
    // The edge never forwards the token; an app that echoed one still prints none.
    ...(options.showBody ? { body: shownText(response.head, truncated, options.accessToken), bodyTruncated: truncated } : {}),
  };
}

export async function smokeApp(
  rawApp: unknown,
  options: {
    edgeUrl?: string;
    publicEdgeHost?: string;
    transport?: EdgeTransport;
  } = {},
): Promise<AppSmokeSummary> {
  const app = appEdgeRecordSchema.parse(rawApp);
  const checks: AppSmokeSummary["checks"] = [];
  checks.push({
    name: "active deployment",
    passed: app.state === "active" && app.activeDeploymentId !== null,
    detail:
      app.state === "active" && app.activeDeploymentId !== null
        ? "The control plane reports an active deployment."
        : "The app does not have an active deployment.",
  });

  const transport = options.transport ?? new EdgeTransport(options.edgeUrl, options.publicEdgeHost);
  const response = await transport.request(app.appUrl, "/");
  if (app.visibility === "public") {
    checks.push({
      name: "public root",
      passed: response.ok,
      status: response.status,
      detail: response.ok
        ? "The canonical public root returned a successful response."
        : "The canonical public root did not return a successful response.",
    });
  } else {
    const location = firstHeader(response.headers.location);
    let canonicalAuthRedirect = false;
    if (location) {
      try {
        canonicalAuthRedirect =
          new URL(location, app.appUrl).origin === new URL(app.authUrl).origin;
      } catch {
        canonicalAuthRedirect = false;
      }
    }
    const passed = response.status === 302 && canonicalAuthRedirect;
    checks.push({
      name: "private root",
      passed,
      status: response.status,
      detail: passed
        ? "Anonymous access redirected to the canonical auth origin."
        : "Anonymous access did not redirect to the canonical auth origin.",
    });
  }

  return {
    passed: checks.every((check) => check.passed),
    appId: app.id,
    appUrl: app.appUrl,
    visibility: app.visibility,
    checks,
  };
}
