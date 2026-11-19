import { createHash } from "node:crypto";
import { z } from "zod";
import { EdgeTransport } from "./edge-transport.js";
import { callerFailure } from "./caller-failure.js";

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
/** The most of a response body `--show-body` prints. */
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
 * One request to the app's canonical origin, sent once and never retried.
 * Without a credential it is signed out. With an app access token, the edge
 * acts as the app's owner on runtime routes, as for any program the owner
 * gave the token; the token goes only to that origin over HTTPS (or to a
 * loopback test edge) and appears in no output.
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
  if (options.accessToken) {
    const destination = new URL(options.edgeUrl ?? app.appUrl);
    if (destination.protocol !== "https:" && !LOOPBACK.has(destination.hostname)) {
      throw callerFailure(new Error("An app access token is sent only over HTTPS; no request was sent"));
    }
  }
  const transport = options.transport ?? new EdgeTransport(options.edgeUrl, options.publicEdgeHost);
  const response = await transport.request(
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
    },
  );
  // The edge never forwards the token; an app that echoed one still prints none.
  const shown = (text: string) => (options.accessToken ? text.split(options.accessToken).join("[REDACTED]") : text);
  return {
    appId: app.id,
    url: target.href,
    method,
    credential: options.accessToken ? "app_access_token" : null,
    ok: response.ok,
    status: response.status,
    contentType: firstHeader(response.headers["content-type"]),
    bodyBytes: Buffer.byteLength(response.body),
    bodySha256: createHash("sha256").update(response.body).digest("hex"),
    ...(options.showBody
      ? { body: shown(response.body.slice(0, APP_REQUEST_BODY_SHOWN)), bodyTruncated: response.body.length > APP_REQUEST_BODY_SHOWN }
      : {}),
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
