import { createHash } from "node:crypto";
import { z } from "zod";
import { EdgeTransport } from "./edge-transport.js";

const appEdgeRecordSchema = z.object({
  id: z.uuid(),
  visibility: z.enum(["public", "private"]),
  state: z.string(),
  activeDeploymentId: z.uuid().nullable(),
  appUrl: z.url(),
  authUrl: z.url(),
});

type AppEdgeRecord = z.infer<typeof appEdgeRecordSchema>;

export interface AppRequestSummary {
  appId: string;
  url: string;
  method: "GET" | "HEAD";
  ok: boolean;
  status: number;
  contentType: string | null;
  bodyBytes: number;
  bodySha256: string;
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
    throw new Error(
      "App request path must stay within the canonical app origin",
    );
  }
  target.hash = "";
  return target;
}

export async function requestApp(
  rawApp: unknown,
  requestPath = "/",
  options: {
    edgeUrl?: string;
    method?: "GET" | "HEAD";
    transport?: EdgeTransport;
  } = {},
): Promise<AppRequestSummary> {
  const app = appEdgeRecordSchema.parse(rawApp);
  const target = appTarget(app, requestPath);
  const method = options.method ?? "GET";
  const transport = options.transport ?? new EdgeTransport(options.edgeUrl);
  const response = await transport.request(
    app.appUrl,
    `${target.pathname}${target.search}`,
    { method },
  );
  return {
    appId: app.id,
    url: target.href,
    method,
    ok: response.ok,
    status: response.status,
    contentType: firstHeader(response.headers["content-type"]),
    bodyBytes: Buffer.byteLength(response.body),
    bodySha256: createHash("sha256").update(response.body).digest("hex"),
  };
}

export async function smokeApp(
  rawApp: unknown,
  options: {
    edgeUrl?: string;
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

  const transport = options.transport ?? new EdgeTransport(options.edgeUrl);
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
