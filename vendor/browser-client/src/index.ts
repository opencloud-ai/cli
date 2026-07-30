/**
 * OpenCloud's same-origin browser runtime client.
 *
 * Access tokens are deliberately kept inside this module. The public session
 * shape contains identity and expiry metadata only; token refresh is brokered
 * through the HttpOnly OpenCloud session cookie.
 */

/** Exact version of the self-hosted OpenCloud JavaScript SDK. */
export const OPEN_CLOUD_JS_VERSION = "0.2.2";

/** @deprecated Use {@link OPEN_CLOUD_JS_VERSION}. */
export const BROWSER_CLIENT_VERSION = OPEN_CLOUD_JS_VERSION;

export interface OpenCloudJavaScriptSdkConfig {
  package: "@opencloud/js";
  version: string;
  module: string;
  types: string;
  docs: string;
}

export interface OpenCloudRuntimeConfig {
  appId: string;
  deploymentVersion: string | null;
  visibility: "public" | "private";
  supabaseUrl: string;
  supabaseAnonKey: string;
  storageBucket: string;
  functionsBasePath: string;
  javascriptSdk: OpenCloudJavaScriptSdkConfig;
  /** Exact module URL; retained as a compatibility alias. */
  browserClient: string;
  environment: string;
}

export interface OpenCloudSessionProfile {
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface OpenCloudSession {
  appId: string;
  userId: string;
  profile: OpenCloudSessionProfile;
  accessTokenExpiresAt: string;
  refreshAfter: string;
  sessionExpiresAt: string;
}

interface WireSession extends OpenCloudSession {
  accessToken: string;
}

export type OpenCloudAuthMode = "authenticated" | "anonymous" | "optional";

export interface OpenCloudRequestInit extends RequestInit {
  auth?: OpenCloudAuthMode;
}

export interface OpenCloudClientOptions {
  /** Defaults to window.location.origin. Must be an origin, not a path. */
  baseUrl?: string;
  /** Primarily useful to deterministic browser tests. */
  fetch?: typeof fetch;
  /** Primarily useful to deterministic browser tests. */
  WebSocket?: typeof WebSocket;
  /** Disable only in deterministic tests; production defaults to true. */
  automaticSessionRefresh?: boolean;
  /** Primarily useful to deterministic browser tests. */
  now?: () => number;
}

export type RealtimeState =
  | "idle"
  | "connecting"
  | "joined"
  | "reconnecting"
  | "closed";

export interface RealtimeChannelOptions {
  broadcast?: {
    ack?: boolean;
    self?: boolean;
  };
  reconnect?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
}

export interface RealtimeBroadcast {
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
  window: {
    from: string;
    to: string;
    seconds: number;
  };
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

/** Safe, host-bound 24-hour aggregate. It never contains raw logs or paths. */
export interface OpenCloudTelemetrySummary {
  appId: string;
  asOf: string;
  usage: OpenCloudTelemetryRollup | null;
  activity: OpenCloudTelemetryActivity;
}

export type OpenCloudMetricDimensions = Record<string, string>;

export interface OpenCloudMetricWriteOptions {
  dimensions?: OpenCloudMetricDimensions;
  /** Stable key used to make a retried measurement idempotent. */
  idempotencyKey?: string;
}

export interface OpenCloudMetricWriteResult {
  accepted: number;
  duplicates: number;
  recordedAt: string;
}

export class OpenCloudError extends Error {}

export class OpenCloudAuthError extends OpenCloudError {}

function requiredString(
  value: unknown,
  field: string,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0)
  ) {
    throw new OpenCloudError(`Invalid OpenCloud response field: ${field}`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field, true);
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new OpenCloudError(`Invalid OpenCloud response field: ${field}`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  const parsed = requiredNumber(value, field);
  if (!Number.isInteger(parsed)) {
    throw new OpenCloudError(`Invalid OpenCloud response field: ${field}`);
  }
  return parsed;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new OpenCloudError(`Invalid OpenCloud response field: ${field}`);
  }
  return value;
}

function nullableNumber(value: unknown, field: string): number | null {
  return value === null ? null : requiredNumber(value, field);
}

function requiredObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenCloudError(`Invalid OpenCloud response field: ${field}`);
  }
  return value as Record<string, unknown>;
}

function parseConfig(value: unknown): OpenCloudRuntimeConfig {
  const input = requiredObject(value, "config");
  const visibility = input.visibility;
  if (visibility !== "public" && visibility !== "private") {
    throw new OpenCloudError("Invalid OpenCloud response field: visibility");
  }
  const functionsBasePath = requiredString(
    input.functionsBasePath,
    "functionsBasePath",
  );
  const browserClient = requiredString(input.browserClient, "browserClient");
  const rawSdk = requiredObject(input.javascriptSdk, "javascriptSdk");
  const javascriptSdk: OpenCloudJavaScriptSdkConfig = {
    package: requiredString(
      rawSdk.package,
      "javascriptSdk.package",
    ) as "@opencloud/js",
    version: requiredString(rawSdk.version, "javascriptSdk.version"),
    module: requiredString(rawSdk.module, "javascriptSdk.module"),
    types: requiredString(rawSdk.types, "javascriptSdk.types"),
    docs: requiredString(rawSdk.docs, "javascriptSdk.docs"),
  };
  if (javascriptSdk.package !== "@opencloud/js") {
    throw new OpenCloudError(
      "Invalid OpenCloud response field: javascriptSdk.package",
    );
  }
  if (
    !functionsBasePath.startsWith("/") ||
    functionsBasePath.startsWith("//") ||
    !browserClient.startsWith("/") ||
    browserClient.startsWith("//") ||
    !javascriptSdk.module.startsWith("/") ||
    javascriptSdk.module.startsWith("//") ||
    !javascriptSdk.types.startsWith("/") ||
    javascriptSdk.types.startsWith("//")
  ) {
    throw new OpenCloudError("OpenCloud runtime paths must be same-origin");
  }
  if (
    javascriptSdk.module !== browserClient ||
    javascriptSdk.version !== OPEN_CLOUD_JS_VERSION
  ) {
    throw new OpenCloudError(
      "OpenCloud runtime and JavaScript SDK versions do not match",
    );
  }
  const docs = new URL(javascriptSdk.docs);
  if (docs.protocol !== "https:") {
    throw new OpenCloudError("OpenCloud SDK documentation must use HTTPS");
  }
  return {
    appId: requiredString(input.appId, "appId"),
    deploymentVersion:
      input.deploymentVersion === null
        ? null
        : requiredString(input.deploymentVersion, "deploymentVersion"),
    visibility,
    supabaseUrl: requiredString(input.supabaseUrl, "supabaseUrl"),
    supabaseAnonKey: requiredString(input.supabaseAnonKey, "supabaseAnonKey"),
    storageBucket: requiredString(input.storageBucket, "storageBucket"),
    functionsBasePath,
    javascriptSdk,
    browserClient,
    environment: requiredString(input.environment, "environment"),
  };
}

function parseIso(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new OpenCloudError(`Invalid OpenCloud response field: ${field}`);
  }
  return parsed;
}

function parseSurfaceActivity(
  value: unknown,
  field: string,
): OpenCloudTelemetrySurfaceActivity {
  const input = requiredObject(value, field);
  const lastStatus = nullableNumber(input.lastStatus, `${field}.lastStatus`);
  if (
    lastStatus !== null &&
    (!Number.isInteger(lastStatus) || lastStatus < 100 || lastStatus > 599)
  ) {
    throw new OpenCloudError(
      `Invalid OpenCloud response field: ${field}.lastStatus`,
    );
  }
  return {
    lastActivityAt:
      input.lastActivityAt === null
        ? null
        : parseIso(input.lastActivityAt, `${field}.lastActivityAt`),
    requests24h: requiredInteger(input.requests24h, `${field}.requests24h`),
    errors24h: requiredInteger(input.errors24h, `${field}.errors24h`),
    lastStatus,
  };
}

function parseTelemetrySummary(value: unknown): OpenCloudTelemetrySummary {
  const input = requiredObject(value, "telemetry");
  const rawActivity = requiredObject(input.activity, "activity");
  const rawWindow = requiredObject(rawActivity.window, "activity.window");
  const rawTelemetry = requiredObject(
    rawActivity.telemetry,
    "activity.telemetry",
  );
  const telemetryStatus = rawTelemetry.status;
  if (telemetryStatus !== "available" && telemetryStatus !== "unavailable") {
    throw new OpenCloudError(
      "Invalid OpenCloud response field: activity.telemetry.status",
    );
  }
  const rawSurfaces = requiredObject(
    rawActivity.surfaces,
    "activity.surfaces",
  );
  const surfaces = Object.fromEntries(
    (
      [
        "page",
        "rest",
        "storage",
        "realtime",
        "function",
        "cron",
      ] as const
    ).map((surface) => [
      surface,
      parseSurfaceActivity(
        rawSurfaces[surface],
        `activity.surfaces.${surface}`,
      ),
    ]),
  ) as Record<OpenCloudTelemetrySurface, OpenCloudTelemetrySurfaceActivity>;

  let usage: OpenCloudTelemetryRollup | null = null;
  if (input.usage !== null) {
    const rawUsage = requiredObject(input.usage, "usage");
    const completeness = rawUsage.completeness;
    if (
      completeness !== "complete" &&
      completeness !== "partial" &&
      completeness !== "corrected"
    ) {
      throw new OpenCloudError(
        "Invalid OpenCloud response field: usage.completeness",
      );
    }
    usage = {
      windowStart: parseIso(rawUsage.windowStart, "usage.windowStart"),
      windowEnd: parseIso(rawUsage.windowEnd, "usage.windowEnd"),
      calculationVersion: requiredString(
        rawUsage.calculationVersion,
        "usage.calculationVersion",
      ),
      completeness,
      metrics: requiredObject(rawUsage.metrics, "usage.metrics"),
      createdAt: parseIso(rawUsage.createdAt, "usage.createdAt"),
    };
  }

  return {
    appId: requiredString(input.appId, "appId"),
    asOf: parseIso(input.asOf, "asOf"),
    usage,
    activity: {
      window: {
        from: parseIso(rawWindow.from, "activity.window.from"),
        to: parseIso(rawWindow.to, "activity.window.to"),
        seconds: requiredInteger(
          rawWindow.seconds,
          "activity.window.seconds",
        ),
      },
      telemetry: {
        status: telemetryStatus,
        latestIngestedAt:
          rawTelemetry.latestIngestedAt === null
            ? null
            : parseIso(
                rawTelemetry.latestIngestedAt,
                "activity.telemetry.latestIngestedAt",
              ),
        ingestionLagSeconds: nullableNumber(
          rawTelemetry.ingestionLagSeconds,
          "activity.telemetry.ingestionLagSeconds",
        ),
        sampledEntries: requiredInteger(
          rawTelemetry.sampledEntries,
          "activity.telemetry.sampledEntries",
        ),
        truncated: requiredBoolean(
          rawTelemetry.truncated,
          "activity.telemetry.truncated",
        ),
      },
      surfaces,
    },
  };
}

function parseWireSession(value: unknown): WireSession {
  if (!value || typeof value !== "object") {
    throw new OpenCloudError("Invalid OpenCloud session");
  }
  const input = value as Record<string, unknown>;
  const rawProfile = input.profile;
  if (!rawProfile || typeof rawProfile !== "object") {
    throw new OpenCloudError("Invalid OpenCloud response field: profile");
  }
  const profile = rawProfile as Record<string, unknown>;
  const session: WireSession = {
    appId: requiredString(input.appId, "appId"),
    userId: requiredString(input.userId, "userId"),
    profile: {
      email: nullableString(profile.email, "profile.email"),
      displayName: nullableString(
        profile.displayName,
        "profile.displayName",
      ),
      avatarUrl: nullableString(profile.avatarUrl, "profile.avatarUrl"),
    },
    accessToken: requiredString(input.accessToken, "accessToken"),
    accessTokenExpiresAt: requiredString(
      input.accessTokenExpiresAt,
      "accessTokenExpiresAt",
    ),
    refreshAfter: requiredString(input.refreshAfter, "refreshAfter"),
    sessionExpiresAt: requiredString(
      input.sessionExpiresAt,
      "sessionExpiresAt",
    ),
  };
  for (const [field, source] of [
    ["accessTokenExpiresAt", session.accessTokenExpiresAt],
    ["refreshAfter", session.refreshAfter],
    ["sessionExpiresAt", session.sessionExpiresAt],
  ] as const) {
    if (!Number.isFinite(Date.parse(source))) {
      throw new OpenCloudError(`Invalid OpenCloud response field: ${field}`);
    }
  }
  return session;
}

function parseWireSessionEnvelope(value: unknown): WireSession | null {
  const input = requiredObject(value, "session envelope");
  if (input.session === null) return null;
  return parseWireSession(input.session);
}

function publicSession(session: WireSession): OpenCloudSession {
  return {
    appId: session.appId,
    userId: session.userId,
    profile: { ...session.profile },
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshAfter: session.refreshAfter,
    sessionExpiresAt: session.sessionExpiresAt,
  };
}

function normalizedBaseUrl(explicit?: string): string {
  const source =
    explicit ??
    (typeof globalThis.location === "object"
      ? globalThis.location.origin
      : undefined);
  if (!source) {
    throw new OpenCloudError(
      "OpenCloud browser client requires a browser origin or baseUrl",
    );
  }
  const url = new URL(source);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new OpenCloudError("OpenCloud baseUrl must be an origin");
  }
  return url.origin;
}

function sameOriginPath(basePath: string, relativePath: string): string {
  const cleanBase = basePath.replace(/\/+$/, "");
  const cleanRelative = relativePath.replace(/^\/+/, "");
  const segments = cleanRelative.split("/");
  if (
    !cleanRelative ||
    cleanRelative.includes("\\") ||
    segments.some((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return true;
      }
      return decoded === ".." || decoded === ".";
    })
  ) {
    throw new OpenCloudError("OpenCloud runtime path is invalid");
  }
  return `${cleanBase}/${cleanRelative}`;
}

function functionName(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(value)) {
    throw new OpenCloudError("OpenCloud function name is invalid");
  }
  return value;
}

class RuntimeResourceClient {
  constructor(
    private readonly client: OpenCloudBrowserClient,
    private readonly basePath: "/rest/v1" | "/storage/v1",
    private readonly defaultAuth: OpenCloudAuthMode,
  ) {}

  /**
   * Send a path relative to this resource namespace.
   *
   * Authentication defaults to the current user. Pass `auth: "anonymous"`
   * only for a deliberately public REST or Storage operation.
   */
  request(
    path: string,
    init: OpenCloudRequestInit = {},
  ): Promise<Response> {
    return this.client.runtimeRequest(
      sameOriginPath(this.basePath, path),
      init,
      init.auth ?? this.defaultAuth,
    );
  }
}

export class OpenCloudFunctionsClient {
  constructor(private readonly client: OpenCloudBrowserClient) {}

  /** Invoke a verifyJwt:true function with the current user's bearer token. */
  async invoke(
    name: string,
    init: Omit<OpenCloudRequestInit, "auth"> = {},
  ): Promise<Response> {
    const config = await this.client.config();
    return this.client.runtimeRequest(
      sameOriginPath(config.functionsBasePath, functionName(name)),
      init,
      "authenticated",
    );
  }

  /**
   * Invoke a verifyJwt:false function.
   *
   * OpenCloud still supplies the anonymous project identity required by the
   * gateway, even when a signed-in user has an active brokered session.
   */
  async invokePublic(
    name: string,
    init: Omit<OpenCloudRequestInit, "auth"> = {},
  ): Promise<Response> {
    const config = await this.client.config();
    return this.client.runtimeRequest(
      sameOriginPath(config.functionsBasePath, functionName(name)),
      init,
      "anonymous",
    );
  }
}

export class OpenCloudTelemetryClient {
  constructor(
    private readonly request: (
      path: string,
      init?: RequestInit,
    ) => Promise<Response>,
  ) {}

  /**
   * Read the exact, safe 24-hour activity and latest usage-rollup shape.
   *
   * Missing activity is quiet or unknown, never proof of health. Check
   * `activity.telemetry.status`, `latestIngestedAt`, and `truncated`.
   */
  async summary(): Promise<OpenCloudTelemetrySummary> {
    const response = await this.request("/_opencloud/telemetry/summary");
    if (!response.ok) {
      throw new OpenCloudError(
        `OpenCloud telemetry returned HTTP ${response.status}`,
      );
    }
    return parseTelemetrySummary(await response.json());
  }

  /** Add a non-negative delta to a deployment-declared counter. */
  increment(
    name: string,
    value = 1,
    options: OpenCloudMetricWriteOptions = {},
  ): Promise<OpenCloudMetricWriteResult> {
    if (!Number.isFinite(value) || value < 0) {
      throw new OpenCloudError(
        "OpenCloud counter increments must be finite and non-negative",
      );
    }
    return this.write(name, value, options);
  }

  /** Record the current value of a deployment-declared gauge. */
  gauge(
    name: string,
    value: number,
    options: OpenCloudMetricWriteOptions = {},
  ): Promise<OpenCloudMetricWriteResult> {
    if (!Number.isFinite(value)) {
      throw new OpenCloudError("OpenCloud gauge values must be finite");
    }
    return this.write(name, value, options);
  }

  private async write(
    name: string,
    value: number,
    options: OpenCloudMetricWriteOptions,
  ): Promise<OpenCloudMetricWriteResult> {
    const response = await this.request("/_opencloud/telemetry/metrics", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        measurements: [
          {
            name,
            value,
            dimensions: options.dimensions ?? {},
            ...(options.idempotencyKey
              ? { idempotencyKey: options.idempotencyKey }
              : {}),
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new OpenCloudError(
        `OpenCloud metric ingestion returned HTTP ${response.status}`,
      );
    }
    const result = requiredObject(await response.json(), "metric result");
    return {
      accepted: requiredInteger(result.accepted, "accepted"),
      duplicates: requiredInteger(result.duplicates, "duplicates"),
      recordedAt: parseIso(result.recordedAt, "recordedAt"),
    };
  }
}

interface ChannelDependencies {
  config: () => Promise<OpenCloudRuntimeConfig>;
  session: (forceRefresh: boolean) => Promise<WireSession>;
  WebSocket: typeof WebSocket;
  setTimer: (
    handler: () => void,
    timeoutMilliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

export class OpenCloudPrivateRealtimeChannel {
  private stateValue: RealtimeState = "idle";
  private socket: WebSocket | undefined;
  private joinReference: string | undefined;
  private reference = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private connectPromise: Promise<void> | undefined;
  private resolveConnect: (() => void) | undefined;
  private rejectConnect: ((error: unknown) => void) | undefined;
  private deliberatelyClosed = false;
  private readonly broadcastHandlers = new Set<
    (message: RealtimeBroadcast) => void
  >();
  private readonly stateHandlers = new Set<(state: RealtimeState) => void>();
  private readonly initialReconnectDelay: number;
  private readonly maxReconnectDelay: number;

  constructor(
    private readonly channelName: string,
    private readonly dependencies: ChannelDependencies,
    private readonly options: RealtimeChannelOptions = {},
  ) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(channelName)) {
      throw new OpenCloudError("OpenCloud Realtime channel name is invalid");
    }
    this.initialReconnectDelay = Math.max(
      10,
      options.reconnect?.initialDelayMs ?? 500,
    );
    this.maxReconnectDelay = Math.max(
      this.initialReconnectDelay,
      options.reconnect?.maxDelayMs ?? 10_000,
    );
  }

  /** Current connection lifecycle state. */
  get state(): RealtimeState {
    return this.stateValue;
  }

  /** Register a broadcast handler and return its unsubscribe function. */
  onBroadcast(
    handler: (message: RealtimeBroadcast) => void,
  ): () => void {
    this.broadcastHandlers.add(handler);
    return () => this.broadcastHandlers.delete(handler);
  }

  /** Register a state handler and return its unsubscribe function. */
  onStateChange(handler: (state: RealtimeState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  /** Connect or resolve immediately when already joined. */
  connect(): Promise<void> {
    if (this.deliberatelyClosed) {
      return Promise.reject(
        new OpenCloudError("OpenCloud Realtime channel is closed"),
      );
    }
    if (this.stateValue === "joined") return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    void this.open(false);
    return this.connectPromise;
  }

  /** Ensure the channel is joined and send a private broadcast. */
  async broadcast(event: string, payload: unknown): Promise<void> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/.test(event)) {
      throw new OpenCloudError("OpenCloud Realtime event name is invalid");
    }
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || !this.joinReference) {
      throw new OpenCloudError("OpenCloud Realtime channel is not joined");
    }
    socket.send(
      JSON.stringify({
        topic: await this.topic(),
        event: "broadcast",
        payload: { type: "broadcast", event, payload },
        ref: this.nextReference(),
        join_ref: this.joinReference,
      }),
    );
  }

  /** Permanently stop reconnect/heartbeat behavior and close the socket. */
  close(): void {
    this.deliberatelyClosed = true;
    this.clearTimers();
    this.socket?.close(1000, "client closed");
    this.socket = undefined;
    this.rejectPending(
      new OpenCloudError("OpenCloud Realtime channel was closed"),
    );
    this.setState("closed");
  }

  private async open(reconnecting: boolean): Promise<void> {
    try {
      this.setState(reconnecting ? "reconnecting" : "connecting");
      const [config, session] = await Promise.all([
        this.dependencies.config(),
        // Every socket/reconnect asks the broker for current token metadata.
        this.dependencies.session(reconnecting),
      ]);
      if (this.deliberatelyClosed) return;
      const runtimeOrigin = new URL(config.supabaseUrl);
      runtimeOrigin.protocol =
        runtimeOrigin.protocol === "https:" ? "wss:" : "ws:";
      runtimeOrigin.pathname = "/realtime/v1/websocket";
      runtimeOrigin.search = new URLSearchParams({
        apikey: config.supabaseAnonKey,
        vsn: "1.0.0",
      }).toString();
      const socket = new this.dependencies.WebSocket(runtimeOrigin);
      this.socket = socket;
      socket.addEventListener("open", () => {
        void this.join(socket, config.appId, session.accessToken);
      });
      socket.addEventListener("message", (event) => {
        this.handleMessage(socket, event.data);
      });
      socket.addEventListener("close", () => {
        if (socket !== this.socket) return;
        this.socket = undefined;
        this.stopHeartbeat();
        if (!this.deliberatelyClosed) this.scheduleReconnect();
      });
      socket.addEventListener("error", () => {
        if (socket === this.socket) socket.close();
      });
    } catch (error) {
      if (error instanceof OpenCloudAuthError) {
        this.rejectPending(error);
        this.setState("idle");
        return;
      }
      if (!this.deliberatelyClosed) this.scheduleReconnect();
    }
  }

  private async join(
    socket: WebSocket,
    appId: string,
    accessToken: string,
  ): Promise<void> {
    const joinReference = this.nextReference();
    this.joinReference = joinReference;
    socket.send(
      JSON.stringify({
        topic: `realtime:app:${appId}:${this.channelName}`,
        event: "phx_join",
        payload: {
          config: {
            private: true,
            broadcast: {
              ack: this.options.broadcast?.ack ?? true,
              self: this.options.broadcast?.self ?? true,
            },
            presence: { enabled: false },
            postgres_changes: [],
          },
          access_token: accessToken,
        },
        ref: joinReference,
        join_ref: joinReference,
      }),
    );
  }

  private handleMessage(socket: WebSocket, source: unknown): void {
    if (socket !== this.socket) return;
    let message: {
      event?: string;
      ref?: string;
      payload?: {
        status?: string;
        event?: string;
        payload?: unknown;
      };
    };
    try {
      const text =
        typeof source === "string"
          ? source
          : source instanceof ArrayBuffer
            ? new TextDecoder().decode(source)
            : String(source);
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (
      message.event === "phx_reply" &&
      message.ref === this.joinReference
    ) {
      if (message.payload?.status === "ok") {
        this.reconnectAttempt = 0;
        this.setState("joined");
        this.resolveConnect?.();
        this.clearPending();
        this.startHeartbeat();
      } else {
        socket.close();
      }
      return;
    }
    if (
      message.event === "broadcast" &&
      typeof message.payload?.event === "string"
    ) {
      const broadcast = {
        event: message.payload.event,
        payload: message.payload.payload,
      };
      for (const handler of this.broadcastHandlers) handler(broadcast);
    }
  }

  private async topic(): Promise<string> {
    const config = await this.dependencies.config();
    return `realtime:app:${config.appId}:${this.channelName}`;
  }

  private scheduleReconnect(): void {
    if (this.deliberatelyClosed || this.reconnectTimer) return;
    this.setState("reconnecting");
    const delay = Math.min(
      this.maxReconnectDelay,
      this.initialReconnectDelay * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.dependencies.setTimer(() => {
      this.reconnectTimer = undefined;
      void this.open(true);
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const heartbeat = () => {
      if (
        this.socket?.readyState === 1 &&
        this.stateValue === "joined"
      ) {
        this.socket.send(
          JSON.stringify({
            topic: "phoenix",
            event: "heartbeat",
            payload: {},
            ref: this.nextReference(),
          }),
        );
        this.heartbeatTimer = this.dependencies.setTimer(heartbeat, 25_000);
      }
    };
    this.heartbeatTimer = this.dependencies.setTimer(heartbeat, 25_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      this.dependencies.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer !== undefined) {
      this.dependencies.clearTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private rejectPending(error: unknown): void {
    this.rejectConnect?.(error);
    this.clearPending();
  }

  private clearPending(): void {
    this.connectPromise = undefined;
    this.resolveConnect = undefined;
    this.rejectConnect = undefined;
  }

  private setState(state: RealtimeState): void {
    if (state === this.stateValue) return;
    this.stateValue = state;
    for (const handler of this.stateHandlers) handler(state);
  }

  private nextReference(): string {
    this.reference += 1;
    return String(this.reference);
  }
}

export class OpenCloudRealtimeClient {
  constructor(private readonly client: OpenCloudBrowserClient) {}

  /** Create a private app-scoped logical channel. */
  channel(
    name: string,
    options: RealtimeChannelOptions = {},
  ): OpenCloudPrivateRealtimeChannel {
    return new OpenCloudPrivateRealtimeChannel(
      name,
      this.client.realtimeDependencies(),
      options,
    );
  }
}

export class OpenCloudBrowserClient {
  readonly rest: RuntimeResourceClient;
  readonly storage: RuntimeResourceClient;
  readonly functions: OpenCloudFunctionsClient;
  readonly realtime: OpenCloudRealtimeClient;
  readonly telemetry: OpenCloudTelemetryClient;

  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly WebSocketImplementation: typeof WebSocket;
  private readonly automaticSessionRefresh: boolean;
  private readonly now: () => number;
  private configValue: OpenCloudRuntimeConfig | undefined;
  private configPromise: Promise<OpenCloudRuntimeConfig> | undefined;
  private wireSession: WireSession | null | undefined;
  private sessionPromise: Promise<WireSession | null> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  /** Create a same-origin client. Prefer {@link createOpenCloudClient}. */
  constructor(options: OpenCloudClientOptions = {}) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    this.fetcher =
      options.fetch ??
      (typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : (() => {
            throw new OpenCloudError("fetch is not available");
          }));
    const WebSocketImplementation =
      options.WebSocket ??
      (typeof globalThis.WebSocket === "function"
        ? globalThis.WebSocket
        : undefined);
    if (!WebSocketImplementation) {
      throw new OpenCloudError("WebSocket is not available");
    }
    this.WebSocketImplementation = WebSocketImplementation;
    this.automaticSessionRefresh =
      options.automaticSessionRefresh ?? true;
    this.now = options.now ?? Date.now;
    this.rest = new RuntimeResourceClient(
      this,
      "/rest/v1",
      "authenticated",
    );
    this.storage = new RuntimeResourceClient(
      this,
      "/storage/v1",
      "authenticated",
    );
    this.functions = new OpenCloudFunctionsClient(this);
    this.realtime = new OpenCloudRealtimeClient(this);
    this.telemetry = new OpenCloudTelemetryClient((path, init = {}) => {
      const headers = new Headers(init.headers);
      if (!headers.has("accept")) headers.set("accept", "application/json");
      return this.fetcher(new URL(path, this.baseUrl), {
        ...init,
        credentials: "same-origin",
        headers,
      });
    });
  }

  /** Read and cache host-bound runtime configuration. */
  async config(): Promise<OpenCloudRuntimeConfig> {
    if (this.configValue) return { ...this.configValue };
    if (!this.configPromise) {
      this.configPromise = this.fetcher(
        new URL("/_opencloud/config", this.baseUrl),
        { credentials: "same-origin" },
      )
        .then(async (response) => {
          if (!response.ok) {
            throw new OpenCloudError(
              `OpenCloud config returned HTTP ${response.status}`,
            );
          }
          const config = parseConfig(await response.json());
          const runtimeOrigin = new URL(config.supabaseUrl).origin;
          if (runtimeOrigin !== this.baseUrl) {
            throw new OpenCloudError(
              "OpenCloud config attempted a cross-origin runtime",
            );
          }
          this.configValue = config;
          return config;
        })
        .finally(() => {
          this.configPromise = undefined;
        });
    }
    return { ...(await this.configPromise) };
  }

  /**
   * Return the safe current-user profile and exact expiry metadata.
   * Access and refresh tokens are never returned by this public API.
   */
  async session(options: { refresh?: boolean } = {}): Promise<
    OpenCloudSession | null
  > {
    const session = await this.loadSession(options.refresh ?? false);
    return session ? publicSession(session) : null;
  }

  /** @internal Used by resource namespaces to preserve SDK auth behavior. */
  async runtimeRequest(
    path: string,
    init: OpenCloudRequestInit,
    auth: OpenCloudAuthMode,
  ): Promise<Response> {
    const config = await this.config();
    const headers = new Headers(init.headers);
    headers.set("apikey", config.supabaseAnonKey);
    if (auth === "anonymous") {
      headers.set("authorization", `Bearer ${config.supabaseAnonKey}`);
    } else {
      const session = await this.loadSession(false);
      if (!session && auth === "authenticated") {
        throw new OpenCloudAuthError("An OpenCloud user session is required");
      }
      headers.set(
        "authorization",
        `Bearer ${session?.accessToken ?? config.supabaseAnonKey}`,
      );
    }
    const { auth: _ignored, ...requestInit } = init;
    const target = new URL(path, this.baseUrl);
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      target.origin !== this.baseUrl
    ) {
      throw new OpenCloudError(
        "OpenCloud runtime requests must remain same-origin",
      );
    }
    return this.fetcher(target, {
      ...requestInit,
      headers,
      credentials: "same-origin",
    });
  }

  /** Stop automatic session refresh and clear cached session state. */
  dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.wireSession = undefined;
    this.sessionPromise = undefined;
  }

  /** @internal Used by the first-party Realtime namespace. */
  realtimeDependencies(): ChannelDependencies {
    return {
      config: () => this.config(),
      session: async (forceRefresh) => {
        const session = await this.loadSession(forceRefresh);
        if (!session) {
          throw new OpenCloudAuthError(
            "An OpenCloud user session is required",
          );
        }
        return session;
      },
      WebSocket: this.WebSocketImplementation,
      setTimer: (handler, timeoutMilliseconds) =>
        globalThis.setTimeout(handler, timeoutMilliseconds),
      clearTimer: (timer) => globalThis.clearTimeout(timer),
    };
  }

  private async loadSession(forceRefresh: boolean): Promise<WireSession | null> {
    if (
      !forceRefresh &&
      this.wireSession &&
      this.now() < Date.parse(this.wireSession.refreshAfter)
    ) {
      return this.wireSession;
    }
    if (!forceRefresh && this.wireSession === null) return null;
    if (!this.sessionPromise) {
      this.sessionPromise = this.fetcher(
        new URL("/_opencloud/session/v2", this.baseUrl),
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        },
      )
        .then(async (response) => {
          if (response.status === 401) {
            this.wireSession = null;
            this.cancelRefresh();
            return null;
          }
          if (!response.ok) {
            throw new OpenCloudError(
              `OpenCloud session returned HTTP ${response.status}`,
            );
          }
          const session = parseWireSessionEnvelope(await response.json());
          if (!session) {
            this.wireSession = null;
            this.cancelRefresh();
            return null;
          }
          const config = await this.config();
          if (session.appId !== config.appId) {
            throw new OpenCloudError(
              "OpenCloud session belongs to a different app",
            );
          }
          this.wireSession = session;
          this.scheduleRefresh(session);
          return session;
        })
        .finally(() => {
          this.sessionPromise = undefined;
        });
    }
    return this.sessionPromise;
  }

  private scheduleRefresh(session: WireSession): void {
    this.cancelRefresh();
    if (!this.automaticSessionRefresh) return;
    const delay = Math.max(0, Date.parse(session.refreshAfter) - this.now());
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.loadSession(true).catch(() => {
        if (this.wireSession) {
          this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.loadSession(true);
          }, 5_000);
        }
      });
    }, Math.min(delay, 2_147_483_647));
  }

  private cancelRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }
}

/** Create one same-origin OpenCloud client for the current app. */
export function createOpenCloudClient(
  options: OpenCloudClientOptions = {},
): OpenCloudBrowserClient {
  return new OpenCloudBrowserClient(options);
}
