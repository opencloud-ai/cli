/**
 * OpenCloud's same-origin browser SDK.
 *
 * Applications import the deployment-pinned singleton from
 * `/_opencloud/sdk.js`. Runtime credentials, buckets, protocol paths and raw
 * HTTP responses deliberately stay behind this module.
 */

export const OPEN_CLOUD_SDK_VERSION = "1.0.0";

export type OpenCloudEnvironment = "dev" | "production";
export type OpenCloudVisibility = "public" | "private";
export type OpenCloudErrorSurface =
  | "app"
  | "auth"
  | "data"
  | "files"
  | "functions"
  | "realtime"
  | "telemetry";

export interface OpenCloudErrorOptions {
  code: string;
  surface: OpenCloudErrorSurface;
  status?: number | null;
  requestId?: string | null;
  retryable?: boolean;
  details?: unknown;
  cause?: unknown;
}

/** A bounded, structured failure from an OpenCloud capability. */
export class OpenCloudError extends Error {
  readonly code: string;
  readonly surface: OpenCloudErrorSurface;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly details?: unknown;
  override readonly cause?: unknown;

  constructor(message: string, options: OpenCloudErrorOptions) {
    super(message);
    this.name = "OpenCloudError";
    this.code = options.code;
    this.surface = options.surface;
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function isOpenCloudError(value: unknown): value is OpenCloudError {
  return value instanceof OpenCloudError;
}

export interface OpenCloudUser {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface OpenCloudCapabilities {
  auth: boolean;
  data: boolean;
  files: boolean;
  functions: boolean;
  realtime: boolean;
  telemetry: boolean;
}

export interface OpenCloudAppInfo {
  id: string;
  version: string | null;
  environment: OpenCloudEnvironment;
  visibility: OpenCloudVisibility;
  capabilities: OpenCloudCapabilities;
}

export type OpenCloudScalar = string | number | boolean | null;

export interface OpenCloudListOptions {
  select?: string[];
  where?: Record<string, OpenCloudScalar>;
  orderBy?: {
    column: string;
    direction?: "asc" | "desc";
  };
  limit?: number;
  offset?: number;
}

export interface OpenCloudGetOptions {
  select?: string[];
}

export interface OpenCloudFile {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

export interface OpenCloudFileUploadOptions {
  name?: string;
  contentType?: string;
  maxBytes?: number;
  onProgress?: (progress: OpenCloudFileUploadProgress) => void;
}

export interface OpenCloudFileUploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export interface OpenCloudFileDownload {
  blob: Blob;
  name: string;
  contentType: string;
  size: number;
}

export interface OpenCloudFileAttachmentColumns {
  id?: string;
  name?: string;
  contentType?: string;
  size?: string;
}

export interface OpenCloudFileAttachmentOptions {
  table: string;
  values?: Record<string, unknown>;
  columns?: OpenCloudFileAttachmentColumns;
  upload?: OpenCloudFileUploadOptions;
}

export interface OpenCloudRealtimeMessage {
  event: string;
  payload: unknown;
}

export type OpenCloudTelemetrySurface =
  | "page"
  | "rest"
  | "storage"
  | "realtime"
  | "function"
  | "cron";

export interface OpenCloudTelemetrySurfaceActivity {
  lastActivityAt: string | null;
  requests24h: number;
  errors24h: number;
  lastStatus: number | null;
}

export interface OpenCloudTelemetryRollup {
  windowStart: string;
  windowEnd: string;
  calculationVersion: string;
  completeness: "complete" | "partial" | "corrected";
  metrics: Record<string, unknown>;
  createdAt: string;
}

export interface OpenCloudTelemetryActivity {
  window: { from: string; to: string; seconds: number };
  telemetry: {
    status: "available" | "unavailable";
    latestIngestedAt: string | null;
    ingestionLagSeconds: number | null;
    sampledEntries: number;
    truncated: boolean;
  };
  surfaces: Record<
    OpenCloudTelemetrySurface,
    OpenCloudTelemetrySurfaceActivity
  >;
}

export interface OpenCloudTelemetrySummary {
  appId: string;
  asOf: string;
  usage: OpenCloudTelemetryRollup | null;
  activity: OpenCloudTelemetryActivity;
}

export type OpenCloudMetricDimensions = Record<string, string>;

export interface OpenCloudMetricWriteOptions {
  dimensions?: OpenCloudMetricDimensions;
  idempotencyKey?: string;
}

export interface OpenCloudMetricWriteResult {
  accepted: number;
  duplicates: number;
  recordedAt: string;
}

export interface OpenCloudAppClient {
  info(): Promise<OpenCloudAppInfo>;
}

export interface OpenCloudAuthClient {
  currentUser(): Promise<OpenCloudUser | null>;
  requireUser(): Promise<OpenCloudUser>;
  /** A safe same-origin URL that signs in and returns to the current page. */
  signInUrl(): string;
}

export interface OpenCloudDataTable<Row> {
  list(options?: OpenCloudListOptions): Promise<Row[]>;
  getById(id: string, options?: OpenCloudGetOptions): Promise<Row | null>;
  create(values: Record<string, unknown>): Promise<Row>;
  createMany(values: Record<string, unknown>[]): Promise<Row[]>;
  updateById(id: string, patch: Record<string, unknown>): Promise<Row | null>;
  deleteById(id: string): Promise<boolean>;
}

export interface OpenCloudDataClient {
  table<Row = Record<string, unknown>>(name: string): OpenCloudDataTable<Row>;
}

export interface OpenCloudFilesClient {
  upload(
    source: Blob,
    options?: OpenCloudFileUploadOptions,
  ): Promise<OpenCloudFile>;
  download(value: OpenCloudFile | string): Promise<OpenCloudFileDownload>;
  save(value: OpenCloudFile | string): Promise<void>;
  replace(
    value: OpenCloudFile | string,
    source: Blob,
    options?: OpenCloudFileUploadOptions,
  ): Promise<OpenCloudFile>;
  remove(value: OpenCloudFile | string): Promise<void>;
  attach<Row = Record<string, unknown>>(
    source: Blob,
    options: OpenCloudFileAttachmentOptions,
  ): Promise<{ file: OpenCloudFile; record: Row }>;
}

export interface OpenCloudFunctionsClient {
  call<Input = undefined, Output = unknown>(
    name: string,
    input?: Input,
  ): Promise<Output>;
  stream<Input = undefined>(
    name: string,
    input?: Input,
  ): Promise<ReadableStream<Uint8Array>>;
}

export interface OpenCloudRealtimeClient {
  subscribe(
    topic: string,
    handler: (message: OpenCloudRealtimeMessage) => void,
  ): Promise<() => void>;
  publish(topic: string, event: string, payload: unknown): Promise<void>;
}

export interface OpenCloudTelemetryClient {
  summary(): Promise<OpenCloudTelemetrySummary>;
  increment(
    name: string,
    value?: number,
    options?: OpenCloudMetricWriteOptions,
  ): Promise<OpenCloudMetricWriteResult>;
  gauge(
    name: string,
    value: number,
    options?: OpenCloudMetricWriteOptions,
  ): Promise<OpenCloudMetricWriteResult>;
}

export interface OpenCloudClient {
  readonly app: OpenCloudAppClient;
  readonly auth: OpenCloudAuthClient;
  readonly data: OpenCloudDataClient;
  readonly files: OpenCloudFilesClient;
  readonly functions: OpenCloudFunctionsClient;
  readonly realtime: OpenCloudRealtimeClient;
  readonly telemetry: OpenCloudTelemetryClient;
  dispose(): void;
}

type AuthMode = "user" | "public" | "optional";

interface SdkConfig {
  package: "@opencloud/js";
  version: string;
  module: string;
  types: string;
  docs: string;
}

interface RuntimeFunction {
  name: string;
  access: "user" | "public" | "system";
}

interface RuntimeConfig {
  appId: string;
  deploymentVersion: string | null;
  visibility: OpenCloudVisibility;
  environment: OpenCloudEnvironment;
  runtimeOrigin: string;
  sdk: SdkConfig;
  capabilities: OpenCloudCapabilities;
  files: { access: "app" | "user"; maxUploadBytes: number } | null;
  functions: RuntimeFunction[];
}

interface WireSession {
  appId: string;
  userId: string;
  profile: {
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  };
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshAfter: string;
  sessionExpiresAt: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const FUNCTION_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const REALTIME_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const EVENT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(`Invalid OpenCloud response field: ${field}`, "app");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw invalidResponse(`Invalid OpenCloud response field: ${field}`, "app");
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : string(value, field, true);
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidResponse(`Invalid OpenCloud response field: ${field}`, "app");
  }
  return value;
}

function integer(value: unknown, field: string): number {
  const parsed = number(value, field);
  if (!Number.isInteger(parsed)) {
    throw invalidResponse(`Invalid OpenCloud response field: ${field}`, "app");
  }
  return parsed;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidResponse(`Invalid OpenCloud response field: ${field}`, "app");
  }
  return value;
}

function iso(value: unknown, field: string): string {
  const parsed = string(value, field);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw invalidResponse(`Invalid OpenCloud response field: ${field}`, "app");
  }
  return parsed;
}

function invalidResponse(
  message: string,
  surface: OpenCloudErrorSurface,
  cause?: unknown,
): OpenCloudError {
  return new OpenCloudError(message, {
    code: "INVALID_RESPONSE",
    surface,
    ...(cause === undefined ? {} : { cause }),
  });
}

function invalidArgument(
  message: string,
  surface: OpenCloudErrorSurface,
): OpenCloudError {
  return new OpenCloudError(message, { code: "INVALID_ARGUMENT", surface });
}

function capabilityUnavailable(
  capability: keyof OpenCloudCapabilities,
  surface: OpenCloudErrorSurface,
): OpenCloudError {
  return new OpenCloudError(
    `OpenCloud ${capability} is unavailable in this environment`,
    { code: "CAPABILITY_UNAVAILABLE", surface },
  );
}

function assertIdentifier(value: string, field: string): string {
  if (!IDENTIFIER.test(value)) {
    throw invalidArgument(`${field} must be a lowercase SQL identifier`, "data");
  }
  return value;
}

function assertFunctionName(value: string): string {
  if (!FUNCTION_NAME.test(value)) {
    throw invalidArgument("OpenCloud Function name is invalid", "functions");
  }
  return value;
}

function normalizedOrigin(explicit?: string): string {
  const source =
    explicit ??
    (typeof globalThis.location === "object"
      ? globalThis.location.origin
      : undefined);
  if (!source) {
    throw invalidArgument(
      "OpenCloud requires a browser origin",
      "app",
    );
  }
  const parsed = new URL(source);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw invalidArgument("OpenCloud origin must not contain a path", "app");
  }
  return parsed.origin;
}

function currentLocationPath(): string {
  if (typeof globalThis.location !== "object") return "/";
  const pathname =
    typeof globalThis.location.pathname === "string" &&
    globalThis.location.pathname.startsWith("/") &&
    !globalThis.location.pathname.startsWith("//")
      ? globalThis.location.pathname
      : "/";
  const search =
    typeof globalThis.location.search === "string" &&
    (globalThis.location.search === "" || globalThis.location.search.startsWith("?"))
      ? globalThis.location.search
      : "";
  const hash =
    typeof globalThis.location.hash === "string" &&
    (globalThis.location.hash === "" || globalThis.location.hash.startsWith("#"))
      ? globalThis.location.hash
      : "";
  return `${pathname}${search}${hash}`;
}

function sameOriginPath(basePath: string, relativePath: string): string {
  const cleanBase = basePath.replace(/\/+$/, "");
  const cleanRelative = relativePath.replace(/^\/+/, "");
  if (
    !cleanRelative ||
    cleanRelative.includes("\\") ||
    cleanRelative.split("/").some((segment) => {
      try {
        const decoded = decodeURIComponent(segment);
        return decoded === "." || decoded === "..";
      } catch {
        return true;
      }
    })
  ) {
    throw invalidArgument("OpenCloud runtime path is invalid", "app");
  }
  return `${cleanBase}/${cleanRelative}`;
}

function exactFields(
  source: Record<string, unknown>,
  fields: readonly string[],
  scope: string,
): void {
  const allowed = new Set(fields);
  for (const field of Object.keys(source)) {
    if (!allowed.has(field)) {
      throw invalidResponse(
        `Invalid OpenCloud response field: ${scope}.${field}`,
        "app",
      );
    }
  }
}

function parseRuntimeConfig(value: unknown, expectedOrigin: string): RuntimeConfig {
  const input = object(value, "config");
  exactFields(
    input,
    [
      "appId",
      "deploymentVersion",
      "visibility",
      "environment",
      "sdk",
      "capabilities",
      "files",
      "functions",
      "devSessionId",
      "devRevisionId",
    ],
    "config",
  );
  const appId = string(input.appId, "appId");
  const visibility = input.visibility;
  if (visibility !== "public" && visibility !== "private") {
    throw invalidResponse("Invalid OpenCloud response field: visibility", "app");
  }
  const environment = string(input.environment, "environment");
  if (environment !== "dev" && environment !== "production") {
    throw invalidResponse("Invalid OpenCloud response field: environment", "app");
  }
  const rawSdk = object(input.sdk, "sdk");
  exactFields(rawSdk, ["package", "version", "module", "types", "docs"], "sdk");
  const sdk: SdkConfig = {
    package: string(rawSdk.package, "sdk.package") as "@opencloud/js",
    version: string(rawSdk.version, "sdk.version"),
    module: string(rawSdk.module, "sdk.module"),
    types: string(rawSdk.types, "sdk.types"),
    docs: string(rawSdk.docs, "sdk.docs"),
  };
  if (
    sdk.package !== "@opencloud/js" ||
    sdk.version !== OPEN_CLOUD_SDK_VERSION
  ) {
    throw invalidResponse(
      "OpenCloud runtime and JavaScript SDK versions do not match",
      "app",
    );
  }
  if (sdk.module !== "/_opencloud/sdk.js") {
    throw invalidResponse("Invalid OpenCloud response field: sdk.module", "app");
  }
  if (sdk.types !== "/_opencloud/sdk.d.ts") {
    throw invalidResponse("Invalid OpenCloud response field: sdk.types", "app");
  }
  try {
    if (new URL(sdk.docs).protocol !== "https:") throw new Error();
  } catch {
    throw invalidResponse(
      "OpenCloud SDK documentation must use HTTPS",
      "app",
    );
  }

  const rawCapabilities = object(input.capabilities, "capabilities");
  exactFields(
    rawCapabilities,
    ["auth", "data", "files", "functions", "realtime", "telemetry"],
    "capabilities",
  );
  const capabilities: OpenCloudCapabilities = {
    auth: bool(rawCapabilities.auth, "capabilities.auth"),
    data: bool(rawCapabilities.data, "capabilities.data"),
    files: bool(rawCapabilities.files, "capabilities.files"),
    functions: bool(rawCapabilities.functions, "capabilities.functions"),
    realtime: bool(rawCapabilities.realtime, "capabilities.realtime"),
    telemetry: bool(rawCapabilities.telemetry, "capabilities.telemetry"),
  };

  let files: RuntimeConfig["files"] = null;
  if (capabilities.files) {
    const rawFiles = object(input.files, "files");
    exactFields(rawFiles, ["access", "maxUploadBytes"], "files");
    const access = rawFiles.access;
    if (access !== "app" && access !== "user") {
      throw invalidResponse("Invalid OpenCloud response field: files.access", "app");
    }
    const maxUploadBytes = integer(rawFiles.maxUploadBytes, "files.maxUploadBytes");
    if (maxUploadBytes < 1) {
      throw invalidResponse(
        "Invalid OpenCloud response field: files.maxUploadBytes",
        "app",
      );
    }
    files = { access, maxUploadBytes };
  } else if (input.files !== undefined) {
    throw invalidResponse(
      "OpenCloud config declared Files settings without the Files capability",
      "app",
    );
  }

  if (!Array.isArray(input.functions)) {
    throw invalidResponse("Invalid OpenCloud response field: functions", "app");
  }
  const functions: RuntimeFunction[] = input.functions.map((entry, index) => {
    const raw = object(entry, `functions[${index}]`);
    exactFields(raw, ["name", "access"], `functions[${index}]`);
    const name = assertFunctionName(string(raw.name, `functions[${index}].name`));
    const access = raw.access;
    if (access !== "user" && access !== "public" && access !== "system") {
      throw invalidResponse(
        `Invalid OpenCloud response field: functions[${index}].access`,
        "app",
      );
    }
    return { name, access };
  });

  return {
    appId,
    deploymentVersion:
      input.deploymentVersion === null
        ? null
        : string(input.deploymentVersion, "deploymentVersion"),
    visibility,
    environment,
    runtimeOrigin: expectedOrigin,
    sdk,
    capabilities,
    files,
    functions,
  };
}

function parseWireSession(value: unknown): WireSession | null {
  const envelope = object(value, "session envelope");
  if (envelope.session === null) return null;
  const input = object(envelope.session, "session");
  const profile = object(input.profile, "profile");
  return {
    appId: string(input.appId, "appId"),
    userId: string(input.userId, "userId"),
    profile: {
      email: nullableString(profile.email, "profile.email"),
      displayName: nullableString(profile.displayName, "profile.displayName"),
      avatarUrl: nullableString(profile.avatarUrl, "profile.avatarUrl"),
    },
    accessToken: string(input.accessToken, "accessToken"),
    accessTokenExpiresAt: iso(input.accessTokenExpiresAt, "accessTokenExpiresAt"),
    refreshAfter: iso(input.refreshAfter, "refreshAfter"),
    sessionExpiresAt: iso(input.sessionExpiresAt, "sessionExpiresAt"),
  };
}

function publicUser(session: WireSession): OpenCloudUser {
  return {
    id: session.userId,
    email: session.profile.email,
    displayName: session.profile.displayName,
    avatarUrl: session.profile.avatarUrl,
  };
}

function statusCode(status: number): string {
  if (status === 400 || status === 422) return "INVALID_ARGUMENT";
  if (status === 401) return "AUTH_REQUIRED";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  return status >= 500 ? "PLATFORM_ERROR" : "REQUEST_FAILED";
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

function bounded(value: string, maximum = 500): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maximum ? `${compact.slice(0, maximum - 1)}…` : compact;
}

function responseMessage(parsed: unknown, fallback: string): string {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const value = parsed as Record<string, unknown>;
    if (typeof value.message === "string") return bounded(value.message);
    if (typeof value.error === "string") return bounded(value.error);
    if (value.error && typeof value.error === "object") {
      const nested = value.error as Record<string, unknown>;
      if (typeof nested.message === "string") return bounded(nested.message);
    }
  }
  if (typeof parsed === "string" && parsed.trim()) return bounded(parsed);
  return fallback;
}

async function responseError(
  response: Response,
  surface: OpenCloudErrorSurface,
): Promise<OpenCloudError> {
  let source = "";
  try {
    source = await response.text();
  } catch {
    source = "";
  }
  let parsed: unknown = source;
  if (source) {
    try {
      parsed = JSON.parse(source);
    } catch {
      parsed = source;
    }
  }
  const requestId =
    response.headers.get("x-request-id") ??
    response.headers.get("x-opencloud-request-id");
  const parsedObject =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  const platformCode =
    typeof parsedObject?.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,79}$/.test(parsedObject.code)
      ? parsedObject.code
      : undefined;
  const rawDetails =
    parsedObject?.details &&
    typeof parsedObject.details === "object" &&
    !Array.isArray(parsedObject.details)
      ? (parsedObject.details as Record<string, unknown>)
      : undefined;
  return new OpenCloudError(
    responseMessage(parsed, `OpenCloud ${surface} returned HTTP ${response.status}`),
    {
      code: platformCode ?? statusCode(response.status),
      surface,
      status: response.status,
      requestId,
      retryable:
        retryableStatus(response.status) || rawDetails?.retryable === true,
      ...(parsed && typeof parsed === "object" ? { details: parsed } : {}),
    },
  );
}

async function requireOk(
  response: Response,
  surface: OpenCloudErrorSurface,
): Promise<Response> {
  if (!response.ok) throw await responseError(response, surface);
  return response;
}

async function parsedBody(
  response: Response,
  surface: OpenCloudErrorSurface,
): Promise<unknown> {
  if (response.status === 204) return undefined;
  const source = await response.text();
  if (!source) return undefined;
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) return source;
  try {
    return JSON.parse(source) as unknown;
  } catch (cause) {
    throw invalidResponse(`OpenCloud ${surface} returned invalid JSON`, surface, cause);
  }
}

class RuntimeCore {
  private configValue: RuntimeConfig | undefined;
  private configPromise: Promise<RuntimeConfig> | undefined;
  private sessionValue: WireSession | null | undefined;
  private sessionPromise: Promise<WireSession | null> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  async config(): Promise<RuntimeConfig> {
    if (this.configValue) return this.configValue;
    if (!this.configPromise) {
      const origin = normalizedOrigin();
      this.configPromise = this.fetch(new URL("/_opencloud/config", origin), {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      }, "app")
        .then((response) => requireOk(response, "app"))
        .then((response) => response.json())
        .then((value) => {
          const config = parseRuntimeConfig(value, origin);
          this.configValue = config;
          return config;
        })
        .finally(() => {
          this.configPromise = undefined;
        });
    }
    return this.configPromise;
  }

  async user(refresh = false): Promise<OpenCloudUser | null> {
    const session = await this.session(refresh);
    return session ? publicUser(session) : null;
  }

  async requireUser(): Promise<OpenCloudUser> {
    const session = await this.session(false);
    if (!session) {
      throw new OpenCloudError("An OpenCloud user session is required", {
        code: "AUTH_REQUIRED",
        surface: "auth",
        status: 401,
      });
    }
    return publicUser(session);
  }

  async session(forceRefresh: boolean): Promise<WireSession | null> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.sessionValue &&
      now < Date.parse(this.sessionValue.refreshAfter)
    ) {
      return this.sessionValue;
    }
    if (!forceRefresh && this.sessionValue === null) return null;
    if (!this.sessionPromise) {
      const origin = normalizedOrigin();
      this.sessionPromise = this.fetch(
        new URL("/_opencloud/session", origin),
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        },
        "auth",
      )
        .then(async (response) => {
          if (response.status === 401) return null;
          await requireOk(response, "auth");
          return parseWireSession(await response.json());
        })
        .then(async (session) => {
          if (session) {
            const config = await this.config();
            if (session.appId !== config.appId) {
              throw invalidResponse(
                "OpenCloud session belongs to a different app",
                "auth",
              );
            }
          }
          this.sessionValue = session;
          this.scheduleRefresh(session);
          return session;
        })
        .finally(() => {
          this.sessionPromise = undefined;
        });
    }
    return this.sessionPromise;
  }

  async request(
    path: string,
    init: RequestInit,
    auth: AuthMode,
    surface: OpenCloudErrorSurface,
  ): Promise<Response> {
    const config = await this.config();
    const target = new URL(path, normalizedOrigin());
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      target.origin !== config.runtimeOrigin
    ) {
      throw invalidArgument(
        "OpenCloud runtime requests must remain same-origin",
        surface,
      );
    }
    const headers = new Headers(init.headers);
    headers.delete("apikey");
    if (auth === "public") {
      headers.delete("authorization");
    } else {
      const session = await this.session(false);
      if (!session && auth === "user") {
        throw new OpenCloudError("An OpenCloud user session is required", {
          code: "AUTH_REQUIRED",
          surface,
          status: 401,
        });
      }
      if (session?.accessToken) {
        headers.set("authorization", `Bearer ${session.accessToken}`);
      } else {
        headers.delete("authorization");
      }
    }
    return this.fetch(
      target,
      { ...init, credentials: "same-origin", headers },
      surface,
    );
  }

  async hostRequest(
    path: string,
    init: RequestInit,
    surface: OpenCloudErrorSurface,
  ): Promise<Response> {
    const target = new URL(path, normalizedOrigin());
    return this.fetch(
      target,
      { ...init, credentials: "same-origin" },
      surface,
    );
  }

  async hostUpload(
    path: string,
    method: "POST" | "PUT",
    source: Blob,
    headers: HeadersInit,
    surface: OpenCloudErrorSurface,
    onProgress?: (progress: OpenCloudFileUploadProgress) => void,
  ): Promise<Response> {
    if (!onProgress || typeof globalThis.XMLHttpRequest !== "function") {
      onProgress?.({ loaded: 0, total: source.size, percent: 0 });
      const response = await this.hostRequest(
        path,
        { method, headers, body: source },
        surface,
      );
      onProgress?.({ loaded: source.size, total: source.size, percent: 100 });
      return response;
    }
    const target = new URL(path, normalizedOrigin());
    return new Promise<Response>((resolve, reject) => {
      const request = new globalThis.XMLHttpRequest();
      let lastLoaded = -1;
      const report = (loaded: number, total = source.size) => {
        const boundedTotal = Math.max(0, total || source.size);
        const boundedLoaded = Math.max(0, Math.min(loaded, boundedTotal));
        if (boundedLoaded === lastLoaded) return;
        lastLoaded = boundedLoaded;
        onProgress({
          loaded: boundedLoaded,
          total: boundedTotal,
          percent: boundedTotal === 0 ? 100 : Math.round((boundedLoaded / boundedTotal) * 100),
        });
      };
      const fail = (cause: unknown) =>
        reject(
          new OpenCloudError("OpenCloud files request could not be completed", {
            code: "NETWORK_ERROR",
            surface,
            retryable: true,
            cause,
          }),
        );
      request.open(method, target.toString());
      request.withCredentials = true;
      request.responseType = "arraybuffer";
      new Headers(headers).forEach((value, name) => {
        request.setRequestHeader(name, value);
      });
      request.upload.addEventListener("progress", (event) => {
        report(event.loaded, event.lengthComputable ? event.total : source.size);
      });
      request.addEventListener("load", () => {
        report(source.size, source.size);
        const responseHeaders = new Headers();
        for (const line of request.getAllResponseHeaders().trim().split(/\r?\n/)) {
          if (!line) continue;
          const separator = line.indexOf(":");
          if (separator > 0) {
            responseHeaders.append(
              line.slice(0, separator).trim(),
              line.slice(separator + 1).trim(),
            );
          }
        }
        resolve(
          new Response(request.response, {
            status: request.status,
            statusText: request.statusText,
            headers: responseHeaders,
          }),
        );
      });
      request.addEventListener("error", fail);
      request.addEventListener("abort", fail);
      request.addEventListener("timeout", fail);
      report(0, source.size);
      request.send(source);
    });
  }

  reset(): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.configValue = undefined;
    this.configPromise = undefined;
    this.sessionValue = undefined;
    this.sessionPromise = undefined;
  }

  private async fetch(
    input: URL,
    init: RequestInit,
    surface: OpenCloudErrorSurface,
  ): Promise<Response> {
    if (typeof globalThis.fetch !== "function") {
      throw capabilityUnavailable("data", surface);
    }
    try {
      return await globalThis.fetch(input, init);
    } catch (cause) {
      if (cause instanceof OpenCloudError) throw cause;
      throw new OpenCloudError(`OpenCloud ${surface} request could not be completed`, {
        code: "NETWORK_ERROR",
        surface,
        retryable: true,
        cause,
      });
    }
  }

  private scheduleRefresh(session: WireSession | null): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    if (!session) return;
    const delay = Math.max(0, Date.parse(session.refreshAfter) - Date.now());
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.session(true).catch(() => undefined);
    }, Math.min(delay, 2_147_483_647));
  }
}

class AppClient {
  constructor(private readonly runtime: RuntimeCore) {}

  async info(): Promise<OpenCloudAppInfo> {
    const config = await this.runtime.config();
    return {
      id: config.appId,
      version: config.deploymentVersion,
      environment: config.environment,
      visibility: config.visibility,
      capabilities: { ...config.capabilities },
    };
  }
}

class AuthClient {
  constructor(private readonly runtime: RuntimeCore) {}
  currentUser(): Promise<OpenCloudUser | null> {
    return this.runtime.user(false);
  }
  requireUser(): Promise<OpenCloudUser> {
    return this.runtime.requireUser();
  }
  signInUrl(): string {
    const target = new URL("/_opencloud/sign-in", normalizedOrigin());
    target.searchParams.set("return_to", currentLocationPath());
    return target.toString();
  }
}

function selectValue(select: string[] | undefined): string {
  if (!select?.length) return "*";
  return select.map((column) => assertIdentifier(column, "column")).join(",");
}

function filterValue(value: OpenCloudScalar): string {
  if (value === null) return "is.null";
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw invalidArgument("OpenCloud data filters must be finite", "data");
  }
  return `eq.${String(value)}`;
}

class DataTable<Row> {
  constructor(
    private readonly runtime: RuntimeCore,
    private readonly tableName: string,
  ) {
    assertIdentifier(tableName, "table");
  }

  async list(options: OpenCloudListOptions = {}): Promise<Row[]> {
    const config = await this.runtime.config();
    if (!config.capabilities.data) throw capabilityUnavailable("data", "data");
    const query = new URLSearchParams({ select: selectValue(options.select) });
    for (const [column, value] of Object.entries(options.where ?? {})) {
      query.set(assertIdentifier(column, "filter column"), filterValue(value));
    }
    if (options.orderBy) {
      const direction = options.orderBy.direction ?? "asc";
      query.set(
        "order",
        `${assertIdentifier(options.orderBy.column, "order column")}.${direction}`,
      );
    }
    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
        throw invalidArgument("OpenCloud data limit must be between 1 and 1000", "data");
      }
      query.set("limit", String(options.limit));
    }
    if (options.offset !== undefined) {
      if (!Number.isInteger(options.offset) || options.offset < 0) {
        throw invalidArgument("OpenCloud data offset must be a non-negative integer", "data");
      }
      query.set("offset", String(options.offset));
    }
    const response = await this.runtime.request(
      `/rest/v1/${this.tableName}?${query.toString()}`,
      { headers: { accept: "application/json" } },
      "optional",
      "data",
    );
    await requireOk(response, "data");
    const rows = await parsedBody(response, "data");
    if (!Array.isArray(rows)) throw invalidResponse("OpenCloud data did not return rows", "data");
    return rows as Row[];
  }

  async getById(id: string, options: OpenCloudGetOptions = {}): Promise<Row | null> {
    if (!id) throw invalidArgument("OpenCloud row id is required", "data");
    const rows = await this.list({
      ...(options.select ? { select: options.select } : {}),
      where: { id },
      limit: 1,
    });
    return rows[0] ?? null;
  }

  async create(values: Record<string, unknown>): Promise<Row> {
    const rows = await this.write("POST", "", values);
    const row = rows[0];
    if (!row) throw invalidResponse("OpenCloud data create returned no row", "data");
    return row;
  }

  async createMany(values: Record<string, unknown>[]): Promise<Row[]> {
    if (!values.length) throw invalidArgument("OpenCloud createMany needs at least one row", "data");
    return this.write("POST", "", values);
  }

  async updateById(id: string, patch: Record<string, unknown>): Promise<Row | null> {
    if (!id) throw invalidArgument("OpenCloud row id is required", "data");
    if (!Object.keys(patch).length) throw invalidArgument("OpenCloud update patch is empty", "data");
    const query = new URLSearchParams({ id: `eq.${id}` });
    const rows = await this.write("PATCH", `?${query.toString()}`, patch);
    return rows[0] ?? null;
  }

  async deleteById(id: string): Promise<boolean> {
    if (!id) throw invalidArgument("OpenCloud row id is required", "data");
    const config = await this.runtime.config();
    if (!config.capabilities.data) throw capabilityUnavailable("data", "data");
    const query = new URLSearchParams({ id: `eq.${id}` });
    const response = await this.runtime.request(
      `/rest/v1/${this.tableName}?${query.toString()}`,
      { method: "DELETE", headers: { accept: "application/json", prefer: "return=representation" } },
      "user",
      "data",
    );
    await requireOk(response, "data");
    const result = await parsedBody(response, "data");
    return result === undefined || (Array.isArray(result) && result.length > 0);
  }

  private async write(
    method: "POST" | "PATCH",
    suffix: string,
    body: Record<string, unknown> | Record<string, unknown>[],
  ): Promise<Row[]> {
    const config = await this.runtime.config();
    if (!config.capabilities.data) throw capabilityUnavailable("data", "data");
    const response = await this.runtime.request(
      `/rest/v1/${this.tableName}${suffix}`,
      {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          prefer: "return=representation",
        },
        body: JSON.stringify(body),
      },
      "user",
      "data",
    );
    await requireOk(response, "data");
    const result = await parsedBody(response, "data");
    if (!Array.isArray(result)) throw invalidResponse("OpenCloud data did not return rows", "data");
    return result as Row[];
  }
}

class DataClient {
  constructor(private readonly runtime: RuntimeCore) {}
  table<Row = Record<string, unknown>>(name: string): DataTable<Row> {
    return new DataTable<Row>(this.runtime, name);
  }
}

function argumentObject(
  value: unknown,
  allowedFields: readonly string[],
  scope: string,
): Record<string, unknown> {
  const input = plainArgumentObject(value, scope);
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) {
      throw invalidArgument(`${scope}.${field} is not supported`, "files");
    }
  }
  return input;
}

function plainArgumentObject(
  value: unknown,
  scope: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgument(`${scope} must be an object`, "files");
  }
  return value as Record<string, unknown>;
}

function fileUploadOptions(value: unknown): OpenCloudFileUploadOptions {
  const input = argumentObject(
    value,
    ["name", "contentType", "maxBytes", "onProgress"],
    "file upload options",
  );
  if (input.name !== undefined && typeof input.name !== "string") {
    throw invalidArgument("file upload options.name must be a string", "files");
  }
  if (
    input.contentType !== undefined &&
    typeof input.contentType !== "string"
  ) {
    throw invalidArgument(
      "file upload options.contentType must be a string",
      "files",
    );
  }
  if (
    input.onProgress !== undefined &&
    typeof input.onProgress !== "function"
  ) {
    throw invalidArgument(
      "file upload options.onProgress must be a function",
      "files",
    );
  }
  return input as OpenCloudFileUploadOptions;
}

function fileName(source: Blob, explicit?: string): string {
  const candidate = explicit ??
    ("name" in source && typeof source.name === "string" ? source.name : "file");
  const safe = candidate
    .replace(/[\/\\\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 220);
  return safe || "file";
}

function operationUuid(surface: OpenCloudErrorSurface): string {
  const value = globalThis.crypto?.randomUUID?.();
  if (!value || !UUID.test(value)) {
    throw capabilityUnavailable(surface === "files" ? "files" : "data", surface);
  }
  return value;
}

function fileReference(value: OpenCloudFile | string): OpenCloudFile {
  const reference = typeof value === "string"
    ? { id: value, name: value, contentType: "application/octet-stream", size: 0 }
    : value;
  if (!UUID.test(reference.id)) {
    throw invalidArgument("OpenCloud file id is invalid", "files");
  }
  return reference;
}

function parseFile(value: unknown): OpenCloudFile {
  const input = object(value, "file");
  const id = string(input.id, "file.id");
  if (!UUID.test(id)) {
    throw invalidResponse("OpenCloud Files returned an invalid file id", "files");
  }
  const size = integer(input.size, "file.size");
  if (size < 0) {
    throw invalidResponse("OpenCloud Files returned an invalid file size", "files");
  }
  return {
    id,
    name: string(input.name, "file.name", true),
    contentType: string(input.contentType, "file.contentType"),
    size,
  };
}

class FilesClient {
  constructor(
    private readonly runtime: RuntimeCore,
    private readonly data: DataClient,
  ) {}

  async upload(
    source: Blob,
    options: OpenCloudFileUploadOptions = {},
  ): Promise<OpenCloudFile> {
    const checkedOptions = fileUploadOptions(options);
    const metadata = await this.uploadMetadata(source, checkedOptions);
    await this.runtime.requireUser();
    const idempotencyKey = operationUuid("files");
    const response = await this.uploadRequest(
      "/_opencloud/files",
      "POST",
      source,
      {
        accept: "application/json",
        "content-type": metadata.contentType,
        "x-opencloud-file-name": encodeURIComponent(metadata.name),
        "idempotency-key": idempotencyKey,
      },
      checkedOptions.onProgress,
    );
    await requireOk(response, "files");
    return parseFile(await response.json());
  }

  async download(value: OpenCloudFile | string): Promise<OpenCloudFileDownload> {
    const file = fileReference(value);
    await this.assertAvailable();
    const response = await this.runtime.hostRequest(
      `/_opencloud/files/${encodeURIComponent(file.id)}`,
      { headers: { accept: "*/*" } },
      "files",
    );
    await requireOk(response, "files");
    const blob = await response.blob();
    const encodedName = response.headers.get("x-opencloud-file-name");
    let responseName: string | null = null;
    if (encodedName) {
      try {
        responseName = decodeURIComponent(encodedName);
      } catch {
        throw invalidResponse("OpenCloud Files returned an invalid file name", "files");
      }
    }
    return {
      blob,
      name: responseName ?? file.name,
      contentType: response.headers.get("content-type") || file.contentType || blob.type,
      size: blob.size,
    };
  }

  async save(value: OpenCloudFile | string): Promise<void> {
    if (
      typeof document !== "object" ||
      typeof URL.createObjectURL !== "function" ||
      typeof URL.revokeObjectURL !== "function"
    ) {
      throw capabilityUnavailable("files", "files");
    }
    const result = await this.download(value);
    const url = URL.createObjectURL(result.blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.name;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }
  }

  async replace(
    value: OpenCloudFile | string,
    source: Blob,
    options: OpenCloudFileUploadOptions = {},
  ): Promise<OpenCloudFile> {
    const current = fileReference(value);
    const checkedOptions = fileUploadOptions(options);
    const metadata = await this.uploadMetadata(source, {
      ...checkedOptions,
      name: checkedOptions.name ?? current.name,
      contentType: checkedOptions.contentType ?? current.contentType,
    });
    await this.runtime.requireUser();
    const idempotencyKey = operationUuid("files");
    const response = await this.uploadRequest(
      `/_opencloud/files/${encodeURIComponent(current.id)}`,
      "PUT",
      source,
      {
        accept: "application/json",
        "content-type": metadata.contentType,
        "x-opencloud-file-name": encodeURIComponent(metadata.name),
        "idempotency-key": idempotencyKey,
      },
      checkedOptions.onProgress,
    );
    await requireOk(response, "files");
    return parseFile(await response.json());
  }

  async remove(value: OpenCloudFile | string): Promise<void> {
    const file = fileReference(value);
    await this.assertAvailable();
    await this.runtime.requireUser();
    const response = await this.runtime.hostRequest(
      `/_opencloud/files/${encodeURIComponent(file.id)}`,
      { method: "DELETE" },
      "files",
    );
    if (response.status !== 404) await requireOk(response, "files");
  }

  async attach<Row = Record<string, unknown>>(
    source: Blob,
    options: OpenCloudFileAttachmentOptions,
  ): Promise<{ file: OpenCloudFile; record: Row }> {
    argumentObject(
      options,
      ["table", "values", "columns", "upload"],
      "file attachment options",
    );
    if (typeof options.table !== "string") {
      throw invalidArgument(
        "file attachment options.table must be a string",
        "files",
      );
    }
    if (options.values !== undefined) {
      plainArgumentObject(options.values, "file attachment options.values");
    }
    if (options.columns) {
      argumentObject(
        options.columns,
        ["id", "name", "contentType", "size"],
        "file attachment options.columns",
      );
    }
    const columns = {
      id: options.columns?.id ?? "file_id",
      name: options.columns?.name ?? "file_name",
      contentType: options.columns?.contentType ?? "file_type",
      size: options.columns?.size ?? "file_size",
    };
    for (const column of Object.values(columns)) assertIdentifier(column, "attachment column");
    const file = await this.upload(source, options.upload);
    const values = {
      ...(options.values ?? {}),
      [columns.id]: file.id,
      [columns.name]: file.name,
      [columns.contentType]: file.contentType,
      [columns.size]: file.size,
    };
    const table = this.data.table<Row>(options.table);
    try {
      const record = await table.create(values);
      return { file, record };
    } catch (cause) {
      const ambiguous =
        cause instanceof OpenCloudError &&
        (cause.code === "NETWORK_ERROR" || cause.retryable);
      if (ambiguous) {
        try {
          const rows = await table.list({ where: { [columns.id]: file.id }, limit: 1 });
          if (rows[0]) return { file, record: rows[0] };
        } catch (reconciliationCause) {
          throw this.incomplete(file, cause, reconciliationCause);
        }
      }
      try {
        await this.remove(file);
      } catch (cleanupCause) {
        throw this.incomplete(file, cause, cleanupCause);
      }
      throw cause;
    }
  }

  private incomplete(
    file: OpenCloudFile,
    cause: unknown,
    cleanupCause: unknown,
  ): OpenCloudError {
    return new OpenCloudError(
      "OpenCloud could not confirm file attachment cleanup",
      {
        code: "FILE_ATTACHMENT_INCOMPLETE",
        surface: "files",
        retryable: true,
        details: { file, cleanupRequired: true, cleanupError: String(cleanupCause) },
        cause,
      },
    );
  }

  private async uploadRequest(
    path: string,
    method: "POST" | "PUT",
    source: Blob,
    headers: HeadersInit,
    onProgress?: (progress: OpenCloudFileUploadProgress) => void,
  ): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.runtime.hostUpload(
          path,
          method,
          source,
          headers,
          "files",
          onProgress,
        );
        if (attempt === 0 && retryableStatus(response.status)) {
          await response.arrayBuffer().catch(() => undefined);
          continue;
        }
        return response;
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof OpenCloudError &&
          error.retryable
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new OpenCloudError("OpenCloud files request could not be completed", {
      code: "NETWORK_ERROR",
      surface: "files",
      retryable: true,
    });
  }

  private async uploadMetadata(
    source: Blob,
    options: OpenCloudFileUploadOptions,
  ): Promise<Omit<OpenCloudFile, "id">> {
    const config = await this.runtime.config();
    if (!config.capabilities.files) throw capabilityUnavailable("files", "files");
    if (
      typeof source !== "object" ||
      source === null ||
      typeof source.size !== "number" ||
      typeof source.type !== "string"
    ) {
      throw invalidArgument("OpenCloud file source must be a Blob or File", "files");
    }
    if (!config.files) throw capabilityUnavailable("files", "files");
    const requestedLimit = options.maxBytes ?? config.files.maxUploadBytes;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw invalidArgument("OpenCloud file maxBytes must be a positive integer", "files");
    }
    const maximum = Math.min(requestedLimit, config.files.maxUploadBytes);
    if (source.size > maximum) {
      throw new OpenCloudError(`File exceeds the ${maximum}-byte upload limit`, {
        code: "FILE_TOO_LARGE",
        surface: "files",
        details: { size: source.size, maxBytes: maximum },
      });
    }
    return {
      name: fileName(source, options.name),
      contentType: options.contentType || source.type || "application/octet-stream",
      size: source.size,
    };
  }

  private async assertAvailable(): Promise<RuntimeConfig> {
    const config = await this.runtime.config();
    if (!config.capabilities.files) throw capabilityUnavailable("files", "files");
    return config;
  }
}

class FunctionsClient {
  constructor(private readonly runtime: RuntimeCore) {}

  async call<Input = undefined, Output = unknown>(
    name: string,
    input?: Input,
  ): Promise<Output> {
    const { config, auth } = await this.definition(name);
    const headers = new Headers({ accept: "application/json" });
    const init: RequestInit = { method: "POST", headers };
    if (input !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(input);
    }
    const response = await this.runtime.request(
      sameOriginPath(
        config.environment === "dev"
          ? "/_opencloud/dev/functions"
          : "/functions/v1",
        name,
      ),
      init,
      auth,
      "functions",
    );
    await requireOk(response, "functions");
    return (await parsedBody(response, "functions")) as Output;
  }

  async stream<Input = undefined>(
    name: string,
    input?: Input,
  ): Promise<ReadableStream<Uint8Array>> {
    const { config, auth } = await this.definition(name);
    const headers = new Headers({ accept: "application/octet-stream" });
    const init: RequestInit = { method: "POST", headers };
    if (input !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(input);
    }
    const response = await this.runtime.request(
      sameOriginPath(
        config.environment === "dev"
          ? "/_opencloud/dev/functions"
          : "/functions/v1",
        name,
      ),
      init,
      auth,
      "functions",
    );
    await requireOk(response, "functions");
    if (!response.body) throw invalidResponse("OpenCloud Function returned no stream", "functions");
    return response.body;
  }

  private async definition(
    name: string,
  ): Promise<{ config: RuntimeConfig; auth: AuthMode }> {
    assertFunctionName(name);
    const config = await this.runtime.config();
    if (!config.capabilities.functions) {
      throw capabilityUnavailable("functions", "functions");
    }
    const definition = config.functions.find((item) => item.name === name);
    if (!definition) {
      throw new OpenCloudError(`OpenCloud Function ${name} is not declared`, {
        code: "FUNCTION_NOT_DECLARED",
        surface: "functions",
      });
    }
    if (definition?.access === "system") {
      throw new OpenCloudError(
        `OpenCloud Function ${name} is available only to platform invocations`,
        {
          code: "FUNCTION_SYSTEM_ONLY",
          surface: "functions",
          details: { name },
        },
      );
    }
    return {
      config,
      auth: definition.access === "user" ? "user" : "public",
    };
  }
}

type RealtimeState = "idle" | "connecting" | "joined" | "reconnecting" | "closed";

class RealtimeChannel {
  private state: RealtimeState = "idle";
  private socket: WebSocket | undefined;
  private joinReference: string | undefined;
  private reference = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private connectPromise: Promise<void> | undefined;
  private resolveConnect: (() => void) | undefined;
  private rejectConnect: ((error: unknown) => void) | undefined;
  private closed = false;
  readonly handlers = new Set<(message: OpenCloudRealtimeMessage) => void>();

  constructor(
    private readonly name: string,
    private readonly runtime: RuntimeCore,
  ) {
    if (!REALTIME_NAME.test(name)) {
      throw invalidArgument("OpenCloud Realtime topic is invalid", "realtime");
    }
  }

  connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new OpenCloudError("OpenCloud Realtime subscription is closed", {
        code: "SUBSCRIPTION_CLOSED",
        surface: "realtime",
      }));
    }
    if (this.state === "joined") return Promise.resolve();
    if (!this.connectPromise) {
      this.connectPromise = new Promise<void>((resolve, reject) => {
        this.resolveConnect = resolve;
        this.rejectConnect = reject;
      });
      void this.open(false);
    }
    return this.connectPromise;
  }

  async publish(event: string, payload: unknown): Promise<void> {
    if (!EVENT_NAME.test(event)) {
      throw invalidArgument("OpenCloud Realtime event is invalid", "realtime");
    }
    await this.connect();
    if (!this.socket || this.socket.readyState !== 1 || !this.joinReference) {
      throw invalidResponse("OpenCloud Realtime subscription is not joined", "realtime");
    }
    const config = await this.runtime.config();
    this.socket.send(JSON.stringify({
      topic: `realtime:app:${config.appId}:${this.name}`,
      event: "broadcast",
      payload: { type: "broadcast", event, payload },
      ref: this.nextReference(),
      join_ref: this.joinReference,
    }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.socket?.close(1000, "client closed");
    this.socket = undefined;
    this.rejectConnect?.(new OpenCloudError("OpenCloud Realtime subscription was closed", {
      code: "SUBSCRIPTION_CLOSED",
      surface: "realtime",
    }));
    this.clearPending();
    this.state = "closed";
  }

  private async open(reconnecting: boolean): Promise<void> {
    try {
      const config = await this.runtime.config();
      if (!config.capabilities.realtime) {
        throw capabilityUnavailable("realtime", "realtime");
      }
      const session = await this.runtime.session(reconnecting);
      if (!session) {
        throw new OpenCloudError("An OpenCloud user session is required", {
          code: "AUTH_REQUIRED",
          surface: "realtime",
          status: 401,
        });
      }
      if (typeof globalThis.WebSocket !== "function") {
        throw capabilityUnavailable("realtime", "realtime");
      }
      if (this.closed) return;
      this.state = reconnecting ? "reconnecting" : "connecting";
      const target = new URL(config.runtimeOrigin);
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      target.pathname = "/realtime/v1/websocket";
      const realtimeQuery = new URLSearchParams({ vsn: "1.0.0" });
      target.search = realtimeQuery.toString();
      const socket = new globalThis.WebSocket(target);
      this.socket = socket;
      socket.addEventListener("open", () => this.join(socket, config, session));
      socket.addEventListener("message", (event) => this.message(socket, event.data));
      socket.addEventListener("close", () => {
        if (socket !== this.socket) return;
        this.socket = undefined;
        this.stopHeartbeat();
        if (!this.closed) this.scheduleReconnect();
      });
      socket.addEventListener("error", () => {
        if (socket === this.socket) socket.close();
      });
    } catch (cause) {
      if (cause instanceof OpenCloudError &&
          ["AUTH_REQUIRED", "CAPABILITY_UNAVAILABLE"].includes(cause.code)) {
        this.rejectConnect?.(cause);
        this.clearPending();
        this.state = "idle";
        return;
      }
      if (!this.closed) this.scheduleReconnect();
    }
  }

  private join(socket: WebSocket, config: RuntimeConfig, session: WireSession): void {
    const ref = this.nextReference();
    this.joinReference = ref;
    socket.send(JSON.stringify({
      topic: `realtime:app:${config.appId}:${this.name}`,
      event: "phx_join",
      payload: {
        config: {
          private: true,
          broadcast: { ack: true, self: true },
          presence: { enabled: false },
          postgres_changes: [],
        },
        access_token: session.accessToken,
      },
      ref,
      join_ref: ref,
    }));
  }

  private message(socket: WebSocket, source: unknown): void {
    if (socket !== this.socket) return;
    let message: { event?: string; ref?: string; payload?: { status?: string; event?: string; payload?: unknown } };
    try {
      const text = typeof source === "string"
        ? source
        : source instanceof ArrayBuffer
          ? new TextDecoder().decode(source)
          : String(source);
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (message.event === "phx_reply" && message.ref === this.joinReference) {
      if (message.payload?.status === "ok") {
        this.reconnectAttempt = 0;
        this.state = "joined";
        this.resolveConnect?.();
        this.clearPending();
        this.startHeartbeat();
      } else {
        socket.close();
      }
      return;
    }
    if (message.event === "broadcast" && typeof message.payload?.event === "string") {
      const value = { event: message.payload.event, payload: message.payload.payload };
      for (const handler of this.handlers) handler(value);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.state = "reconnecting";
    const delay = Math.min(10_000, 500 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.open(true);
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const heartbeat = () => {
      if (this.socket?.readyState === 1 && this.state === "joined") {
        this.socket.send(JSON.stringify({
          topic: "phoenix",
          event: "heartbeat",
          payload: {},
          ref: this.nextReference(),
        }));
        this.heartbeatTimer = setTimeout(heartbeat, 25_000);
      }
    };
    this.heartbeatTimer = setTimeout(heartbeat, 25_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearPending(): void {
    this.connectPromise = undefined;
    this.resolveConnect = undefined;
    this.rejectConnect = undefined;
  }

  private nextReference(): string {
    this.reference += 1;
    return String(this.reference);
  }
}

class RealtimeClient {
  private readonly channels = new Map<string, RealtimeChannel>();
  private lifecycleInstalled = false;

  constructor(private readonly runtime: RuntimeCore) {}

  async subscribe(
    topic: string,
    handler: (message: OpenCloudRealtimeMessage) => void,
  ): Promise<() => void> {
    this.installLifecycle();
    const channel = this.channel(topic);
    channel.handlers.add(handler);
    try {
      await channel.connect();
    } catch (cause) {
      channel.handlers.delete(handler);
      if (!channel.handlers.size) {
        channel.close();
        this.channels.delete(topic);
      }
      throw cause;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      channel.handlers.delete(handler);
      if (!channel.handlers.size) {
        channel.close();
        this.channels.delete(topic);
      }
    };
  }

  async publish(topic: string, event: string, payload: unknown): Promise<void> {
    this.installLifecycle();
    const existing = this.channels.get(topic);
    const channel = existing ?? this.channel(topic);
    try {
      await channel.publish(event, payload);
    } finally {
      if (!existing && !channel.handlers.size) {
        channel.close();
        this.channels.delete(topic);
      }
    }
  }

  dispose(): void {
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
  }

  private channel(topic: string): RealtimeChannel {
    const existing = this.channels.get(topic);
    if (existing) return existing;
    const channel = new RealtimeChannel(topic, this.runtime);
    this.channels.set(topic, channel);
    return channel;
  }

  private installLifecycle(): void {
    if (this.lifecycleInstalled || typeof globalThis.addEventListener !== "function") return;
    this.lifecycleInstalled = true;
    globalThis.addEventListener("pagehide", () => this.dispose(), { once: true });
  }
}

function parseTelemetrySummary(value: unknown): OpenCloudTelemetrySummary {
  const input = object(value, "telemetry");
  const activity = object(input.activity, "activity");
  const window = object(activity.window, "activity.window");
  const freshness = object(activity.telemetry, "activity.telemetry");
  const status = freshness.status;
  if (status !== "available" && status !== "unavailable") {
    throw invalidResponse("Invalid OpenCloud response field: activity.telemetry.status", "telemetry");
  }
  const rawSurfaces = object(activity.surfaces, "activity.surfaces");
  const surfaces = {} as Record<OpenCloudTelemetrySurface, OpenCloudTelemetrySurfaceActivity>;
  for (const surface of ["page", "rest", "storage", "realtime", "function", "cron"] as const) {
    const raw = object(rawSurfaces[surface], `activity.surfaces.${surface}`);
    surfaces[surface] = {
      lastActivityAt: raw.lastActivityAt === null ? null : iso(raw.lastActivityAt, `${surface}.lastActivityAt`),
      requests24h: integer(raw.requests24h, `${surface}.requests24h`),
      errors24h: integer(raw.errors24h, `${surface}.errors24h`),
      lastStatus: raw.lastStatus === null ? null : integer(raw.lastStatus, `${surface}.lastStatus`),
    };
  }
  let usage: OpenCloudTelemetryRollup | null = null;
  if (input.usage !== null) {
    const raw = object(input.usage, "usage");
    usage = {
      windowStart: iso(raw.windowStart, "usage.windowStart"),
      windowEnd: iso(raw.windowEnd, "usage.windowEnd"),
      calculationVersion: string(raw.calculationVersion, "usage.calculationVersion"),
      completeness: string(raw.completeness, "usage.completeness") as OpenCloudTelemetryRollup["completeness"],
      metrics: object(raw.metrics, "usage.metrics"),
      createdAt: iso(raw.createdAt, "usage.createdAt"),
    };
  }
  return {
    appId: string(input.appId, "appId"),
    asOf: iso(input.asOf, "asOf"),
    usage,
    activity: {
      window: {
        from: iso(window.from, "activity.window.from"),
        to: iso(window.to, "activity.window.to"),
        seconds: number(window.seconds, "activity.window.seconds"),
      },
      telemetry: {
        status,
        latestIngestedAt: freshness.latestIngestedAt === null ? null : iso(freshness.latestIngestedAt, "activity.telemetry.latestIngestedAt"),
        ingestionLagSeconds: freshness.ingestionLagSeconds === null ? null : number(freshness.ingestionLagSeconds, "activity.telemetry.ingestionLagSeconds"),
        sampledEntries: integer(freshness.sampledEntries, "activity.telemetry.sampledEntries"),
        truncated: bool(freshness.truncated, "activity.telemetry.truncated"),
      },
      surfaces,
    },
  };
}

class TelemetryClient {
  constructor(private readonly runtime: RuntimeCore) {}

  async summary(): Promise<OpenCloudTelemetrySummary> {
    const config = await this.runtime.config();
    if (!config.capabilities.telemetry) {
      throw capabilityUnavailable("telemetry", "telemetry");
    }
    const response = await this.runtime.hostRequest(
      "/_opencloud/telemetry/summary",
      { headers: { accept: "application/json" } },
      "telemetry",
    );
    await requireOk(response, "telemetry");
    return parseTelemetrySummary(await response.json());
  }

  increment(
    name: string,
    value = 1,
    options: OpenCloudMetricWriteOptions = {},
  ): Promise<OpenCloudMetricWriteResult> {
    if (!Number.isFinite(value) || value < 0) {
      throw invalidArgument("OpenCloud counter increments must be finite and non-negative", "telemetry");
    }
    return this.write(name, value, options);
  }

  gauge(
    name: string,
    value: number,
    options: OpenCloudMetricWriteOptions = {},
  ): Promise<OpenCloudMetricWriteResult> {
    if (!Number.isFinite(value)) {
      throw invalidArgument("OpenCloud gauge values must be finite", "telemetry");
    }
    return this.write(name, value, options);
  }

  private async write(
    name: string,
    value: number,
    options: OpenCloudMetricWriteOptions,
  ): Promise<OpenCloudMetricWriteResult> {
    const config = await this.runtime.config();
    if (!config.capabilities.telemetry) {
      throw capabilityUnavailable("telemetry", "telemetry");
    }
    const response = await this.runtime.hostRequest(
      "/_opencloud/telemetry/metrics",
      {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          measurements: [{
            name,
            value,
            dimensions: options.dimensions ?? {},
            ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          }],
        }),
      },
      "telemetry",
    );
    await requireOk(response, "telemetry");
    const result = object(await response.json(), "metric result");
    return {
      accepted: integer(result.accepted, "accepted"),
      duplicates: integer(result.duplicates, "duplicates"),
      recordedAt: iso(result.recordedAt, "recordedAt"),
    };
  }
}

class OpenCloudClientImplementation implements OpenCloudClient {
  readonly app: AppClient;
  readonly auth: AuthClient;
  readonly data: DataClient;
  readonly files: FilesClient;
  readonly functions: FunctionsClient;
  readonly realtime: RealtimeClient;
  readonly telemetry: TelemetryClient;
  private readonly runtime = new RuntimeCore();

  constructor() {
    this.app = new AppClient(this.runtime);
    this.auth = new AuthClient(this.runtime);
    this.data = new DataClient(this.runtime);
    this.files = new FilesClient(this.runtime, this.data);
    this.functions = new FunctionsClient(this.runtime);
    this.realtime = new RealtimeClient(this.runtime);
    this.telemetry = new TelemetryClient(this.runtime);
  }

  /** Close subscriptions and clear cached runtime/session state. */
  dispose(): void {
    this.realtime.dispose();
    this.runtime.reset();
  }
}

/** The same-origin, deployment-pinned OpenCloud client for this app. */
export const opencloud: OpenCloudClient = new OpenCloudClientImplementation();
