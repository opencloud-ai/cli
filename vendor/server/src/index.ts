/** Exact version of the Function SDK materialized with this deployment. */
export const OPEN_CLOUD_SDK_VERSION = "2.9.0";

export type OpenCloudEnvironment = "dev" | "production";

export interface OpenCloudUser {
  id: string;
}

export interface OpenCloudFunctionHttpContext {
  readonly routeId: string;
  readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly pathname: string;
  readonly params: Readonly<Record<string, string | readonly string[]>>;
  readonly query: {
    get(name: string): string | null;
    getAll(name: string): readonly string[];
    has(name: string): boolean;
    entries(): IterableIterator<readonly [string, string]>;
  };
}

/**
 * Read-only client request headers with lowercase names. OpenCloud removes
 * cookies, platform credentials, forwarding and client-address claims, and
 * connection fields. `authorization` is present only when it is not an
 * OpenCloud credential, so an app can authenticate its own users with it.
 * Header values are client input: validate them before relying on them.
 */
export interface OpenCloudRequestHeaders {
  get(name: string): string | null;
  has(name: string): boolean;
  entries(): IterableIterator<readonly [string, string]>;
}

export interface OpenCloudFunctionContext<Input> {
  input: Input;
  http: OpenCloudFunctionHttpContext | null;
  /** Client request headers for a browser, app, or routed HTTP call; `null` for platform invocations. */
  headers: OpenCloudRequestHeaders | null;
  user: OpenCloudUser | null;
  job: OpenCloudJobInvocation | null;
  /** Set when an integration provider Function runs for one connection. */
  integration: OpenCloudIntegrationInvocation | null;
  data: OpenCloudDataClient;
  files: OpenCloudFilesClient;
  ai: OpenCloudAiClient;
  email: OpenCloudEmailClient;
  notifications: OpenCloudNotificationsClient;
  jobs: OpenCloudJobsClient;
  containers: OpenCloudContainersClient;
  agentTasks: OpenCloudAgentTasksClient;
  integrations: OpenCloudIntegrationsClient;
  secrets: OpenCloudSecrets;
  log: OpenCloudLogger;
  requestId: string;
  environment: OpenCloudEnvironment;
}

export type OpenCloudFunctionResult =
  | Response
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null
  | undefined;

export interface OpenCloudAgentTaskStatus {
  id: string;
  task: string;
  state: "queued" | "running" | "processing" | "succeeded" | "partial" | "failed" | "stopped";
  total: number;
  completed: number;
  failed: number;
  createdAt: string;
  updatedAt: string;
}

export interface OpenCloudAgentTasksClient {
  /** Owner-authorized or trusted cron admission. Returns after durable enqueue. */
  start(task: string, input: {
    assignments: Array<{ id: string; input: Record<string, string | number | boolean> }>;
  }, options: { idempotencyKey: string }): Promise<{ runId: string }>;
  get(runId: string): Promise<OpenCloudAgentTaskStatus>;
}

export type OpenCloudFunctionHandler<Input> = (
  context: OpenCloudFunctionContext<Input>,
) => OpenCloudFunctionResult | Promise<OpenCloudFunctionResult>;

export interface OpenCloudFunctionDefinition<Input> {
  input: OpenCloudSchema<Input>;
  handler: OpenCloudFunctionHandler<Input>;
}

export interface OpenCloudSchema<T> {
  parse(value: unknown): T;
}

type InferSchema<T> = T extends OpenCloudSchema<infer Output> ? Output : never;
type SchemaShape = Record<string, OpenCloudSchema<unknown>>;
type InferShape<T extends SchemaShape> = {
  [Key in keyof T]: InferSchema<T[Key]>;
};

interface InternalSchema<T> extends OpenCloudSchema<T> {
  readonly optional?: true;
  readonly jsonSchema: Record<string, unknown>;
}

function makeSchema<T>(
  parse: (value: unknown, path: string) => T,
  jsonSchema: Record<string, unknown>,
  optional = false,
): InternalSchema<T> {
  return {
    ...(optional ? { optional: true as const } : {}),
    jsonSchema,
    parse: (value) => parse(value, "input"),
    _parse: parse,
  } as InternalSchema<T> & {
    _parse(value: unknown, path: string): T;
  };
}

function parseSchema<T>(
  value: unknown,
  parser: OpenCloudSchema<T>,
  path: string,
): T {
  const internal = parser as OpenCloudSchema<T> & {
    _parse?: (input: unknown, inputPath: string) => T;
  };
  return internal._parse ? internal._parse(value, path) : parser.parse(value);
}

function schemaFailure(path: string, message: string): never {
  throw new Error(`${path} ${message}`);
}

/** Small dependency-free runtime schemas for Function inputs. */
export const schema = {
  string(
    options: {
      minLength?: number;
      maxLength?: number;
      pattern?: RegExp;
    } = {},
  ): OpenCloudSchema<string> {
    return makeSchema(
      (value, path) => {
        if (typeof value !== "string") schemaFailure(path, "must be a string");
        if (
          options.minLength !== undefined &&
          value.length < options.minLength
        ) {
          schemaFailure(
            path,
            `must contain at least ${options.minLength} characters`,
          );
        }
        if (
          options.maxLength !== undefined &&
          value.length > options.maxLength
        ) {
          schemaFailure(
            path,
            `must contain at most ${options.maxLength} characters`,
          );
        }
        if (options.pattern) {
          options.pattern.lastIndex = 0;
          const matches = options.pattern.test(value);
          options.pattern.lastIndex = 0;
          if (!matches) schemaFailure(path, "has an invalid format");
        }
        return value;
      },
      {
        type: "string",
        ...(options.minLength !== undefined
          ? { minLength: options.minLength }
          : {}),
        ...(options.maxLength !== undefined
          ? { maxLength: options.maxLength }
          : {}),
        ...(options.pattern ? { pattern: options.pattern.source } : {}),
      },
    );
  },
  uuid(): OpenCloudSchema<string> {
    return makeSchema(
      (value, path) => {
        if (
          typeof value !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            value,
          )
        ) {
          schemaFailure(path, "must be a UUID");
        }
        return value;
      },
      { type: "string", format: "uuid" },
    );
  },
  number(
    options: {
      integer?: boolean;
      min?: number;
      max?: number;
    } = {},
  ): OpenCloudSchema<number> {
    return makeSchema(
      (value, path) => {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          schemaFailure(path, "must be a finite number");
        }
        if (options.integer && !Number.isInteger(value)) {
          schemaFailure(path, "must be an integer");
        }
        if (options.min !== undefined && value < options.min) {
          schemaFailure(path, `must be at least ${options.min}`);
        }
        if (options.max !== undefined && value > options.max) {
          schemaFailure(path, `must be at most ${options.max}`);
        }
        return value;
      },
      {
        type: options.integer ? "integer" : "number",
        ...(options.min !== undefined ? { minimum: options.min } : {}),
        ...(options.max !== undefined ? { maximum: options.max } : {}),
      },
    );
  },
  boolean(): OpenCloudSchema<boolean> {
    return makeSchema(
      (value, path) => {
        if (typeof value !== "boolean")
          schemaFailure(path, "must be a boolean");
        return value;
      },
      { type: "boolean" },
    );
  },
  record(): OpenCloudSchema<Record<string, unknown>> {
    return makeSchema(
      (value, path) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          schemaFailure(path, "must be an object");
        }
        return value as Record<string, unknown>;
      },
      { type: "object" },
    );
  },
  literal<const T extends string | number | boolean | null>(
    expected: T,
  ): OpenCloudSchema<T> {
    return makeSchema(
      (value, path) => {
        if (value !== expected)
          schemaFailure(path, `must equal ${String(expected)}`);
        return expected;
      },
      { const: expected },
    );
  },
  enum<const Values extends readonly [string, ...string[]]>(
    values: Values,
  ): OpenCloudSchema<Values[number]> {
    const allowed = [...new Set(values)];
    if (allowed.length !== values.length) {
      throw new Error("schema.enum values must be unique");
    }
    return makeSchema(
      (value, path) => {
        if (typeof value !== "string" || !allowed.includes(value)) {
          schemaFailure(path, `must be one of ${allowed.join(", ")}`);
        }
        return value as Values[number];
      },
      { type: "string", enum: allowed },
    );
  },
  optional<T>(inner: OpenCloudSchema<T>): OpenCloudSchema<T | undefined> {
    return makeSchema(
      (value, path) =>
        value === undefined ? undefined : parseSchema(value, inner, path),
      schemaJson(inner),
      true,
    );
  },
  nullable<T>(inner: OpenCloudSchema<T>): OpenCloudSchema<T | null> {
    return makeSchema(
      (value, path) =>
        value === null ? null : parseSchema(value, inner, path),
      { anyOf: [schemaJson(inner), { type: "null" }] },
    );
  },
  array<T>(
    inner: OpenCloudSchema<T>,
    options: { minLength?: number; maxLength?: number } = {},
  ): OpenCloudSchema<T[]> {
    return makeSchema(
      (value, path) => {
        if (!Array.isArray(value)) schemaFailure(path, "must be an array");
        if (
          options.minLength !== undefined &&
          value.length < options.minLength
        ) {
          schemaFailure(
            path,
            `must contain at least ${options.minLength} items`,
          );
        }
        if (
          options.maxLength !== undefined &&
          value.length > options.maxLength
        ) {
          schemaFailure(
            path,
            `must contain at most ${options.maxLength} items`,
          );
        }
        return value.map((item, index) =>
          parseSchema(item, inner, `${path}[${index}]`),
        );
      },
      {
        type: "array",
        items: schemaJson(inner),
        ...(options.minLength !== undefined
          ? { minItems: options.minLength }
          : {}),
        ...(options.maxLength !== undefined
          ? { maxItems: options.maxLength }
          : {}),
      },
    );
  },
  object<const Shape extends SchemaShape>(
    shape: Shape,
  ): OpenCloudSchema<InferShape<Shape>> {
    return makeSchema(
      (value, path) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          schemaFailure(path, "must be an object");
        }
        const record = value as Record<string, unknown>;
        const unknown = Object.keys(record).filter((key) => !(key in shape));
        if (unknown.length) {
          schemaFailure(path, `contains unknown field ${unknown[0]}`);
        }
        const output: Record<string, unknown> = {};
        for (const [key, parser] of Object.entries(shape)) {
          if (
            !(key in record) &&
            !(parser as InternalSchema<unknown>).optional
          ) {
            schemaFailure(`${path}.${key}`, "is required");
          }
          output[key] = parseSchema(record[key], parser, `${path}.${key}`);
        }
        return output as InferShape<Shape>;
      },
      {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(shape).map(([key, parser]) => [
            key,
            schemaJson(parser),
          ]),
        ),
        required: Object.entries(shape)
          .filter(([, parser]) => !(parser as InternalSchema<unknown>).optional)
          .map(([key]) => key),
        additionalProperties: false,
      },
    );
  },
};

function schemaJson(value: OpenCloudSchema<unknown>): Record<string, unknown> {
  const jsonSchema = (value as Partial<InternalSchema<unknown>>).jsonSchema;
  if (
    !jsonSchema ||
    typeof jsonSchema !== "object" ||
    Array.isArray(jsonSchema)
  ) {
    throw new Error("Use a schema from @opencloud/server schema helpers");
  }
  return jsonSchema;
}

function aiOutputSchema(
  value: OpenCloudSchema<unknown>,
): Record<string, unknown> {
  return strictAiOutputSchema(schemaJson(value));
}

function strictAiOutputSchema(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...value };
  if (isSchemaRecord(value.items)) {
    output.items = strictAiOutputSchema(value.items);
  }
  if (Array.isArray(value.anyOf)) {
    output.anyOf = value.anyOf.map((entry) =>
      isSchemaRecord(entry) ? strictAiOutputSchema(entry) : entry,
    );
  }
  if (value.type !== "object" || !isSchemaRecord(value.properties)) {
    return output;
  }

  const required = new Set(
    Array.isArray(value.required)
      ? value.required.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  );
  const properties = Object.fromEntries(
    Object.entries(value.properties).map(([key, property]) => {
      if (!isSchemaRecord(property)) return [key, property];
      const normalized = strictAiOutputSchema(property);
      return [
        key,
        required.has(key) || acceptsNull(property)
          ? normalized
          : { anyOf: [normalized, { type: "null" }] },
      ];
    }),
  );
  output.properties = properties;
  output.required = Object.keys(properties);
  return output;
}

function normalizeAiOutput(
  value: unknown,
  schemaValue: Record<string, unknown>,
): unknown {
  if (value === null) return value;
  if (Array.isArray(value) && isSchemaRecord(schemaValue.items)) {
    return value.map((entry) =>
      normalizeAiOutput(entry, schemaValue.items as Record<string, unknown>),
    );
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    schemaValue.type === "object" &&
    isSchemaRecord(schemaValue.properties)
  ) {
    const required = new Set(
      Array.isArray(schemaValue.required)
        ? schemaValue.required.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
    );
    const output = { ...(value as Record<string, unknown>) };
    for (const [key, property] of Object.entries(schemaValue.properties)) {
      if (!(key in output) || !isSchemaRecord(property)) continue;
      if (
        output[key] === null &&
        !required.has(key) &&
        !acceptsNull(property)
      ) {
        delete output[key];
      } else {
        output[key] = normalizeAiOutput(output[key], property);
      }
    }
    return output;
  }
  if (Array.isArray(schemaValue.anyOf)) {
    const branch = schemaValue.anyOf.find(
      (entry) => isSchemaRecord(entry) && entry.type !== "null",
    );
    if (isSchemaRecord(branch)) return normalizeAiOutput(value, branch);
  }
  return value;
}

function acceptsNull(value: Record<string, unknown>): boolean {
  if (value.type === "null" || value.const === null) return true;
  if (Array.isArray(value.type) && value.type.includes("null")) return true;
  return (
    Array.isArray(value.anyOf) &&
    value.anyOf.some((entry) => isSchemaRecord(entry) && acceptsNull(entry))
  );
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class OpenCloudError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      code: string;
      status?: number;
      requestId?: string | null;
      details?: unknown;
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "OpenCloudError";
    this.code = options.code;
    this.status = options.status ?? 500;
    this.requestId = options.requestId ?? null;
    this.details = options.details;
    this.retryable =
      options.retryable ?? (this.status === 429 || this.status >= 500);
  }
}

function functionError(
  status: 400 | 401 | 403 | 404 | 409 | 503,
  retryable: boolean,
  code: string,
  message: string,
  details?: unknown,
): OpenCloudError {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) {
    throw new OpenCloudError("Function error code is invalid", {
      code: "INVALID_ERROR_CODE",
      status: 500,
    });
  }
  return new OpenCloudError(message, { status, code, details, retryable });
}

/** Named application errors avoid hand-authored HTTP status values. */
export const errors = {
  badRequest: (code: string, message: string, details?: unknown) =>
    functionError(400, false, code, message, details),
  unauthorized: (code: string, message: string, details?: unknown) =>
    functionError(401, false, code, message, details),
  forbidden: (code: string, message: string, details?: unknown) =>
    functionError(403, false, code, message, details),
  notFound: (code: string, message: string, details?: unknown) =>
    functionError(404, false, code, message, details),
  conflict: (code: string, message: string, details?: unknown) =>
    functionError(409, false, code, message, details),
  unavailable: (code: string, message: string, details?: unknown) =>
    functionError(503, true, code, message, details),
} as const;

export interface OpenCloudLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface OpenCloudSecrets {
  get(name: string): string | undefined;
  require(name: string): string;
}

export type OpenCloudValue = string | number | boolean | null;
export type OpenCloudId = string | number;
export type OpenCloudWhere = Readonly<Record<string, OpenCloudValue>>;

export interface OpenCloudListOptions {
  select?: readonly string[];
  where?: OpenCloudWhere;
  orderBy?: {
    column: string;
    direction?: "asc" | "desc";
  };
  limit?: number;
  offset?: number;
}

export interface OpenCloudCompareAndSetResult<T> {
  updated: boolean;
  record: T | null;
}

export interface OpenCloudTableClient {
  list<T extends Record<string, unknown> = Record<string, unknown>>(
    options?: OpenCloudListOptions,
  ): Promise<T[]>;
  getById<T extends Record<string, unknown> = Record<string, unknown>>(
    id: OpenCloudId,
    options?: { select?: readonly string[] },
  ): Promise<T | null>;
  create<T extends Record<string, unknown> = Record<string, unknown>>(
    value: Record<string, unknown>,
  ): Promise<T>;
  createMany<T extends Record<string, unknown> = Record<string, unknown>>(
    values: readonly Record<string, unknown>[],
  ): Promise<T[]>;
  updateById<T extends Record<string, unknown> = Record<string, unknown>>(
    id: OpenCloudId,
    changes: Record<string, unknown>,
  ): Promise<T | null>;
  deleteById<T extends Record<string, unknown> = Record<string, unknown>>(
    id: OpenCloudId,
  ): Promise<boolean>;
  compareAndSet<T extends Record<string, unknown> = Record<string, unknown>>(
    id: OpenCloudId,
    expected: OpenCloudWhere,
    changes: Record<string, unknown>,
  ): Promise<OpenCloudCompareAndSetResult<T>>;
}

export interface OpenCloudDataClient {
  table(name: string): OpenCloudTableClient;
  search(name: string, options: DataSearchRequest): Promise<DataSearchResponse>;
  /**
   * Act as one of the app's own users after the Function has authenticated
   * them, for an app that manages its own sign-in. RLS policies see the ID
   * through `auth.app_user_id()`; `auth.uid()` stays null. Requires a public
   * app. The ID is 1 to 255 visible ASCII characters.
   */
  asAppUser(appUserId: string): OpenCloudAppUserDataClient;
}

/** Data access as one app-managed user; see `OpenCloudDataClient.asAppUser`. */
export interface OpenCloudAppUserDataClient {
  readonly appUserId: string;
  table(name: string): OpenCloudTableClient;
  search(name: string, options: DataSearchRequest): Promise<DataSearchResponse>;
}

export interface DataSearchDeclaration {
  name: string;
  table: string;
  select: string[];
  filterColumns?: string[];
  fullText?: { column: string; language: "english" | "simple" };
  vector?: { column: string; dimensions: number; metric: "cosine"; model: string };
}
export type DataSearchRequest = (
  | { mode: "fullText"; query: string }
  | { mode: "vector"; vector: number[]; model: string }
  | { mode: "hybrid"; query: string; vector: number[]; model: string }
) & { where?: OpenCloudWhere; limit?: number };
export interface DataSearchHit {
  record: Record<string, unknown>;
  fullTextScore: number | null;
  fullTextRank: number | null;
  vectorDistance: number | null;
  vectorSimilarity: number | null;
  vectorRank: number | null;
  fusionScore: number | null;
}
export type DataSearchResponse = { hits: DataSearchHit[] };
export type DataSearchRuntimeBinding = { name: string; rpcName: string; declaration: DataSearchDeclaration }[];

export interface OpenCloudFileRef {
  id: string;
}

export interface OpenCloudFile extends OpenCloudFileRef {
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
  updatedAt: string;
}

export interface OpenCloudFileDownload<Data = Uint8Array> {
  data: Data;
  contentType: string;
  name: string;
  size: number;
}

export type OpenCloudFileData = Blob | ArrayBuffer | Uint8Array | string;

export interface OpenCloudFileInput {
  data: OpenCloudFileData;
  name?: string;
  contentType?: string;
}

export interface OpenCloudFileUploadInput {
  workloadName: string; name: string; contentType: string;
  sizeBytes: string; sha256: string; idempotencyKey: string;
}
export interface OpenCloudFileUploadSession {
  uploadSessionId: string; fileId: string; path: string; sizeBytes: string; sha256: string;
  offsetBytes: string; chunkBytes: number;
  state: "uploading" | "complete" | "published" | "aborted";
  expiresAt: string;
}

export interface OpenCloudFilesClient {
  upload(input: OpenCloudFileInput): Promise<OpenCloudFile>;
  beginUpload(input: OpenCloudFileUploadInput): Promise<OpenCloudFileUploadSession>;
  uploadStatus(uploadSessionId: string): Promise<OpenCloudFileUploadSession>;
  uploadChunk(uploadSessionId: string, input: { offsetBytes: string; data: Uint8Array; sha256: string }): Promise<OpenCloudFileUploadSession>;
  completeUpload(uploadSessionId: string): Promise<OpenCloudFileUploadSession>;
  abortUpload(uploadSessionId: string): Promise<void>;
  info(file: OpenCloudFileRef | string): Promise<OpenCloudFile>;
  download(file: OpenCloudFileRef | string): Promise<OpenCloudFileDownload>;
  downloadStream(file: OpenCloudFileRef | string): Promise<OpenCloudFileDownload<ReadableStream<Uint8Array>>>;
  replace(
    file: OpenCloudFileRef | string,
    input: OpenCloudFileInput,
  ): Promise<OpenCloudFile>;
  remove(file: OpenCloudFileRef | string): Promise<void>;
}

export type OpenCloudReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type OpenCloudAiImageContentType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

export type OpenCloudAiImageDetail = "auto" | "low" | "high" | "original";

export interface OpenCloudAiImageAttachment {
  type: "image";
  data: Uint8Array;
  contentType: OpenCloudAiImageContentType;
  detail?: OpenCloudAiImageDetail;
}

export interface OpenCloudAiFileAttachment {
  type: "file";
  file: OpenCloudFileRef | string;
  detail?: OpenCloudAiImageDetail;
}

export type OpenCloudAiAttachment =
  | OpenCloudAiImageAttachment
  | OpenCloudAiFileAttachment;

export interface OpenCloudGenerateTextInput {
  prompt: string;
  instructions?: string;
  reasoningEffort?: OpenCloudReasoningEffort;
  attachments?: OpenCloudAiAttachment[];
  /**
   * A model switched on for the provider that pays for the app's automatic
   * tasks (App → AI), such as `claude-haiku-5-5`. It runs on that same
   * provider; a model it can't run fails with `ai_model_unavailable` and is
   * never swapped for another. Omit it to use the model for automatic tasks.
   * Added in SDK 2.8.0.
   */
  model?: string;
}

export interface OpenCloudGenerateObjectInput<Output>
  extends OpenCloudGenerateTextInput {
  schema: OpenCloudSchema<Output>;
}

export interface OpenCloudGenerateImageInput {
  prompt: string;
}

export interface OpenCloudGeneratedImage {
  data: Uint8Array;
  contentType: "image/png";
  revisedPrompt: string | null;
}

export interface OpenCloudAiClient {
  generateText(input: OpenCloudGenerateTextInput): Promise<string>;
  streamText(
    input: OpenCloudGenerateTextInput,
  ): Promise<ReadableStream<Uint8Array>>;
  generateObject<Output>(
    input: OpenCloudGenerateObjectInput<Output>,
  ): Promise<Output>;
  generateImage(
    input: OpenCloudGenerateImageInput,
  ): Promise<OpenCloudGeneratedImage>;
}

export interface OpenCloudEmailAttachment {
  name: string;
  content: string;
  contentType: string;
  cid?: string;
}

export interface OpenCloudEmailSendInput {
  /** A manifest-declared email alias, not an arbitrary address. */
  from: string;
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  listUnsubscribe?: string;
  attachments?: OpenCloudEmailAttachment[];
  tags?: string[];
}

export type OpenCloudEmailSendStatus =
  | "pending"
  | "queued"
  | "captured"
  | "delivered"
  | "deferred"
  | "bounced"
  | "spam"
  | "failed"
  | (string & {});

export interface OpenCloudEmailSendResult {
  id: string;
  providerId: string | null;
  status: OpenCloudEmailSendStatus;
  from: string;
  replyTo: string | null;
  idempotent: boolean;
}

export interface OpenCloudEmailClient {
  send(
    input: OpenCloudEmailSendInput,
    options: { idempotencyKey: string; timeoutMs?: number },
  ): Promise<OpenCloudEmailSendResult>;
}

export interface OpenCloudNotificationSendInput {
  /** The authenticated app user whose active browser subscriptions are targeted. */
  userId: string;
  title: string;
  body?: string;
  /** A same-origin absolute path opened when the notification is selected. */
  path?: string;
  /** A same-origin icon path overriding notifications.icon for this message. */
  icon?: string;
}

export type OpenCloudNotificationSendStatus =
  | "queued"
  | "captured"
  | "no_subscribers"
  | "accepted"
  | "partial"
  | "failed";

export interface OpenCloudNotificationSendResult {
  id: string;
  status: OpenCloudNotificationSendStatus;
  recipientCount: number;
  acceptedCount: number;
  failedCount: number;
  idempotent: boolean;
}

export interface OpenCloudNotificationsClient {
  send(
    input: OpenCloudNotificationSendInput,
    options: { idempotencyKey: string; timeoutMs?: number },
  ): Promise<OpenCloudNotificationSendResult>;
}

export interface OpenCloudJobInvocation {
  id: string;
  queue: string;
  attempt: number;
}

export type OpenCloudIntegrationTrigger = "operation" | "sync" | "webhook" | "oauth";

export interface OpenCloudIntegrationEvent {
  /** A type declared under provides.integration.events. */
  type: string;
  /** The provider's stable ID for this occurrence; delivery is idempotent per ID. */
  id: string;
  data?: Record<string, unknown>;
  occurredAt?: string | Date;
}

/**
 * The connection a provider Function acts for. Partition connection data with
 * `connectionId` (or `auth.connection_id()` in SQL policies).
 */
export interface OpenCloudIntegrationInvocation {
  readonly connectionId: string;
  readonly trigger: OpenCloudIntegrationTrigger;
  /** The consumer's operation, for trigger "operation". */
  readonly operation: string | null;
  /** The consuming app, for trigger "operation". */
  readonly consumerAppId: string | null;
  /**
   * Records a declared event for this connection and delivers it at least once
   * to every subscribed consumer. Unavailable during OAuth token exchange.
   */
  emit(event: OpenCloudIntegrationEvent): Promise<{ deliveries: number }>;
}

export type OpenCloudJobState =
  "queued" | "running" | "retry_wait" | "succeeded" | "dead_lettered";

export interface OpenCloudJob {
  id: string;
  queue: string;
  state: OpenCloudJobState;
  attempt: number;
  maxAttempts: number;
  runAt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastError: Record<string, unknown> | null;
}

export interface OpenCloudEnqueuedJob extends OpenCloudJob {
  idempotent: boolean;
}

export interface OpenCloudJobsClient {
  enqueue(
    queue: string,
    input: Record<string, unknown>,
    options: {
      idempotencyKey: string;
      delaySeconds?: number;
      files?: { read: string[] };
      timeoutMs?: number;
    },
  ): Promise<OpenCloudEnqueuedJob>;
  get(id: string, options?: { timeoutMs?: number }): Promise<OpenCloudJob>;
}

export type OpenCloudContainerJson = null | boolean | number | string | OpenCloudContainerJson[] | { [key: string]: OpenCloudContainerJson };
export type OpenCloudContainerState = "queued" | "preparing" | "starting" | "running" | "retry_wait" | "collecting" | "cancelling" | "succeeded" | "failed" | "timed_out" | "cancelled" | "outcome_unknown";
/** Why a waiting job hasn't started yet, as the platform last found it. */
export type OpenCloudContainerWaitReason =
  | "no_capacity"
  | "host_unavailable"
  | "capacity_limit"
  | "budget"
  | "concurrency"
  | "paused"
  | "previous_attempt"
  | "app_busy"
  | "platform_error";
/** The platform's container error codes. A newer platform may add codes. */
export type OpenCloudContainerErrorCode =
  | "COMPUTE_NOT_ENABLED"
  | "COMPUTE_NOT_OFFERED"
  | "COMPUTE_BILLING_UNAVAILABLE"
  | "COMPUTE_PAYMENT_REQUIRED"
  | "COMPUTE_BUDGET_EXCEEDED"
  | "COMPUTE_CAPACITY_EXCEEDED"
  | "COMPUTE_QUEUE_FULL"
  | "COMPUTE_NO_CAPACITY"
  | "COMPUTE_HOST_UNAVAILABLE"
  | "COMPUTE_INVALID_DEFINITION"
  | "COMPUTE_UNSUPPORTED_IMAGE"
  | "COMPUTE_IMAGE_TOO_LARGE"
  | "COMPUTE_REVISION_UNAVAILABLE"
  | "COMPUTE_RELEASE_REPLACED"
  | "COMPUTE_REVISION_CONFLICT"
  | "COMPUTE_IDEMPOTENCY_CONFLICT"
  | "COMPUTE_AUTHORITY_REVOKED"
  | "COMPUTE_CAPABILITY_INVALID"
  | "COMPUTE_NOT_LIVE"
  | "COMPUTE_METRIC_INVALID"
  | "COMPUTE_METRIC_LIMIT"
  | "COMPUTE_NOT_FOUND"
  | "COMPUTE_CANCEL_PRODUCER_ONLY"
  | "COMPUTE_PROTOCOL_UNSUPPORTED"
  | "COMPUTE_IMAGE_NOT_FOUND"
  | "COMPUTE_IMAGE_ACCESS_DENIED"
  | "COMPUTE_IMAGE_PULL_FAILED"
  | "COMPUTE_INPUT_UNAVAILABLE"
  | "COMPUTE_INPUT_TRANSFER_FAILED"
  | "COMPUTE_QUEUE_TIMEOUT"
  | "COMPUTE_STARTUP_FAILED"
  | "COMPUTE_STARTUP_TIMEOUT"
  | "COMPUTE_EXIT_NONZERO"
  | "COMPUTE_OUT_OF_MEMORY"
  | "COMPUTE_SCRATCH_EXHAUSTED"
  | "COMPUTE_TIMEOUT"
  | "COMPUTE_CANCELLED"
  | "COMPUTE_OUTPUT_INVALID"
  | "COMPUTE_OUTPUT_DIRECTORY_MISSING"
  | "COMPUTE_OUTPUT_COLLECTION_FAILED"
  | "COMPUTE_COMPLETION_FAILED"
  | "COMPUTE_OUTCOME_UNKNOWN"
  | "COMPUTE_WORKER_LOST"
  | "COMPUTE_LEASE_EXPIRED"
  | "COMPUTE_RUNTIME_UNAVAILABLE"
  | "COMPUTE_STOP_FAILED"
  | "COMPUTE_STARTING_PENDING"
  | "COMPUTE_SERVICE_UNAVAILABLE"
  | "COMPUTE_CONCURRENCY_EXCEEDED"
  | "COMPUTE_REQUEST_TOO_LARGE"
  | "COMPUTE_REQUEST_HEADERS_TOO_LARGE"
  | "COMPUTE_REQUEST_TIMEOUT"
  | "COMPUTE_UPSTREAM_FAILED"
  | "COMPUTE_FUNCTION_FAILED"
  | "COMPUTE_READINESS_FAILED"
  | "COMPUTE_LIVENESS_FAILED"
  | "COMPUTE_CRASH_LOOP"
  | "COMPUTE_EGRESS_DENIED"
  | "COMPUTE_EGRESS_LIMIT"
  | "COMPUTE_METER_CONFLICT"
  | "COMPUTE_METERING_UNAVAILABLE"
  | "COMPUTE_PRICE_INVALID"
  | "COMPUTE_PRICE_VERSION_CONFLICT"
  | "COMPUTE_BILLING_EXPORT_FAILED"
  | "COMPUTE_BILLING_MISMATCH"
  | "COMPUTE_INTERNAL_ERROR"
  | (string & {});
export interface OpenCloudContainerError {
  statusCode: number;
  code: OpenCloudContainerErrorCode;
  message: string;
  /** Its classification (`retryable`, `phase`, ...) and facts such as `exitCode` or `upstreamStatus`. */
  details: Readonly<Record<string, unknown>>;
}
export interface OpenCloudContainerExecution {
  executionId: string;
  workloadName: string;
  revisionId: string;
  environment: "production" | "development";
  developmentSessionId: string | null;
  state: OpenCloudContainerState;
  /** Set while the job waits to start (`queued`, `retry_wait`); otherwise null. */
  waitReason: OpenCloudContainerWaitReason | null;
  acceptedAt: string;
  queueDeadline: string;
  statusUrl: string;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  executionDeadline: string | null;
  phaseDeadline: string | null;
  error: OpenCloudContainerError | null;
  outputFileIds: string[];
  completionDelivery: { state: "not_configured" | "pending" | "retry_wait" | "delivered" | "failed" | "revoked"; attempts: number; lastAttemptAt: string | null; nextAttemptAt: string | null; error: OpenCloudContainerError | null };
  usage: {
    quantities: { vcpuSeconds: string; memoryGiBSeconds: string; scratchGiBSeconds: string };
    currency: string | null;
    grossEstimatedCostMinor: string | null;
    appliedCreditMinor: string | null;
    netEstimatedCostMinor: string | null;
    priceVersionIds: string[];
    pendingEvidenceCount: number;
    lastSettledAt: string | null;
    observedAt: string;
  };
}
export interface OpenCloudContainersClient {
  run(name: string, input: OpenCloudContainerJson, options: { idempotencyKey: string; inputFileIds?: string[]; timeoutMs?: number }): Promise<OpenCloudContainerExecution>;
  get(executionId: string, options?: { timeoutMs?: number }): Promise<OpenCloudContainerExecution>;
  cancel(executionId: string, options: { idempotencyKey: string; timeoutMs?: number }): Promise<OpenCloudContainerExecution>;
  request(name: string, input: {
    path: string; method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
    headers?: Record<string, string>; body?: Uint8Array | string;
  }, options?: { timeoutMs?: number }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
}

export interface OpenCloudInboundEmailEvent {
  source: "opencloud.email";
  type: "email.received";
  version: 1;
  id: string;
  address: { name: string; value: string };
  message: Record<string, unknown>;
  receivedAt: string;
}

export interface OpenCloudIntegrationBinding {
  id: string;
  integrationName: string;
  label: string;
  status: "active" | "reconnect_required" | "revoked" | null;
}

export interface OpenCloudCalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  start: string;
  end: string;
  status: string;
  htmlLink: string | null;
}

export interface OpenCloudIntegrationBindingInput {
  bindingId?: string;
}

export interface OpenCloudIntegrationCallOptions {
  bindingId?: string;
}

export interface OpenCloudIntegrationClient {
  /** Lists the exact resources currently bound to this integration slot. */
  bindings(): Promise<OpenCloudIntegrationBinding[]>;
  /**
   * Calls a bounded OpenCloud operation declared by the selected integration.
   * The platform validates the provider, capability, binding, and input.
   */
  call<Output = unknown>(
    operation: string,
    input?: Record<string, unknown>,
    options?: OpenCloudIntegrationCallOptions,
  ): Promise<Output>;
}

export type OpenCloudSlackTriggerMode = "mention" | "all_messages";

export interface OpenCloudSlackBinding extends OpenCloudIntegrationBinding {
  triggerMode: OpenCloudSlackTriggerMode | null;
}

export interface OpenCloudSlackSendMessageInput extends OpenCloudIntegrationBindingInput {
  text: string;
  threadTimestamp?: string;
}

export interface OpenCloudSlackSentMessage {
  bindingId: string;
  timestamp: string;
  threadTimestamp: string | null;
  appName: string;
}

export interface OpenCloudSlackMessageEvent {
  source: "opencloud.slack";
  type: "slack.message.received";
  version: 1;
  id: string;
  channel: { label: string };
  sender: { id: string };
  message: {
    text: string;
    timestamp: string;
    threadTimestamp: string | null;
    mentionedOpenCloud: boolean;
  };
  binding: {
    id: string;
    integrationName: string;
    triggerMode: OpenCloudSlackTriggerMode;
  };
  receivedAt: string;
}

export interface OpenCloudSlackClient {
  bindings(): Promise<OpenCloudSlackBinding[]>;
  sendMessage(
    input: OpenCloudSlackSendMessageInput,
  ): Promise<OpenCloudSlackSentMessage>;
}

export type OpenCloudTelegramTriggerMode = "directed" | "all_messages";
export type OpenCloudTelegramChatType = "private" | "group" | "supergroup";

export interface OpenCloudTelegramBinding extends OpenCloudIntegrationBinding {
  triggerMode: OpenCloudTelegramTriggerMode | null;
}

export interface OpenCloudTelegramSendMessageInput extends OpenCloudIntegrationBindingInput {
  text: string;
  messageThreadId?: number;
  replyToMessageId?: number;
}

export interface OpenCloudTelegramSentMessage {
  bindingId: string;
  messageId: number;
  messageThreadId: number | null;
  appName: string;
}

export interface OpenCloudTelegramMessageEvent {
  source: "opencloud.telegram";
  type: "telegram.message.received";
  version: 1;
  id: string;
  chat: {
    label: string;
    type: OpenCloudTelegramChatType;
  };
  sender: { id: string };
  message: {
    text: string;
    messageId: number;
    messageThreadId: number | null;
    replyToMessageId: number | null;
    directedAtOpenCloud: boolean;
    sentAt: string;
  };
  binding: {
    id: string;
    integrationName: string;
    triggerMode: OpenCloudTelegramTriggerMode;
  };
  receivedAt: string;
}

export interface OpenCloudTelegramClient {
  bindings(): Promise<OpenCloudTelegramBinding[]>;
  sendMessage(
    input: OpenCloudTelegramSendMessageInput,
  ): Promise<OpenCloudTelegramSentMessage>;
}

export type OpenCloudCrmObjectType = "contacts" | "companies" | "deals";
export type OpenCloudCrmAssociationObjectType =
  OpenCloudCrmObjectType | "notes";
export type OpenCloudCrmFilterOperator =
  | "EQ"
  | "NEQ"
  | "LT"
  | "LTE"
  | "GT"
  | "GTE"
  | "BETWEEN"
  | "IN"
  | "NOT_IN"
  | "HAS_PROPERTY"
  | "NOT_HAS_PROPERTY"
  | "CONTAINS_TOKEN"
  | "NOT_CONTAINS_TOKEN";

export interface OpenCloudCrmRecord {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string | null;
  updatedAt: string | null;
  archived: boolean;
  isNew: boolean | null;
}

export interface OpenCloudCrmFilter {
  propertyName: string;
  operator: OpenCloudCrmFilterOperator;
  value?: string;
  values?: string[];
  highValue?: string;
}

export interface OpenCloudCrmGetRecordInput extends OpenCloudIntegrationBindingInput {
  recordId: string;
  properties?: string[];
  idProperty?: string;
}

export interface OpenCloudCrmSearchInput extends OpenCloudIntegrationBindingInput {
  query?: string;
  filterGroups?: Array<{ filters: OpenCloudCrmFilter[] }>;
  sorts?: string[];
  properties?: string[];
  limit?: number;
  after?: string;
}

export interface OpenCloudCrmSearchResult {
  records: OpenCloudCrmRecord[];
  total: number;
  nextAfter: string | null;
}

export interface OpenCloudCrmCreateRecordInput extends OpenCloudIntegrationBindingInput {
  properties: Record<string, string>;
}

export interface OpenCloudCrmUpdateRecordInput extends OpenCloudCrmCreateRecordInput {
  recordId: string;
  idProperty?: string;
}

export interface OpenCloudCrmUpsertRecordInput extends OpenCloudCrmCreateRecordInput {
  id: string;
  idProperty: string;
}

export interface OpenCloudCrmObjectClient {
  get(input: OpenCloudCrmGetRecordInput): Promise<OpenCloudCrmRecord>;
  search(input?: OpenCloudCrmSearchInput): Promise<OpenCloudCrmSearchResult>;
  create(input: OpenCloudCrmCreateRecordInput): Promise<OpenCloudCrmRecord>;
  update(input: OpenCloudCrmUpdateRecordInput): Promise<OpenCloudCrmRecord>;
  upsert(input: OpenCloudCrmUpsertRecordInput): Promise<OpenCloudCrmRecord>;
}

export interface OpenCloudCrmOwner {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  archived: boolean;
  teams: Array<{ id: string; name: string; primary: boolean }>;
}

export interface OpenCloudCrmListOwnersInput extends OpenCloudIntegrationBindingInput {
  limit?: number;
  after?: string;
  archived?: boolean;
}

export interface OpenCloudCrmOwnersClient {
  list(
    input?: OpenCloudCrmListOwnersInput,
  ): Promise<{ owners: OpenCloudCrmOwner[]; nextAfter: string | null }>;
}

export interface OpenCloudCrmPipeline {
  id: string;
  label: string;
  displayOrder: number;
  archived: boolean;
  stages: Array<{
    id: string;
    label: string;
    displayOrder: number;
    archived: boolean;
    metadata: Record<string, string | null>;
  }>;
}

export interface OpenCloudCrmPipelinesClient {
  listDeals(
    input?: OpenCloudIntegrationBindingInput,
  ): Promise<{ pipelines: OpenCloudCrmPipeline[] }>;
}

export interface OpenCloudCrmCreateNoteInput extends OpenCloudIntegrationBindingInput {
  body: string;
  timestamp?: string;
  ownerId?: string;
}

export interface OpenCloudCrmNotesClient {
  create(input: OpenCloudCrmCreateNoteInput): Promise<OpenCloudCrmRecord>;
}

export interface OpenCloudCrmCreateAssociationInput extends OpenCloudIntegrationBindingInput {
  fromObjectType: OpenCloudCrmAssociationObjectType;
  fromRecordId: string;
  toObjectType: OpenCloudCrmAssociationObjectType;
  toRecordId: string;
}

export interface OpenCloudCrmAssociationsClient {
  create(
    input: OpenCloudCrmCreateAssociationInput,
  ): Promise<{ associated: true }>;
}

export interface OpenCloudCrmClient {
  bindings(): Promise<OpenCloudIntegrationBinding[]>;
  contacts: OpenCloudCrmObjectClient;
  companies: OpenCloudCrmObjectClient;
  deals: OpenCloudCrmObjectClient;
  owners: OpenCloudCrmOwnersClient;
  pipelines: OpenCloudCrmPipelinesClient;
  notes: OpenCloudCrmNotesClient;
  associations: OpenCloudCrmAssociationsClient;
}

export interface OpenCloudCalendarBindingInput extends OpenCloudIntegrationBindingInput {}

export interface OpenCloudCalendarListEventsInput extends OpenCloudCalendarBindingInput {
  from: string;
  to: string;
  maxResults?: number;
  pageToken?: string;
}

export interface OpenCloudCalendarListEventsResult {
  events: OpenCloudCalendarEvent[];
  nextPageToken: string | null;
}

export interface OpenCloudCalendarCreateEventInput extends OpenCloudCalendarBindingInput {
  summary: string;
  description?: string;
  start: string;
  end: string;
  timeZone?: string;
}

export interface OpenCloudCalendarClient {
  bindings(): Promise<OpenCloudIntegrationBinding[]>;
  listEvents(
    input: OpenCloudCalendarListEventsInput,
  ): Promise<OpenCloudCalendarListEventsResult>;
  createEvent(
    input: OpenCloudCalendarCreateEventInput,
  ): Promise<OpenCloudCalendarEvent>;
}

export interface OpenCloudDriveFile {
  id: string;
  name: string;
  mimeType: string;
  description: string | null;
  parents: string[];
  webViewLink: string | null;
  size: number | null;
  createdTime: string | null;
  modifiedTime: string | null;
  trashed: boolean;
}

export interface OpenCloudDriveListFilesInput extends OpenCloudIntegrationBindingInput {
  pageSize?: number;
  pageToken?: string;
  nameContains?: string;
  mimeType?: string;
  parentId?: string;
}

export interface OpenCloudDriveListFilesResult {
  files: OpenCloudDriveFile[];
  nextPageToken: string | null;
  incompleteSearch: boolean;
}

export interface OpenCloudDriveGetFileInput extends OpenCloudIntegrationBindingInput {
  fileId: string;
}

export interface OpenCloudDriveCreateFolderInput extends OpenCloudIntegrationBindingInput {
  name: string;
  parentId?: string;
}

export interface OpenCloudDriveCreateFileInput extends OpenCloudDriveCreateFolderInput {
  content: string;
  contentType: string;
  description?: string;
}

export interface OpenCloudDriveClient {
  bindings(): Promise<OpenCloudIntegrationBinding[]>;
  listFiles(
    input?: OpenCloudDriveListFilesInput,
  ): Promise<OpenCloudDriveListFilesResult>;
  getFile(input: OpenCloudDriveGetFileInput): Promise<OpenCloudDriveFile>;
  createFile(input: OpenCloudDriveCreateFileInput): Promise<OpenCloudDriveFile>;
  createFolder(
    input: OpenCloudDriveCreateFolderInput,
  ): Promise<OpenCloudDriveFile>;
}

export type OpenCloudGoogleCellValue = string | number | boolean | null;

export interface OpenCloudSpreadsheet {
  id: string;
  title: string;
  url: string | null;
  locale: string | null;
  timeZone: string | null;
  sheets: Array<{
    id: number;
    title: string;
    index: number;
    type: string;
    rowCount: number | null;
    columnCount: number | null;
  }>;
}

export interface OpenCloudSpreadsheetBindingInput extends OpenCloudIntegrationBindingInput {
  spreadsheetId: string;
}

export interface OpenCloudCreateSpreadsheetInput extends OpenCloudIntegrationBindingInput {
  title: string;
  sheetTitles?: string[];
}

export interface OpenCloudSheetValuesInput extends OpenCloudSpreadsheetBindingInput {
  range: string;
  majorDimension?: "ROWS" | "COLUMNS";
}

export interface OpenCloudSheetGetValuesInput extends OpenCloudSheetValuesInput {
  valueRenderOption?: "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA";
}

export interface OpenCloudSheetWriteValuesInput extends OpenCloudSheetValuesInput {
  values: OpenCloudGoogleCellValue[][];
  valueInputOption?: "RAW" | "USER_ENTERED";
}

export interface OpenCloudSheetValueRange {
  range: string;
  majorDimension: "ROWS" | "COLUMNS";
  values: OpenCloudGoogleCellValue[][];
}

export interface OpenCloudSheetValuesUpdate {
  spreadsheetId: string;
  updatedRange: string | null;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
}

export interface OpenCloudSheetValuesAppend extends OpenCloudSheetValuesUpdate {
  tableRange: string | null;
}

export interface OpenCloudSheetsClient {
  bindings(): Promise<OpenCloudIntegrationBinding[]>;
  getSpreadsheet(
    input: OpenCloudSpreadsheetBindingInput,
  ): Promise<OpenCloudSpreadsheet>;
  createSpreadsheet(
    input: OpenCloudCreateSpreadsheetInput,
  ): Promise<OpenCloudSpreadsheet>;
  getValues(
    input: OpenCloudSheetGetValuesInput,
  ): Promise<OpenCloudSheetValueRange>;
  updateValues(
    input: OpenCloudSheetWriteValuesInput,
  ): Promise<OpenCloudSheetValuesUpdate>;
  appendValues(
    input: OpenCloudSheetWriteValuesInput,
  ): Promise<OpenCloudSheetValuesAppend>;
}

export interface OpenCloudDocumentTab {
  id: string;
  title: string;
  text: string;
  childTabs: OpenCloudDocumentTab[];
}

export interface OpenCloudDocument {
  id: string;
  title: string;
  revisionId: string | null;
  text: string;
  tabs: OpenCloudDocumentTab[];
}

export interface OpenCloudDocumentBindingInput extends OpenCloudIntegrationBindingInput {
  documentId: string;
}

export interface OpenCloudCreateDocumentInput extends OpenCloudIntegrationBindingInput {
  title: string;
}

export interface OpenCloudAppendDocumentTextInput extends OpenCloudDocumentBindingInput {
  text: string;
  tabId?: string;
}

export interface OpenCloudDocumentUpdate {
  documentId: string;
  revisionId: string | null;
}

export interface OpenCloudDocsClient {
  bindings(): Promise<OpenCloudIntegrationBinding[]>;
  getDocument(input: OpenCloudDocumentBindingInput): Promise<OpenCloudDocument>;
  createDocument(
    input: OpenCloudCreateDocumentInput,
  ): Promise<OpenCloudDocument>;
  appendText(
    input: OpenCloudAppendDocumentTextInput,
  ): Promise<OpenCloudDocumentUpdate>;
}

export interface OpenCloudPresentation {
  id: string;
  title: string;
  slides: Array<{ id: string; text: string }>;
}

export interface OpenCloudPresentationBindingInput extends OpenCloudIntegrationBindingInput {
  presentationId: string;
}

export interface OpenCloudCreatePresentationInput extends OpenCloudIntegrationBindingInput {
  title: string;
}

export interface OpenCloudAddSlideInput extends OpenCloudPresentationBindingInput {
  title?: string;
  body?: string;
}

export interface OpenCloudAddedSlide {
  presentationId: string;
  slideId: string;
  title: string | null;
  body: string | null;
}

export interface OpenCloudSlidesClient {
  bindings(): Promise<OpenCloudIntegrationBinding[]>;
  getPresentation(
    input: OpenCloudPresentationBindingInput,
  ): Promise<OpenCloudPresentation>;
  createPresentation(
    input: OpenCloudCreatePresentationInput,
  ): Promise<OpenCloudPresentation>;
  addSlide(input: OpenCloudAddSlideInput): Promise<OpenCloudAddedSlide>;
}

export type OpenCloudAsanaCustomFieldInputValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | Record<string, string | number | boolean | null>;

export interface OpenCloudAsanaTask {
  id: string;
  name: string;
  notes: string;
  completed: boolean;
  completedAt: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  dueOn: string | null;
  dueAt: string | null;
  startOn: string | null;
  startAt: string | null;
  permalinkUrl: string | null;
  assignee: { id: string; name: string } | null;
  workspaceId: string | null;
  memberships: Array<{
    projectId: string;
    projectName: string | null;
    sectionId: string | null;
    sectionName: string | null;
  }>;
  customFields: Array<{
    id: string;
    name: string;
    type: string;
    displayValue: string | null;
    value: unknown;
  }>;
}

export interface OpenCloudAsanaTaskInput extends OpenCloudIntegrationBindingInput {
  taskId: string;
}

export interface OpenCloudAsanaListTasksInput extends OpenCloudIntegrationBindingInput {
  limit?: number;
  offset?: string;
  completedSince?: string;
}

export interface OpenCloudAsanaCreateTaskInput extends OpenCloudIntegrationBindingInput {
  name: string;
  notes?: string;
  completed?: boolean;
  dueOn?: string | null;
  dueAt?: string | null;
  startOn?: string | null;
  startAt?: string | null;
  assigneeId?: string | null;
  sectionId?: string;
  customFields?: Record<string, OpenCloudAsanaCustomFieldInputValue>;
}

export interface OpenCloudAsanaUpdateTaskInput extends OpenCloudAsanaTaskInput {
  name?: string;
  notes?: string;
  completed?: boolean;
  dueOn?: string | null;
  dueAt?: string | null;
  startOn?: string | null;
  startAt?: string | null;
}

export interface OpenCloudAsanaAssignee {
  id: string;
  name: string;
  email: string | null;
  photoUrl: string | null;
}

export interface OpenCloudAsanaSection {
  id: string;
  name: string;
  createdAt: string | null;
}

export interface OpenCloudAsanaCustomField {
  id: string;
  settingId: string;
  name: string;
  type: string;
  description: string | null;
  precision: number | null;
  format: string | null;
  important: boolean;
  enumOptions: Array<{
    id: string;
    name: string;
    color: string | null;
    enabled: boolean;
  }>;
}

export interface OpenCloudAsanaAttachment {
  id: string;
  name: string;
  subtype: string;
  host: string | null;
  createdAt: string | null;
  viewUrl: string | null;
  downloadAvailable: boolean;
  parentId: string | null;
}

export interface OpenCloudAsanaStory {
  id: string;
  type: string;
  text: string;
  htmlText: string | null;
  createdAt: string | null;
  createdBy: { id: string; name: string } | null;
  pinned: boolean;
}

export interface OpenCloudAsanaEvent {
  source: "opencloud.asana";
  type: "asana.events";
  version: 1;
  id: string;
  integration: string;
  binding: {
    id: string;
    label: string;
    projectId: string;
  };
  delivery: {
    source: "webhook" | "reconciliation";
    receivedAt: string;
  };
  events: Array<{
    action: string;
    resource: {
      id: string;
      type: string;
      subtype: string | null;
    };
    parent: {
      id: string;
      type: string;
      subtype: string | null;
    } | null;
    change: {
      field: string | null;
      action: string | null;
      newValue: unknown;
    } | null;
    actorId: string | null;
    occurredAt: string | null;
  }>;
  tasks: Array<{
    taskId: string;
    task: OpenCloudAsanaTask | null;
  }>;
  tasksTruncated: boolean;
}

export interface OpenCloudAsanaTaskPageInput extends OpenCloudAsanaTaskInput {
  limit?: number;
  offset?: string;
}

export interface OpenCloudAsanaUploadAttachmentInput
  extends OpenCloudAsanaTaskInput, OpenCloudFileInput {}

export interface OpenCloudAsanaDownloadAttachmentInput extends OpenCloudAsanaTaskInput {
  attachmentId: string;
}

export interface OpenCloudAsanaClient {
  bindings(): Promise<OpenCloudIntegrationBinding[]>;
  listTasks(input?: OpenCloudAsanaListTasksInput): Promise<{
    tasks: OpenCloudAsanaTask[];
    nextOffset: string | null;
  }>;
  getTask(input: OpenCloudAsanaTaskInput): Promise<OpenCloudAsanaTask>;
  createTask(input: OpenCloudAsanaCreateTaskInput): Promise<OpenCloudAsanaTask>;
  updateTask(input: OpenCloudAsanaUpdateTaskInput): Promise<OpenCloudAsanaTask>;
  listAssignees(
    input?: OpenCloudIntegrationBindingInput & {
      limit?: number;
      offset?: string;
    },
  ): Promise<{
    users: OpenCloudAsanaAssignee[];
    nextOffset: string | null;
  }>;
  assignTask(
    input: OpenCloudAsanaTaskInput & { assigneeId: string | null },
  ): Promise<OpenCloudAsanaTask>;
  listSections(input?: OpenCloudIntegrationBindingInput): Promise<{
    sections: OpenCloudAsanaSection[];
  }>;
  moveTask(
    input: OpenCloudAsanaTaskInput & { sectionId: string },
  ): Promise<OpenCloudAsanaTask>;
  listCustomFields(input?: OpenCloudIntegrationBindingInput): Promise<{
    customFields: OpenCloudAsanaCustomField[];
  }>;
  updateCustomFields(
    input: OpenCloudAsanaTaskInput & {
      values: Record<string, OpenCloudAsanaCustomFieldInputValue>;
    },
  ): Promise<OpenCloudAsanaTask>;
  listAttachments(input: OpenCloudAsanaTaskPageInput): Promise<{
    attachments: OpenCloudAsanaAttachment[];
    nextOffset: string | null;
  }>;
  createExternalAttachment(
    input: OpenCloudAsanaTaskInput & { name: string; url: string },
  ): Promise<OpenCloudAsanaAttachment>;
  uploadAttachment(
    input: OpenCloudAsanaUploadAttachmentInput,
  ): Promise<OpenCloudAsanaAttachment>;
  downloadAttachment(
    input: OpenCloudAsanaDownloadAttachmentInput,
  ): Promise<OpenCloudFileDownload>;
  listStories(input: OpenCloudAsanaTaskPageInput): Promise<{
    stories: OpenCloudAsanaStory[];
    nextOffset: string | null;
  }>;
  createComment(
    input: OpenCloudAsanaTaskInput & { text: string },
  ): Promise<OpenCloudAsanaStory>;
}

export interface OpenCloudBankAccount {
  iban: string | null;
  bban: string | null;
  sortCodeAccountNumber: string | null;
  currency: string | null;
  ownerName: string | null;
  name: string | null;
  displayName: string | null;
  product: string | null;
  cashAccountType: string | null;
  status: string | null;
  bic: string | null;
  maskedPan: string | null;
}

export interface OpenCloudBankBalance {
  amount: string;
  currency: string;
  type: string;
  creditLimitIncluded: boolean | null;
  lastChangedAt: string | null;
  referenceDate: string | null;
}

export interface OpenCloudBankTransaction {
  id: string | null;
  status: "booked" | "pending";
  amount: string;
  currency: string;
  bookedAt: string | null;
  valueAt: string | null;
  counterpartyName: string | null;
  description: string | null;
  reference: string | null;
  bankTransactionCode: string | null;
}

export interface OpenCloudBankAccountInput extends OpenCloudIntegrationBindingInput {}

export interface OpenCloudBankTransactionsInput extends OpenCloudIntegrationBindingInput {
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  includePending?: boolean;
}

export interface OpenCloudBankTransactionsResult {
  transactions: OpenCloudBankTransaction[];
  lastUpdatedAt: string | null;
  truncated: boolean;
}

export interface OpenCloudBankAccountDataClient {
  bindings(): Promise<OpenCloudIntegrationBinding[]>;
  account(input?: OpenCloudBankAccountInput): Promise<OpenCloudBankAccount>;
  balances(
    input?: OpenCloudBankAccountInput,
  ): Promise<{ balances: OpenCloudBankBalance[] }>;
  listTransactions(
    input?: OpenCloudBankTransactionsInput,
  ): Promise<OpenCloudBankTransactionsResult>;
}

export interface OpenCloudExpectedPaymentInput extends OpenCloudIntegrationBindingInput {
  /** Stable order or invoice key. Reusing it with different details is rejected. */
  paymentKey: string;
  /** Reference shown to the payer. It is used when Wise supplies one. */
  reference: string;
  /** Positive decimal string in the currency's normal units. */
  amount: string;
  currency: string;
  receivedAfter: string;
  receivedBefore: string;
}

export interface OpenCloudExpectedPaymentResult {
  status: "pending" | "matched" | "ambiguous";
  expectedPaymentId: string;
  reference: string;
  amount: string;
  currency: string;
  receivedAt: string | null;
  providerReference: string | null;
}

export interface OpenCloudReceivedPaymentsClient {
  bindings(): Promise<OpenCloudIntegrationBinding[]>;
  reconcile(
    input: OpenCloudExpectedPaymentInput,
  ): Promise<OpenCloudExpectedPaymentResult>;
}

export interface OpenCloudSentTransferEvent {
  id: string;
  /** Stable opaque key shared by every state event for one Wise transfer. */
  transferKey: string;
  previousState: string | null;
  currentState: string;
  occurredAt: string;
}

export interface OpenCloudSentTransferIssueSnapshot {
  id: string;
  /** Stable opaque key shared with state events for the same Wise transfer. */
  transferKey: string;
  /** Bounded Wise case identifiers. An empty list means the issues cleared. */
  activeCases: string[];
  /** Receipt time because Wise does not provide an occurrence time for this event. */
  observedAt: string;
}

export interface OpenCloudSentTransferEventsInput extends OpenCloudIntegrationBindingInput {
  limit?: number;
}

export interface OpenCloudSentTransferEventsResult {
  events: OpenCloudSentTransferEvent[];
  issues: OpenCloudSentTransferIssueSnapshot[];
  truncated: boolean;
}

export interface OpenCloudSentTransfersClient {
  bindings(): Promise<OpenCloudIntegrationBinding[]>;
  listEvents(
    input?: OpenCloudSentTransferEventsInput,
  ): Promise<OpenCloudSentTransferEventsResult>;
}

export interface OpenCloudIntegrationsClient {
  /** Provider-independent surface for current and future integrations. */
  use(integration: string): OpenCloudIntegrationClient;
  calendar(integration: string): OpenCloudCalendarClient;
  drive(integration: string): OpenCloudDriveClient;
  sheets(integration: string): OpenCloudSheetsClient;
  docs(integration: string): OpenCloudDocsClient;
  slides(integration: string): OpenCloudSlidesClient;
  bankAccountData(integration: string): OpenCloudBankAccountDataClient;
  receivedPayments(integration: string): OpenCloudReceivedPaymentsClient;
  sentTransfers(integration: string): OpenCloudSentTransfersClient;
  slack(integration: string): OpenCloudSlackClient;
  telegram(integration: string): OpenCloudTelegramClient;
  asana(integration: string): OpenCloudAsanaClient;
  crm(integration: string): OpenCloudCrmClient;
}

interface DenoLike {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): unknown;
}

interface RuntimeBindings {
  dataSearch: DataSearchRuntimeBinding;
  appId: string;
  anonKey: string;
  restUrl: string;
  schema: string;
  environment: OpenCloudEnvironment;
  devSessionId: string | null;
  aiBaseUrl: string;
  aiGrant: string;
  aiModel: string;
  filesUrl: string;
  filesGrant: string;
  integrationsUrl: string;
  integrationsGrant: string;
  secretNames: ReadonlySet<string>;
  functionRequestId: string;
  functionCorrelationId: string;
  functionNamespace: string;
  functionName: string;
  deploymentVersion: string;
  emailUrl: string | null;
  emailToken: string | null;
  notificationsUrl: string | null;
  notificationsToken: string | null;
  jobsUrl: string | null;
  jobsToken: string | null;
  containersUrl: string | null;
  containersToken: string | null;
  agentTasksUrl: string | null;
  agentTasksToken: string | null;
  appUsersUrl: string | null;
  appUsersToken: string | null;
  job: OpenCloudJobInvocation | null;
  integration: IntegrationRuntimeBinding | null;
}

interface IntegrationRuntimeBinding {
  connectionId: string;
  trigger: OpenCloudIntegrationTrigger;
  operation: string | null;
  consumerAppId: string | null;
  eventsUrl: string | null;
  eventsGrant: string | null;
}

export function defineFunction<Input>(
  definition: OpenCloudFunctionDefinition<Input>,
): unknown {
  if (
    !definition ||
    typeof definition !== "object" ||
    Array.isArray(definition) ||
    typeof definition.input?.parse !== "function" ||
    typeof definition.handler !== "function" ||
    Object.keys(definition).some((key) => key !== "input" && key !== "handler")
  ) {
    throw new Error(
      "defineFunction requires exactly { input: schema.*, handler: async (context) => result }",
    );
  }
  const deno = runtimeDeno();
  return deno.serve(async (request) => {
    const requestId =
      request.headers.get("x-request-id") || crypto.randomUUID();
    try {
      const bindings = runtimeBindings(deno);
      const context = await createContext(
        request,
        requestId,
        bindings,
        deno,
        definition.input,
      );
      const response = normalizeResponse(await definition.handler(context), requestId);
      if (request.method === "HEAD") {
        await response.body?.cancel();
        return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      return response;
    } catch (error) {
      const known = error instanceof OpenCloudError;
      const status = known ? error.status : 500;
      const code = known ? error.code : "FUNCTION_EXECUTION_FAILED";
      const responseRequestId =
        known && error.requestId ? error.requestId : requestId;
      const message =
        known || runtimeEnvironment(deno) === "dev"
          ? errorMessage(error)
          : "Function execution failed";
      console.error(
        JSON.stringify({
          level: "error",
          event: "opencloud_function_handler_failure",
          request_id: responseRequestId,
          code,
          status,
          error: errorMessage(error),
        }),
      );
      const response = Response.json(
        {
          error: {
            code,
            message,
            requestId: responseRequestId,
            retryable: known ? error.retryable : false,
            ...(known && error.details !== undefined
              ? { details: sanitizeDetails(error.details) }
              : {}),
          },
        },
        {
          status,
          headers: responseHeaders(responseRequestId),
        },
      );
      if (request.method === "HEAD") {
        await response.body?.cancel();
        return new Response(null, { status: response.status, headers: response.headers });
      }
      return response;
    }
  });
}

async function createContext<Input>(
  request: Request,
  requestId: string,
  bindings: RuntimeBindings,
  deno: DenoLike,
  inputSchema: OpenCloudSchema<Input>,
): Promise<OpenCloudFunctionContext<Input>> {
  const authorization = request.headers.get("authorization");
  const rawUserId = request.headers.get("x-opencloud-user-id");
  const user = rawUserId && isUuid(rawUserId) ? { id: rawUserId } : null;
  const requestWithId = new Request(request, {
    headers: withHeader(request.headers, "x-request-id", requestId),
  });
  const text = await readBoundedText(requestWithId);
  let rawInput: unknown;
  try {
    rawInput = JSON.parse(text || "{}") as unknown;
  } catch (cause) {
    throw new OpenCloudError("Request body must be valid JSON", {
      code: "INVALID_JSON",
      status: 400,
      requestId,
      details: { cause: errorMessage(cause) },
      retryable: false,
    });
  }
  let input: Input;
  try {
    input = inputSchema.parse(rawInput);
  } catch (cause) {
    if (cause instanceof OpenCloudError) throw cause;
    throw new OpenCloudError("Request body did not match the input schema", {
      code: "INVALID_INPUT",
      status: 400,
      requestId,
      details: { message: errorMessage(cause) },
      retryable: false,
      cause,
    });
  }
  return {
    requestId,
    http: functionHttpContext(request),
    headers: functionRequestHeaders(request),
    environment: bindings.environment,
    user,
    job: bindings.job,
    integration: integrationInvocation(bindings, requestId),
    input,
    data: dataClient(bindings, authorization, requestId),
    files: filesClient(bindings, requestId),
    ai: aiClient(bindings, requestId),
    email: emailClient(bindings, requestId),
    notifications: notificationsClient(bindings, requestId),
    jobs: jobsClient(bindings, user?.id ?? null, requestId),
    containers: containersClient(bindings, requestId),
    agentTasks: agentTasksClient(bindings, requestId),
    integrations: integrationsClient(bindings, requestId),
    secrets: {
      get: (name) => {
        const secretName = assertSecretName(name);
        return bindings.secretNames.has(secretName)
          ? deno.env.get(secretName)
          : undefined;
      },
      require: (name) => {
        const secretName = assertSecretName(name);
        const value = bindings.secretNames.has(secretName)
          ? deno.env.get(secretName)
          : undefined;
        if (value === undefined) {
          throw new OpenCloudError(`Required secret ${name} is unavailable`, {
            code: "SECRET_UNAVAILABLE",
            status: 500,
            requestId,
          });
        }
        return value;
      },
    },
    log: logger(bindings, requestId),
  };
}

function functionHttpContext(request: Request): OpenCloudFunctionHttpContext | null {
  const encoded = request.headers.get("x-opencloud-route-context");
  if (encoded === null) return null;
  try {
    if (encoded.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid context encoding");
    const bytes = Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
    const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!raw || typeof raw !== "object" || Object.keys(raw).sort().join(",") !== "method,params,pathname,query,routeId" ||
        !/^[a-z][a-z0-9-]{0,62}$/.test(raw.routeId) || raw.method !== request.method ||
        !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(raw.method) ||
        typeof raw.pathname !== "string" || !raw.pathname.startsWith("/") ||
        raw.pathname.length > 4096 || !raw.params || typeof raw.params !== "object" || Array.isArray(raw.params) ||
        Object.keys(raw.params).length > 16 || !Array.isArray(raw.query) || raw.query.length > 100) {
      throw new Error("Invalid context shape");
    }
    const params: Record<string, string | readonly string[]> = Object.create(null);
    for (const [key, value] of Object.entries(raw.params)) {
      if (["__proto__", "prototype", "constructor"].includes(key) ||
          !(typeof value === "string" || (Array.isArray(value) && value.every(part => typeof part === "string")))) {
        throw new Error("Invalid path parameters");
      }
      params[key] = Array.isArray(value) ? Object.freeze([...value]) : value as string;
    }
    const pairs = raw.query.map((pair: unknown) => {
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== "string")) throw new Error("Invalid query pairs");
      return Object.freeze([pair[0], pair[1]]) as readonly [string, string];
    }) as readonly (readonly [string, string])[];
    return Object.freeze({
      routeId: raw.routeId,
      method: raw.method,
      pathname: raw.pathname,
      params: Object.freeze(params),
      query: Object.freeze({
        get: (name: string) => pairs.find(pair => pair[0] === name)?.[1] ?? null,
        getAll: (name: string) => Object.freeze(pairs.filter(pair => pair[0] === name).map(pair => pair[1])),
        has: (name: string) => pairs.some(pair => pair[0] === name),
        entries: () => pairs[Symbol.iterator](),
      }),
    });
  } catch {
    throw new OpenCloudError("Function HTTP context is invalid", { code: "INVALID_ROUTE_CONTEXT", status: 400 });
  }
}

function functionRequestHeaders(request: Request): OpenCloudRequestHeaders | null {
  const encoded = request.headers.get("x-opencloud-client-headers");
  if (encoded === null) return null;
  let pairs: readonly (readonly [string, string])[];
  try {
    if (encoded.length > 65_536 || !/^[A-Za-z0-9_-]*$/.test(encoded)) throw new Error("Invalid header encoding");
    const bytes = Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
    const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!Array.isArray(raw) || raw.length > 64 || raw.some((pair: unknown) =>
      !Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]{1,256}$/.test(pair[0]))) {
      throw new Error("Invalid header shape");
    }
    pairs = Object.freeze(raw.map((pair: [string, string]) => Object.freeze([pair[0], pair[1]]) as readonly [string, string]));
  } catch {
    throw new OpenCloudError("Function request headers are invalid", { code: "INVALID_REQUEST_HEADERS", status: 400 });
  }
  const values = new Map(pairs);
  return Object.freeze({
    get: (name: string) => values.get(String(name).toLowerCase()) ?? null,
    has: (name: string) => values.has(String(name).toLowerCase()),
    entries: () => pairs[Symbol.iterator](),
  });
}

const SEARCH_MESSAGES = {
  SEARCH_NOT_DECLARED: "Search is not declared by this Function deployment",
  SEARCH_INPUT_INVALID: "Search input is invalid",
  SEARCH_MODEL_MISMATCH: "Search embedding model does not match the declaration",
  SEARCH_DIMENSION_MISMATCH: "Search vector dimensions do not match the declaration",
  SEARCH_RESULT_TOO_LARGE: "Search results exceed the supported size",
  SEARCH_UNAVAILABLE: "Search is temporarily unavailable",
} as const;
type SearchErrorCode = keyof typeof SEARCH_MESSAGES;
function searchError(code: SearchErrorCode, requestId: string): OpenCloudError {
  return new OpenCloudError(SEARCH_MESSAGES[code], {
    code, status: code === "SEARCH_UNAVAILABLE" ? 503 : 400,
    retryable: code === "SEARCH_UNAVAILABLE", requestId,
  });
}
function searchKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function searchBindings(raw: string | undefined): DataSearchRuntimeBinding {
  if (raw === undefined) return [];
  try {
    if (raw.length > 65536) throw new Error();
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 16) throw new Error();
    const names = new Set<string>();
    const identifier = (item: unknown) => typeof item === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(item);
    const fields = (items: unknown, minimum: number, maximum: number): items is string[] =>
      Array.isArray(items) && items.length >= minimum && items.length <= maximum &&
      items.every(identifier) && new Set(items).size === items.length;
    for (const entry of value) {
      if (!isSchemaRecord(entry) || !searchKeys(entry, ["name", "rpcName", "declaration"]) ||
        typeof entry.name !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(entry.name) || names.has(entry.name) ||
        typeof entry.rpcName !== "string" || !/^oc_search_[a-f0-9]{48}$/.test(entry.rpcName)) throw new Error();
      names.add(entry.name);
      const declaration = entry.declaration;
      if (!isSchemaRecord(declaration) || !searchKeys(declaration, ["name", "table", "select", "filterColumns", "fullText", "vector"]) ||
        declaration.name !== entry.name || !identifier(declaration.table) ||
        !fields(declaration.select, 1, 16) || !declaration.select.includes("id") ||
        (declaration.filterColumns !== undefined && !fields(declaration.filterColumns, 0, 8)) ||
        (!declaration.fullText && !declaration.vector)) throw new Error();
      if (declaration.fullText !== undefined) {
        const fullText = declaration.fullText;
        if (!isSchemaRecord(fullText) || !searchKeys(fullText, ["column", "language"]) ||
          !identifier(fullText.column) || !["english", "simple"].includes(String(fullText.language))) throw new Error();
      }
      if (declaration.vector !== undefined) {
        const vector = declaration.vector;
        if (!isSchemaRecord(vector) || !searchKeys(vector, ["column", "dimensions", "metric", "model"]) ||
          !identifier(vector.column) || typeof vector.dimensions !== "number" || !Number.isInteger(vector.dimensions) ||
          vector.dimensions < 1 || vector.dimensions > 2000 || vector.metric !== "cosine" ||
          typeof vector.model !== "string" || !vector.model.trim() || vector.model.length > 128) throw new Error();
      }
    }
    return value as DataSearchRuntimeBinding;
  } catch {
    throw new OpenCloudError("Search runtime bindings are invalid", { code: "RUNTIME_BINDING_INVALID", status: 500 });
  }
}
function searchInput(declaration: DataSearchDeclaration, value: unknown, requestId: string): DataSearchRequest {
  const invalid = () => searchError("SEARCH_INPUT_INVALID", requestId);
  if (!isSchemaRecord(value) || !["fullText", "vector", "hybrid"].includes(String(value.mode))) throw invalid();
  const lexical = value.mode !== "vector";
  const semantic = value.mode !== "fullText";
  if (!searchKeys(value, ["mode", "where", "limit", ...(lexical ? ["query"] : []), ...(semantic ? ["vector", "model"] : [])]) ||
    (lexical && !declaration.fullText) || (semantic && !declaration.vector)) throw invalid();
  const limit = value.limit === undefined ? 10 : value.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid();
  const where = value.where === undefined ? {} : value.where;
  if (!isSchemaRecord(where) || Object.keys(where).length > 8 || Object.entries(where).some(([key, item]) =>
    !(declaration.filterColumns ?? []).includes(key) || !(item === null || typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item)) || (typeof item === "string" && item.length <= 2048)))) throw invalid();
  let query: string | undefined;
  if (lexical) {
    if (typeof value.query !== "string" || !(query = value.query.trim()) || query.length > 2048) throw invalid();
  }
  if (semantic) {
    if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 128 || !Array.isArray(value.vector)) throw invalid();
    if (value.model !== declaration.vector!.model) throw searchError("SEARCH_MODEL_MISMATCH", requestId);
    if (value.vector.length !== declaration.vector!.dimensions) throw searchError("SEARCH_DIMENSION_MISMATCH", requestId);
    if (value.vector.some((item) => typeof item !== "number" || !Number.isFinite(item) || !Number.isFinite(Math.fround(item))) ||
      !value.vector.some((item: number) => Math.fround(item) !== 0)) throw invalid();
  }
  return { mode: value.mode, limit, where, ...(lexical ? { query } : {}),
    ...(semantic ? { vector: [...value.vector as number[]], model: value.model } : {}) } as DataSearchRequest;
}
function searchOutput(declaration: DataSearchDeclaration, value: unknown, limit: number, requestId: string): DataSearchResponse {
  const invalid = () => searchError("SEARCH_UNAVAILABLE", requestId);
  if (!isSchemaRecord(value) || !searchKeys(value, ["hits"]) || !Array.isArray(value.hits) || value.hits.length > limit) throw invalid();
  const encoder = new TextEncoder();
  if (encoder.encode(JSON.stringify(value)).length > 1024 * 1024) throw searchError("SEARCH_RESULT_TOO_LARGE", requestId);
  const evidence = ["fullTextScore", "fullTextRank", "vectorDistance", "vectorSimilarity", "vectorRank", "fusionScore"];
  for (const hit of value.hits) {
    if (!isSchemaRecord(hit) || !searchKeys(hit, ["record", ...evidence]) ||
      !isSchemaRecord(hit.record) || !searchKeys(hit.record, declaration.select) ||
      !declaration.select.every((key) => Object.hasOwn(hit.record as object, key)) ||
      !evidence.every((key) => hit[key] === null || (typeof hit[key] === "number" && Number.isFinite(hit[key])))) throw invalid();
    for (const key of ["fullTextRank", "vectorRank"]) {
      const rank = hit[key];
      if (rank !== null && (typeof rank !== "number" || !Number.isInteger(rank) || rank < 1 || rank > 100)) throw invalid();
    }
    if (encoder.encode(JSON.stringify(hit.record)).length > 16384) throw searchError("SEARCH_RESULT_TOO_LARGE", requestId);
  }
  return value as unknown as DataSearchResponse;
}

function dataClient(
  bindings: RuntimeBindings,
  authorization: string | null,
  requestId: string,
): OpenCloudDataClient {
  const appUsers = appUserAuthorizations(bindings, requestId);
  return {
    ...dataAccess(bindings, async () => authorization, requestId),
    asAppUser(appUserId) {
      if (typeof appUserId !== "string" || !/^[\x21-\x7e]{1,255}$/.test(appUserId)) {
        throw new OpenCloudError("App user IDs are 1 to 255 visible ASCII characters", {
          code: "INVALID_APP_USER_ID",
          status: 400,
          requestId,
          retryable: false,
        });
      }
      return Object.freeze({
        appUserId,
        ...dataAccess(bindings, () => appUsers(appUserId), requestId),
      });
    },
  };
}

/**
 * Exchanges the invocation's app-user grant for short-lived database tokens,
 * one per app user, reused until shortly before they expire.
 */
function appUserAuthorizations(
  bindings: RuntimeBindings,
  requestId: string,
): (appUserId: string) => Promise<string> {
  const tokens = new Map<string, Promise<{ token: string; refreshAt: number }>>();
  return async (appUserId) => {
    const cached = await tokens.get(appUserId)?.catch(() => null);
    if (cached && Date.now() < cached.refreshAt) return `Bearer ${cached.token}`;
    const minted = mintAppUserToken(bindings, appUserId, requestId);
    tokens.set(appUserId, minted);
    try {
      return `Bearer ${(await minted).token}`;
    } catch (error) {
      if (tokens.get(appUserId) === minted) tokens.delete(appUserId);
      throw error;
    }
  };
}

async function mintAppUserToken(
  bindings: RuntimeBindings,
  appUserId: string,
  requestId: string,
): Promise<{ token: string; refreshAt: number }> {
  if (!bindings.appUsersUrl || !bindings.appUsersToken) {
    throw new OpenCloudError("App user data access is unavailable for this invocation", {
      code: "APP_USER_IDENTITY_UNAVAILABLE",
      status: 503,
      requestId,
      retryable: false,
    });
  }
  const response = await safeFetch(
    new URL(bindings.appUsersUrl),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-opencloud-app-users-token": bindings.appUsersToken,
        "x-request-id": requestId,
      },
      body: JSON.stringify({ appUserId }),
      signal: AbortSignal.timeout(15_000),
    },
    requestId,
  );
  if (!response.ok) throw await responseError(response, requestId);
  const body = await parseJsonResponse<unknown>(response, requestId);
  const expiresAt = isSchemaRecord(body) && typeof body.expiresAt === "string"
    ? Date.parse(body.expiresAt)
    : Number.NaN;
  if (
    !isSchemaRecord(body) ||
    typeof body.accessToken !== "string" ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body.accessToken) ||
    !Number.isFinite(expiresAt)
  ) {
    throw invalidPlatformResponse(requestId, "app user token response is invalid");
  }
  return { token: body.accessToken, refreshAt: expiresAt - 30_000 };
}

function dataAccess(
  bindings: RuntimeBindings,
  authorization: () => Promise<string | null>,
  requestId: string,
): Pick<OpenCloudDataClient, "table" | "search"> {
  const request = async <T>(path: string, init: RequestInit = {}, resolved?: string | null) =>
    platformJsonRequest<T>(
      bindings,
      resolved === undefined ? await authorization() : resolved,
      requestId,
      new URL(path.replace(/^\/+/, ""), bindings.restUrl),
      init,
    );
  return {
    async search(name, options) {
      const binding = bindings.dataSearch.find((item) => item.name === name);
      if (!binding) throw searchError("SEARCH_NOT_DECLARED", requestId);
      const input = searchInput(binding.declaration, options, requestId);
      // Resolve the caller first so identity failures keep their own codes.
      const caller = await authorization();
      let response: unknown;
      try {
        response = await request<unknown>(`rpc/${binding.rpcName}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ request: input }),
        }, caller);
      } catch (error) {
        if (error instanceof OpenCloudError) {
          if (error.status === 401 || error.status === 403) throw new OpenCloudError(
            error.status === 401 ? "Search requires authentication" : "Search access is forbidden",
            { code: error.code, status: error.status, requestId, retryable: false },
          );
          const details = error.details;
          if (error.status === 400 && error.code === "PT400" && isSchemaRecord(details) &&
            typeof details.message === "string" && Object.hasOwn(SEARCH_MESSAGES, details.message) &&
            details.message !== "SEARCH_UNAVAILABLE") throw searchError(details.message as SearchErrorCode, requestId);
        }
        throw searchError("SEARCH_UNAVAILABLE", requestId);
      }
      return searchOutput(binding.declaration, response, input.limit ?? 10, requestId);
    },
    table(name) {
      const table = encodeURIComponent(assertIdentifier(name, "table"));
      const idColumn = "id";
      const list = <T extends Record<string, unknown>>(
        listOptions: OpenCloudListOptions = {},
      ): Promise<T[]> => {
        const search = new URLSearchParams({
          select: selectExpression(listOptions.select),
        });
        appendWhere(search, listOptions.where);
        if (listOptions.orderBy) {
          search.set(
            "order",
            `${assertIdentifier(listOptions.orderBy.column, "order column")}.${
              listOptions.orderBy.direction ?? "asc"
            }`,
          );
        }
        if (listOptions.limit !== undefined) {
          assertIntegerRange(listOptions.limit, 1, 1_000, "list limit");
          search.set("limit", String(listOptions.limit));
        }
        if (listOptions.offset !== undefined) {
          assertIntegerRange(listOptions.offset, 0, 1_000_000, "list offset");
          search.set("offset", String(listOptions.offset));
        }
        return request<T[]>(`${table}?${search}`);
      };
      return {
        list,
        async getById<T extends Record<string, unknown>>(
          id: OpenCloudId,
          getOptions: { select?: readonly string[] } = {},
        ): Promise<T | null> {
          const rows = await list<T>({
            ...(getOptions.select ? { select: getOptions.select } : {}),
            where: { [idColumn]: id },
            limit: 1,
          });
          return rows[0] ?? null;
        },
        async create<T extends Record<string, unknown>>(
          value: Record<string, unknown>,
        ): Promise<T> {
          assertNonEmptyRecord(value, "create value");
          const rows = await request<T[]>(table, jsonMutation("POST", value));
          const row = rows[0];
          if (!row)
            throw invalidPlatformResponse(requestId, "create returned no row");
          return row;
        },
        createMany<T extends Record<string, unknown>>(
          values: readonly Record<string, unknown>[],
        ): Promise<T[]> {
          if (
            !Array.isArray(values) ||
            values.length < 1 ||
            values.length > 1_000
          ) {
            throw new OpenCloudError(
              "createMany requires between 1 and 1000 records",
              {
                code: "INVALID_DATA_MUTATION",
                status: 400,
                requestId,
                retryable: false,
              },
            );
          }
          values.forEach((value) =>
            assertNonEmptyRecord(value, "createMany value"),
          );
          return request<T[]>(table, jsonMutation("POST", values));
        },
        async updateById<T extends Record<string, unknown>>(
          id: OpenCloudId,
          changes: Record<string, unknown>,
        ): Promise<T | null> {
          assertNonEmptyRecord(changes, "update changes");
          const search = new URLSearchParams();
          appendWhere(search, { [idColumn]: id });
          const rows = await request<T[]>(
            `${table}?${search}`,
            jsonMutation("PATCH", changes),
          );
          return rows[0] ?? null;
        },
        async deleteById(id: OpenCloudId): Promise<boolean> {
          const search = new URLSearchParams();
          appendWhere(search, { [idColumn]: id });
          const rows = await request<Record<string, unknown>[]>(
            `${table}?${search}`,
            {
              method: "DELETE",
              headers: { prefer: "return=representation" },
            },
          );
          return rows.length > 0;
        },
        async compareAndSet<T extends Record<string, unknown>>(
          id: OpenCloudId,
          expected: OpenCloudWhere,
          changes: Record<string, unknown>,
        ): Promise<OpenCloudCompareAndSetResult<T>> {
          assertNonEmptyRecord(expected, "compareAndSet expected values");
          assertNonEmptyRecord(changes, "compareAndSet changes");
          if (idColumn in expected) {
            throw new OpenCloudError(
              `compareAndSet receives ${idColumn} as its first argument`,
              {
                code: "INVALID_DATA_MUTATION",
                status: 400,
                requestId,
                retryable: false,
              },
            );
          }
          const search = new URLSearchParams();
          appendWhere(search, { [idColumn]: id, ...expected });
          const rows = await request<T[]>(
            `${table}?${search}`,
            jsonMutation("PATCH", changes),
          );
          return { updated: rows.length > 0, record: rows[0] ?? null };
        },
      };
    },
  };
}

function filesClient(
  bindings: RuntimeBindings,
  requestId: string,
): OpenCloudFilesClient {
  const filesBase = bindings.filesUrl.replace(/\/+$/, "");
  const target = (suffix = "") =>
    new URL(suffix ? `${filesBase}/${suffix.replace(/^\/+/, "")}` : filesBase);
  const metadata = async (
    url: URL,
    init: RequestInit = {},
  ): Promise<OpenCloudFile> =>
    parseFile(
      await managedFileRequest<unknown>(bindings, requestId, url, init, "json"),
      requestId,
    );
  const write = async (
    method: "POST" | "PUT",
    url: URL,
    input: OpenCloudFileInput,
  ): Promise<OpenCloudFile> => {
    const normalized = normalizeFileInput(input, requestId);
    const idempotencyKey = crypto.randomUUID();
    const headers = new Headers({
      "content-type": normalized.contentType,
      "x-opencloud-file-name": encodeURIComponent(normalized.name),
      "idempotency-key": idempotencyKey,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await metadata(url, {
          method,
          headers,
          body: normalized.body,
        });
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
    throw new OpenCloudError("OpenCloud file write could not be completed", {
      code: "PLATFORM_REQUEST_FAILED",
      status: 502,
      requestId,
      retryable: true,
    });
  };
  return {
    upload: (input) => write("POST", target(), input),
    beginUpload(input) {
      if (!input || !isUuid(input.idempotencyKey) || !/^[a-z][a-z0-9-]{0,62}$/.test(input.workloadName)
        || !/^(0|[1-9][0-9]*)$/.test(input.sizeBytes) || BigInt(input.sizeBytes) > 10n * 1024n ** 3n
        || !/^[a-f0-9]{64}$/.test(input.sha256)) throw errors.badRequest("FILE_TRANSFER_INVALID", "Upload declaration is invalid");
      return managedFileRequest(bindings, requestId, target("uploads"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      }, "json");
    },
    uploadStatus: (id) => managedFileRequest(bindings, requestId, target(`uploads/${assertFileId(id)}`), {}, "json"),
    uploadChunk(id, input) {
      if (!input || !(input.data instanceof Uint8Array) || input.data.byteLength < 1 || input.data.byteLength > 8 * 1024 ** 2
        || !/^(0|[1-9][0-9]*)$/.test(input.offsetBytes) || BigInt(input.offsetBytes) > 10n * 1024n ** 3n
        || !/^[a-f0-9]{64}$/.test(input.sha256)) throw errors.badRequest("FILE_TRANSFER_INVALID", "Upload chunk is invalid");
      return managedFileRequest(bindings, requestId, target(`uploads/${assertFileId(id)}/chunks`), {
        method: "PUT", headers: { "content-type": "application/octet-stream", "content-length": String(input.data.byteLength),
          "x-opencloud-upload-offset": input.offsetBytes, "x-opencloud-chunk-sha256": input.sha256 }, body: input.data as BodyInit,
      }, "json");
    },
    completeUpload: (id) => managedFileRequest(bindings, requestId, target(`uploads/${assertFileId(id)}/complete`), { method: "POST" }, "json"),
    abortUpload: (id) => managedFileRequest(bindings, requestId, target(`uploads/${assertFileId(id)}`), { method: "DELETE" }, "void"),
    info: (file) => metadata(target(`${fileReferenceId(file)}/metadata`)),
    async download(file) {
      return managedFileRequest(
        bindings,
        requestId,
        target(`${fileReferenceId(file)}/content`),
        {},
        "bytes",
      );
    },
    async downloadStream(file) {
      const response = await safeFetch(target(`${fileReferenceId(file)}/content`), {
        redirect: "error", headers: { "x-opencloud-function-grant": bindings.filesGrant, "x-request-id": requestId },
        signal: AbortSignal.timeout(900_000),
      }, requestId);
      if (!response.ok) throw await responseError(response, requestId);
      const size = Number(response.headers.get("content-length"));
      if (!response.body || !Number.isSafeInteger(size) || size < 0) throw errors.unavailable("FILE_STREAM_UNAVAILABLE", "File stream is unavailable");
      return { data: response.body, size, name: decodeFileName(response.headers.get("x-opencloud-file-name")) ?? "file",
        contentType: response.headers.get("content-type") ?? "application/octet-stream" };
    },
    replace: (file, input) =>
      write("PUT", target(fileReferenceId(file)), input),
    async remove(file) {
      await managedFileRequest(
        bindings,
        requestId,
        target(fileReferenceId(file)),
        { method: "DELETE" },
        "void",
      );
    },
  };
}

function managedFileRequest<T>(
  bindings: RuntimeBindings,
  requestId: string,
  url: URL,
  init: RequestInit,
  responseType: "json",
): Promise<T>;
function managedFileRequest(
  bindings: RuntimeBindings,
  requestId: string,
  url: URL,
  init: RequestInit,
  responseType: "bytes",
): Promise<OpenCloudFileDownload>;
function managedFileRequest(
  bindings: RuntimeBindings,
  requestId: string,
  url: URL,
  init: RequestInit,
  responseType: "void",
): Promise<void>;
async function managedFileRequest(
  bindings: RuntimeBindings,
  requestId: string,
  url: URL,
  init: RequestInit,
  responseType: "json" | "bytes" | "void",
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("x-opencloud-function-grant", bindings.filesGrant);
  headers.set("x-request-id", requestId);
  const response = await safeFetch(
    url,
    {
      ...init,
      headers,
      signal: AbortSignal.timeout(30_000),
    },
    requestId,
  );
  if (!response.ok) throw await responseError(response, requestId);
  if (responseType === "void") return undefined;
  if (responseType === "bytes") {
    const data = new Uint8Array(await response.arrayBuffer());
    return {
      data,
      contentType:
        response.headers.get("content-type") || "application/octet-stream",
      name:
        decodeFileName(response.headers.get("x-opencloud-file-name")) ?? "file",
      size: data.byteLength,
    } satisfies OpenCloudFileDownload;
  }
  return parseJsonResponse<unknown>(response, requestId);
}

function aiClient(
  bindings: RuntimeBindings,
  requestId: string,
): OpenCloudAiClient {
  const requestCompletion = async (
    input: OpenCloudGenerateTextInput,
    responseFormat: Record<string, unknown>,
    stream = false,
  ): Promise<Response> => {
    const normalized = normalizeGenerateInput(input, requestId);
    const messages = [
      ...(normalized.instructions
        ? [{ role: "developer", content: normalized.instructions }]
        : []),
      {
        role: "user",
        content: normalized.attachments?.length
          ? [
              { type: "text", text: normalized.prompt },
              ...normalized.attachments.map((attachment) =>
                attachment.type === "file"
                  ? {
                      type: "opencloud_file",
                      file_id: fileReferenceId(attachment.file),
                      ...(attachment.detail ? { detail: attachment.detail } : {}),
                    }
                  : {
                      type: "image_url",
                      image_url: {
                        url: `data:${attachment.contentType};base64,${encodeBase64(attachment.data)}`,
                        ...(attachment.detail ? { detail: attachment.detail } : {}),
                      },
                    },
              ),
            ]
          : normalized.prompt,
      },
    ];
    const body = {
      model: bindings.aiModel,
      messages,
      response_format: responseFormat,
      ...(stream ? { stream: true } : {}),
      ...(normalized.reasoningEffort
        ? { reasoning_effort: normalized.reasoningEffort }
        : {}),
    };
    const headers = new Headers({
      authorization: `Bearer ${bindings.aiGrant}`,
      "content-type": "application/json",
      "x-opencloud-function-request-id": bindings.functionRequestId,
      "x-correlation-id": bindings.functionCorrelationId,
      "x-request-id": requestId,
    });
    if (normalized.attachments?.some((attachment) => attachment.type === "file")) {
      headers.set("x-opencloud-files-grant", bindings.filesGrant);
    }
    // `model` in the body stays the runtime default older platforms expect.
    if (normalized.model) headers.set("x-opencloud-ai-model", normalized.model);
    const response = await safeFetch(
      new URL("chat/completions", `${bindings.aiBaseUrl.replace(/\/+$/, "")}/`),
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(14 * 60_000),
      },
      requestId,
    );
    if (!response.ok) throw await responseError(response, requestId);
    return response;
  };
  const complete = async (
    input: OpenCloudGenerateTextInput,
    responseFormat: Record<string, unknown>,
  ): Promise<string> => {
    const response = await requestCompletion(input, responseFormat);
    return completionText(
      await parseJsonResponse<unknown>(response, requestId),
      requestId,
    );
  };
  return {
    generateText: (input) => complete(input, { type: "text" }),
    async streamText(input) {
      const response = await requestCompletion(input, { type: "text" }, true);
      return completionTextStream(response, requestId);
    },
    async generateObject(input) {
      const outputSchema = schemaJson(input.schema);
      const text = await complete(input, {
        type: "json_schema",
        json_schema: {
          name: "opencloud_result",
          strict: true,
          schema: aiOutputSchema(input.schema),
        },
      });
      try {
        return input.schema.parse(
          normalizeAiOutput(JSON.parse(text) as unknown, outputSchema),
        );
      } catch (cause) {
        throw new OpenCloudError(
          "AI output did not match the requested schema",
          {
            code: "AI_INVALID_OUTPUT",
            status: 502,
            requestId,
            retryable: true,
            details: { message: errorMessage(cause) },
            cause,
          },
        );
      }
    },
    async generateImage(input) {
      const normalized = normalizeGenerateImageInput(input, requestId);
      const headers = new Headers({
        authorization: `Bearer ${bindings.aiGrant}`,
        "content-type": "application/json",
        "x-opencloud-function-request-id": bindings.functionRequestId,
        "x-correlation-id": bindings.functionCorrelationId,
        "x-request-id": requestId,
      });
      const response = await safeFetch(
        new URL(
          "images/generations",
          `${bindings.aiBaseUrl.replace(/\/+$/, "")}/`,
        ),
        {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: normalized.prompt }),
          signal: AbortSignal.timeout(14 * 60_000),
        },
        requestId,
      );
      if (!response.ok) throw await responseError(response, requestId);
      return generatedImage(
        await parseJsonResponse<unknown>(response, requestId),
        requestId,
      );
    },
  };
}

function emailClient(
  bindings: RuntimeBindings,
  requestId: string,
): OpenCloudEmailClient {
  return {
    async send(input, options) {
      if (!bindings.emailUrl || !bindings.emailToken) {
        throw new OpenCloudError(
          "Application email is unavailable in this Function runtime",
          {
            code: "EMAIL_UNAVAILABLE",
            status: 503,
            requestId,
            retryable: true,
          },
        );
      }
      if (
        !options?.idempotencyKey ||
        options.idempotencyKey.length < 8 ||
        options.idempotencyKey.length > 128 ||
        !/^[A-Za-z0-9._:-]+$/.test(options.idempotencyKey)
      ) {
        throw new OpenCloudError(
          "email.send requires a bounded idempotencyKey",
          {
            code: "INVALID_IDEMPOTENCY_KEY",
            status: 400,
            requestId,
            retryable: false,
          },
        );
      }
      let response: Response;
      try {
        response = await fetch(bindings.emailUrl, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": options.idempotencyKey,
            "x-opencloud-app-id": bindings.appId,
            "x-opencloud-deployment-version": bindings.deploymentVersion,
            "x-opencloud-environment": bindings.environment,
            "x-opencloud-function-namespace": bindings.functionNamespace,
            "x-opencloud-dev-session-id": bindings.devSessionId ?? "",
            "x-opencloud-email-token": bindings.emailToken,
            "x-request-id": requestId,
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(
            assertTimeout(options.timeoutMs ?? 20_000),
          ),
        });
      } catch (cause) {
        if (cause instanceof OpenCloudError) throw cause;
        throw new OpenCloudError("OpenCloud email request failed", {
          code: "EMAIL_REQUEST_FAILED",
          status: 502,
          requestId,
          retryable: true,
          cause,
        });
      }
      if (!response.ok) throw await responseError(response, requestId);
      return parseJsonResponse<OpenCloudEmailSendResult>(response, requestId);
    },
  };
}

function notificationsClient(
  bindings: RuntimeBindings,
  requestId: string,
): OpenCloudNotificationsClient {
  return {
    async send(input, options) {
      if (!bindings.notificationsUrl || !bindings.notificationsToken) {
        throw new OpenCloudError(
          "Web Push notifications are unavailable in this Function runtime",
          {
            code: "NOTIFICATIONS_UNAVAILABLE",
            status: 503,
            requestId,
            retryable: true,
          },
        );
      }
      if (
        !options?.idempotencyKey ||
        options.idempotencyKey.length > 128 ||
        !/^[A-Za-z0-9._:-]+$/.test(options.idempotencyKey)
      ) {
        throw new OpenCloudError(
          "notifications.send requires a bounded idempotencyKey",
          {
            code: "INVALID_IDEMPOTENCY_KEY",
            status: 400,
            requestId,
            retryable: false,
          },
        );
      }
      let response: Response;
      try {
        response = await fetch(bindings.notificationsUrl, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": options.idempotencyKey,
            "x-opencloud-app-id": bindings.appId,
            "x-opencloud-deployment-version": bindings.deploymentVersion,
            "x-opencloud-environment": bindings.environment,
            "x-opencloud-function-namespace": bindings.functionNamespace,
            "x-opencloud-dev-session-id": bindings.devSessionId ?? "",
            "x-opencloud-notifications-token": bindings.notificationsToken,
            "x-request-id": requestId,
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(assertTimeout(options.timeoutMs ?? 20_000)),
        });
      } catch (cause) {
        if (cause instanceof OpenCloudError) throw cause;
        throw new OpenCloudError("OpenCloud notification request failed", {
          code: "NOTIFICATION_REQUEST_FAILED",
          status: 502,
          requestId,
          retryable: true,
          cause,
        });
      }
      if (!response.ok) throw await responseError(response, requestId);
      return parseJsonResponse<OpenCloudNotificationSendResult>(
        response,
        requestId,
      );
    },
  };
}

function agentTasksClient(bindings: RuntimeBindings, requestId: string): OpenCloudAgentTasksClient {
  const request = async <T>(suffix: string, input?: unknown): Promise<T> => {
    if (!bindings.agentTasksUrl || !bindings.agentTasksToken || bindings.environment !== "production") {
      throw new OpenCloudError("Agent tasks require an owner-authorized production Function or trusted cron invocation", {
        code: "AGENT_TASKS_UNAVAILABLE", status: 403, requestId, retryable: false,
      });
    }
    const response = await safeFetch(new URL(suffix, `${bindings.agentTasksUrl.replace(/\/+$/, "")}/`), {
      method: input === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "accept": "application/json",
        "x-opencloud-agent-tasks-token": bindings.agentTasksToken, "x-request-id": requestId },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(20_000),
    }, requestId);
    if (!response.ok) throw await responseError(response, requestId);
    return parseJsonResponse<T>(response, requestId);
  };
  return {
    start(task, input, options) {
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(task) || !options?.idempotencyKey
        || !/^[A-Za-z0-9._:-]{1,128}$/.test(options.idempotencyKey)) {
        throw new OpenCloudError("Agent task name and a bounded idempotencyKey are required", {
          code: "INVALID_AGENT_TASK", status: 400, requestId, retryable: false,
        });
      }
      return request("", { task, assignments: input.assignments, idempotencyKey: options.idempotencyKey });
    },
    get(runId) {
      if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new OpenCloudError("Invalid agent task ID", {
        code: "INVALID_AGENT_TASK", status: 400, requestId, retryable: false,
      });
      return request(encodeURIComponent(runId));
    },
  };
}

function containersClient(bindings: RuntimeBindings, requestId: string): OpenCloudContainersClient {
  const invalid = (message: string): never => { throw new OpenCloudError(message, {
    code: "INVALID_CONTAINER_INPUT", status: 400, requestId, retryable: false,
  }); };
  const name = (value: string) => {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(value)) invalid("Container name is invalid");
    return value;
  };
  const id = (value: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) invalid("Container execution ID is invalid");
    return value;
  };
  const key = (value: string | undefined) => {
    if (!value || !/^[A-Za-z0-9:._-]{8,128}$/.test(value)) invalid("Container mutations require an idempotencyKey of 8 to 128 safe characters");
    return value;
  };
  const request = async <T>(operation: "run" | "get" | "cancel" | "request", input: unknown, timeoutMs = 20_000): Promise<T> => {
    if (!bindings.containersUrl || !bindings.containersToken) throw new OpenCloudError("Containers are unavailable in this Function runtime", {
      code: "COMPUTE_UNAVAILABLE", status: 503, requestId, retryable: true,
    });
    const response = await safeFetch(new URL(`/_opencloud/containers/${operation}`, bindings.containersUrl), {
      method: "POST", redirect: "error", headers: {
        authorization: `Bearer ${bindings.containersToken}`, "content-type": "application/json",
        "x-opencloud-function-grant": bindings.filesGrant, "x-request-id": requestId,
      }, body: JSON.stringify(input), signal: AbortSignal.timeout(assertTimeout(timeoutMs)),
    }, requestId);
    if (!response.ok) throw await responseError(response, requestId);
    return parseJsonResponse<T>(response, requestId);
  };
  return {
    run(workload, input, options) {
      let encoded: string;
      try { encoded = JSON.stringify(input); } catch { return invalid("Container input must be JSON"); }
      if (encoded === undefined || new TextEncoder().encode(encoded).length > 65_536) invalid("Container input exceeds 64 KiB");
      const fileIds = options?.inputFileIds ?? [];
      if (!Array.isArray(fileIds) || fileIds.length > 16 || new Set(fileIds).size !== fileIds.length) invalid("Select at most 16 distinct input files");
      fileIds.forEach(id);
      return request("run", { name: name(workload), input, inputFileIds: [...fileIds].sort(), idempotencyKey: key(options?.idempotencyKey) }, options?.timeoutMs);
    },
    get(executionId, options) { return request("get", { executionId: id(executionId) }, options?.timeoutMs); },
    cancel(executionId, options) { return request("cancel", { executionId: id(executionId), idempotencyKey: key(options?.idempotencyKey) }, options?.timeoutMs); },
    async request(workload, input, options) {
      if (!input || !input.path?.startsWith("/") || input.path.startsWith("//") || input.path.length > 4_096 || /[\\#\u0000-\u001f\u007f]/.test(input.path)) invalid("Service path must be a bounded relative application path");
      const bytes = typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body;
      if (bytes && (!(bytes instanceof Uint8Array) || bytes.byteLength > 4 * 1024 * 1024)) invalid("Service request body exceeds 4 MiB");
      const result = await request<{ status: number; headers: Record<string, string>; bodyBase64: string }>("request", {
        name: name(workload), path: input.path, method: input.method ?? "GET", headers: input.headers ?? {},
        ...(bytes ? { bodyBase64: encodeBase64(bytes) } : {}),
      }, options?.timeoutMs);
      const badResponse = (): never => { throw new OpenCloudError("Service response is invalid", {
        code: "PLATFORM_INVALID_RESPONSE", status: 502, requestId, retryable: false,
      }); };
      if (!result || !Number.isInteger(result.status) || result.status < 100 || result.status > 599
        || !result.headers || typeof result.headers !== "object" || Array.isArray(result.headers)
        || Object.values(result.headers).some(value => typeof value !== "string")
        || typeof result.bodyBase64 !== "string" || result.bodyBase64.length > 44_739_244) badResponse();
      let body: Uint8Array;
      try { body = decodeBase64(result.bodyBase64); }
      catch { return badResponse(); }
      if (body.byteLength > 32 * 1024 * 1024) badResponse();
      return { status: result.status, headers: result.headers, body };
    },
  };
}

function jobsClient(
  bindings: RuntimeBindings,
  userId: string | null,
  requestId: string,
): OpenCloudJobsClient {
  const request = async <T>(
    suffix: string,
    init: RequestInit & { timeoutMs?: number },
  ): Promise<T> => {
    if (!bindings.jobsUrl || !bindings.jobsToken) {
      throw new OpenCloudError(
        "Background jobs are unavailable in this Function runtime",
        {
          code: "JOBS_UNAVAILABLE",
          status: 503,
          requestId,
          retryable: true,
        },
      );
    }
    const { timeoutMs = 20_000, ...requestInit } = init;
    const headers = new Headers(requestInit.headers);
    headers.set("accept", "application/json");
    headers.set("x-opencloud-app-id", bindings.appId);
    headers.set("x-opencloud-deployment-version", bindings.deploymentVersion);
    headers.set("x-opencloud-environment", bindings.environment);
    headers.set("x-opencloud-function-namespace", bindings.functionNamespace);
    headers.set("x-opencloud-dev-session-id", bindings.devSessionId ?? "");
    headers.set("x-opencloud-function-name", bindings.functionName);
    headers.set("x-opencloud-user-id", userId ?? "");
    headers.set("x-opencloud-jobs-token", bindings.jobsToken);
    headers.set("x-request-id", requestId);
    const base = bindings.jobsUrl.replace(/\/+$/, "");
    const response = await safeFetch(
      new URL(suffix.replace(/^\/+/, ""), `${base}/`),
      {
        ...requestInit,
        headers,
        signal: AbortSignal.timeout(assertTimeout(timeoutMs)),
      },
      requestId,
    );
    if (!response.ok) throw await responseError(response, requestId);
    return parseJsonResponse<T>(response, requestId);
  };
  return {
    enqueue(queue, input, options) {
      const queueName = assertQueueName(queue, requestId);
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new OpenCloudError("Job input must be an object", {
          code: "INVALID_JOB_INPUT",
          status: 400,
          requestId,
          retryable: false,
        });
      }
      if (
        !options?.idempotencyKey ||
        options.idempotencyKey.length > 128 ||
        !/^[A-Za-z0-9._:-]+$/.test(options.idempotencyKey)
      ) {
        throw new OpenCloudError(
          "jobs.enqueue requires a bounded idempotencyKey",
          {
            code: "INVALID_IDEMPOTENCY_KEY",
            status: 400,
            requestId,
            retryable: false,
          },
        );
      }
      const delaySeconds = options.delaySeconds ?? 0;
      if (
        !Number.isInteger(delaySeconds) ||
        delaySeconds < 0 ||
        delaySeconds > 7 * 24 * 60 * 60
      ) {
        throw new OpenCloudError(
          "Job delaySeconds must be an integer from 0 through 604800",
          {
            code: "INVALID_JOB_DELAY",
            status: 400,
            requestId,
            retryable: false,
          },
        );
      }
      let fileInputs: { read: string[] } | undefined;
      if (options.files !== undefined) {
        const selected = options.files;
        if (!selected || typeof selected !== "object" || Array.isArray(selected) ||
          Object.keys(selected).some((key) => key !== "read") ||
          !Array.isArray(selected.read) || selected.read.length < 1 || selected.read.length > 16 ||
          selected.read.some((id) => typeof id !== "string" || (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) &&
            id !== "00000000-0000-0000-0000-000000000000" &&
            id !== "ffffffff-ffff-ffff-ffff-ffffffffffff"))) {
          throw new OpenCloudError("Job file inputs require one to sixteen UUIDs", {
            code: "FILE_DELEGATION_INVALID", status: 400, requestId, retryable: false,
          });
        }
        fileInputs = { read: [...new Set(selected.read.map((id) => id.toLowerCase()))].sort() };
      }
      return request<OpenCloudEnqueuedJob>("", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": options.idempotencyKey,
          ...(fileInputs ? { "x-opencloud-files-grant": bindings.filesGrant } : {}),
        },
        body: JSON.stringify({
          queue: queueName,
          input,
          options: { delaySeconds, ...(fileInputs ? { files: fileInputs } : {}) },
        }),
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
      });
    },
    get(id, options = {}) {
      if (!isUuid(id)) {
        throw new OpenCloudError("Job ID must be a UUID", {
          code: "INVALID_JOB_ID",
          status: 400,
          requestId,
          retryable: false,
        });
      }
      return request<OpenCloudJob>(encodeURIComponent(id), {
        method: "GET",
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
      });
    },
  };
}

function integrationsClient(
  bindings: RuntimeBindings,
  requestId: string,
): OpenCloudIntegrationsClient {
  const execute = <T>(
    integration: string,
    operation: string,
    input: unknown,
    bindingId?: string,
  ): Promise<T> => {
    const name = assertIntegrationName(integration, requestId);
    return integrationRequest<T>(bindings, requestId, {
      integration: name,
      operation: assertIntegrationOperation(operation, requestId),
      input,
      ...(bindingId
        ? { bindingId: assertUuid(bindingId, "binding ID", requestId) }
        : {}),
    });
  };
  const listBindings = async <
    Binding extends OpenCloudIntegrationBinding = OpenCloudIntegrationBinding,
  >(
    integration: string,
    operation:
      | "calendar.bindings.list"
      | "drive.bindings.list"
      | "sheets.bindings.list"
      | "docs.bindings.list"
      | "slides.bindings.list"
      | "bank.bindings.list"
      | "payments.bindings.list"
      | "transfers.bindings.list"
      | "slack.bindings.list"
      | "telegram.bindings.list"
      | "asana.bindings.list"
      | "crm.bindings.list",
  ) => {
    const result = await execute<{ bindings: Binding[] }>(
      integration,
      operation,
      {},
    );
    return result.bindings;
  };
  const asanaAttachmentTarget = (
    action: "upload" | "download",
    integration: string,
    input: { taskId: string; bindingId?: string; attachmentId?: string },
  ): URL => {
    const target = new URL(bindings.integrationsUrl);
    target.pathname = target.pathname.replace(
      /\/execute$/,
      `/asana/attachments/${action}`,
    );
    target.search = "";
    target.searchParams.set(
      "integration",
      assertIntegrationName(integration, requestId),
    );
    target.searchParams.set("taskId", input.taskId);
    if (input.bindingId) {
      target.searchParams.set(
        "bindingId",
        assertUuid(input.bindingId, "binding ID", requestId),
      );
    }
    if (input.attachmentId) {
      target.searchParams.set("attachmentId", input.attachmentId);
    }
    return target;
  };
  return {
    use(integration) {
      const name = assertIntegrationName(integration, requestId);
      return {
        async bindings() {
          const result = await execute<{
            bindings: OpenCloudIntegrationBinding[];
          }>(name, "bindings.list", {});
          return result.bindings;
        },
        call(operation, input = {}, options = {}) {
          if (!input || typeof input !== "object" || Array.isArray(input)) {
            throw new OpenCloudError(
              "Integration operation input must be an object",
              {
                code: "INVALID_INTEGRATION_INPUT",
                status: 400,
                requestId,
                retryable: false,
              },
            );
          }
          return execute(
            name,
            operation,
            input,
            options.bindingId,
          );
        },
      };
    },
    calendar(integration) {
      return {
        bindings: () => listBindings(integration, "calendar.bindings.list"),
        listEvents(input) {
          const { bindingId, ...eventInput } = input;
          return execute<OpenCloudCalendarListEventsResult>(
            integration,
            "calendar.events.list",
            eventInput,
            bindingId,
          );
        },
        createEvent(input) {
          const { bindingId, ...eventInput } = input;
          return execute<OpenCloudCalendarEvent>(
            integration,
            "calendar.events.create",
            eventInput,
            bindingId,
          );
        },
      };
    },
    drive(integration) {
      return {
        bindings: () => listBindings(integration, "drive.bindings.list"),
        listFiles(input = {}) {
          const { bindingId, ...fileInput } = input;
          return execute<OpenCloudDriveListFilesResult>(
            integration,
            "drive.files.list",
            fileInput,
            bindingId,
          );
        },
        getFile(input) {
          const { bindingId, ...fileInput } = input;
          return execute<OpenCloudDriveFile>(
            integration,
            "drive.files.get",
            fileInput,
            bindingId,
          );
        },
        createFile(input) {
          const { bindingId, ...fileInput } = input;
          return execute<OpenCloudDriveFile>(
            integration,
            "drive.files.create",
            fileInput,
            bindingId,
          );
        },
        createFolder(input) {
          const { bindingId, ...folderInput } = input;
          return execute<OpenCloudDriveFile>(
            integration,
            "drive.folders.create",
            folderInput,
            bindingId,
          );
        },
      };
    },
    sheets(integration) {
      return {
        bindings: () => listBindings(integration, "sheets.bindings.list"),
        getSpreadsheet(input) {
          const { bindingId, ...spreadsheetInput } = input;
          return execute<OpenCloudSpreadsheet>(
            integration,
            "sheets.spreadsheets.get",
            spreadsheetInput,
            bindingId,
          );
        },
        createSpreadsheet(input) {
          const { bindingId, ...spreadsheetInput } = input;
          return execute<OpenCloudSpreadsheet>(
            integration,
            "sheets.spreadsheets.create",
            spreadsheetInput,
            bindingId,
          );
        },
        getValues(input) {
          const { bindingId, ...valuesInput } = input;
          return execute<OpenCloudSheetValueRange>(
            integration,
            "sheets.values.get",
            valuesInput,
            bindingId,
          );
        },
        updateValues(input) {
          const { bindingId, ...valuesInput } = input;
          return execute<OpenCloudSheetValuesUpdate>(
            integration,
            "sheets.values.update",
            valuesInput,
            bindingId,
          );
        },
        appendValues(input) {
          const { bindingId, ...valuesInput } = input;
          return execute<OpenCloudSheetValuesAppend>(
            integration,
            "sheets.values.append",
            valuesInput,
            bindingId,
          );
        },
      };
    },
    docs(integration) {
      return {
        bindings: () => listBindings(integration, "docs.bindings.list"),
        getDocument(input) {
          const { bindingId, ...documentInput } = input;
          return execute<OpenCloudDocument>(
            integration,
            "docs.documents.get",
            documentInput,
            bindingId,
          );
        },
        createDocument(input) {
          const { bindingId, ...documentInput } = input;
          return execute<OpenCloudDocument>(
            integration,
            "docs.documents.create",
            documentInput,
            bindingId,
          );
        },
        appendText(input) {
          const { bindingId, ...documentInput } = input;
          return execute<OpenCloudDocumentUpdate>(
            integration,
            "docs.documents.appendText",
            documentInput,
            bindingId,
          );
        },
      };
    },
    slides(integration) {
      return {
        bindings: () => listBindings(integration, "slides.bindings.list"),
        getPresentation(input) {
          const { bindingId, ...presentationInput } = input;
          return execute<OpenCloudPresentation>(
            integration,
            "slides.presentations.get",
            presentationInput,
            bindingId,
          );
        },
        createPresentation(input) {
          const { bindingId, ...presentationInput } = input;
          return execute<OpenCloudPresentation>(
            integration,
            "slides.presentations.create",
            presentationInput,
            bindingId,
          );
        },
        addSlide(input) {
          const { bindingId, ...presentationInput } = input;
          return execute<OpenCloudAddedSlide>(
            integration,
            "slides.presentations.addSlide",
            presentationInput,
            bindingId,
          );
        },
      };
    },
    bankAccountData(integration) {
      return {
        bindings: () => listBindings(integration, "bank.bindings.list"),
        account(input = {}) {
          const { bindingId, ...accountInput } = input;
          return execute<OpenCloudBankAccount>(
            integration,
            "bank.account.get",
            accountInput,
            bindingId,
          );
        },
        balances(input = {}) {
          const { bindingId, ...balanceInput } = input;
          return execute<{ balances: OpenCloudBankBalance[] }>(
            integration,
            "bank.balances.list",
            balanceInput,
            bindingId,
          );
        },
        listTransactions(input = {}) {
          const { bindingId, ...transactionInput } = input;
          return execute<OpenCloudBankTransactionsResult>(
            integration,
            "bank.transactions.list",
            transactionInput,
            bindingId,
          );
        },
      };
    },
    receivedPayments(integration) {
      return {
        bindings: () => listBindings(integration, "payments.bindings.list"),
        reconcile(input) {
          const { bindingId, ...paymentInput } = input;
          return execute<OpenCloudExpectedPaymentResult>(
            integration,
            "payments.received.reconcile",
            paymentInput,
            bindingId,
          );
        },
      };
    },
    sentTransfers(integration) {
      return {
        bindings: () => listBindings(integration, "transfers.bindings.list"),
        listEvents(input = {}) {
          const { bindingId, ...listInput } = input;
          return execute<OpenCloudSentTransferEventsResult>(
            integration,
            "transfers.sent.list",
            listInput,
            bindingId,
          );
        },
      };
    },
    slack(integration) {
      return {
        bindings: () =>
          listBindings<OpenCloudSlackBinding>(
            integration,
            "slack.bindings.list",
          ),
        sendMessage(input) {
          const { bindingId, ...messageInput } = input;
          return execute<OpenCloudSlackSentMessage>(
            integration,
            "slack.messages.send",
            messageInput,
            bindingId,
          );
        },
      };
    },
    telegram(integration) {
      return {
        bindings: () =>
          listBindings<OpenCloudTelegramBinding>(
            integration,
            "telegram.bindings.list",
          ),
        sendMessage(input) {
          const { bindingId, ...messageInput } = input;
          return execute<OpenCloudTelegramSentMessage>(
            integration,
            "telegram.messages.send",
            messageInput,
            bindingId,
          );
        },
      };
    },
    asana(integration) {
      return {
        bindings: () => listBindings(integration, "asana.bindings.list"),
        listTasks(input = {}) {
          const { bindingId, ...taskInput } = input;
          return execute<{
            tasks: OpenCloudAsanaTask[];
            nextOffset: string | null;
          }>(integration, "asana.tasks.list", taskInput, bindingId);
        },
        getTask(input) {
          const { bindingId, ...taskInput } = input;
          return execute<OpenCloudAsanaTask>(
            integration,
            "asana.tasks.get",
            taskInput,
            bindingId,
          );
        },
        createTask(input) {
          const { bindingId, ...taskInput } = input;
          return execute<OpenCloudAsanaTask>(
            integration,
            "asana.tasks.create",
            taskInput,
            bindingId,
          );
        },
        updateTask(input) {
          const { bindingId, ...taskInput } = input;
          return execute<OpenCloudAsanaTask>(
            integration,
            "asana.tasks.update",
            taskInput,
            bindingId,
          );
        },
        listAssignees(input = {}) {
          const { bindingId, ...assigneeInput } = input;
          return execute<{
            users: OpenCloudAsanaAssignee[];
            nextOffset: string | null;
          }>(integration, "asana.assignees.list", assigneeInput, bindingId);
        },
        assignTask(input) {
          const { bindingId, ...assigneeInput } = input;
          return execute<OpenCloudAsanaTask>(
            integration,
            "asana.assignees.assign",
            assigneeInput,
            bindingId,
          );
        },
        listSections(input = {}) {
          const { bindingId } = input;
          return execute<{ sections: OpenCloudAsanaSection[] }>(
            integration,
            "asana.sections.list",
            {},
            bindingId,
          );
        },
        moveTask(input) {
          const { bindingId, ...sectionInput } = input;
          return execute<OpenCloudAsanaTask>(
            integration,
            "asana.sections.moveTask",
            sectionInput,
            bindingId,
          );
        },
        listCustomFields(input = {}) {
          const { bindingId } = input;
          return execute<{ customFields: OpenCloudAsanaCustomField[] }>(
            integration,
            "asana.customFields.list",
            {},
            bindingId,
          );
        },
        updateCustomFields(input) {
          const { bindingId, ...fieldInput } = input;
          return execute<OpenCloudAsanaTask>(
            integration,
            "asana.customFields.updateTask",
            fieldInput,
            bindingId,
          );
        },
        listAttachments(input) {
          const { bindingId, ...attachmentInput } = input;
          return execute<{
            attachments: OpenCloudAsanaAttachment[];
            nextOffset: string | null;
          }>(integration, "asana.attachments.list", attachmentInput, bindingId);
        },
        createExternalAttachment(input) {
          const { bindingId, ...attachmentInput } = input;
          return execute<OpenCloudAsanaAttachment>(
            integration,
            "asana.attachments.createExternal",
            attachmentInput,
            bindingId,
          );
        },
        async uploadAttachment(input) {
          const { bindingId, taskId, data, name, contentType } = input;
          const normalized = normalizeFileInput(
            {
              data,
              ...(name ? { name } : {}),
              ...(contentType ? { contentType } : {}),
            },
            requestId,
          );
          const response = await safeFetch(
            asanaAttachmentTarget("upload", integration, {
              taskId,
              ...(bindingId ? { bindingId } : {}),
            }),
            {
              method: "POST",
              headers: {
                "content-type": normalized.contentType,
                "x-opencloud-file-name": encodeURIComponent(normalized.name),
                "x-opencloud-function-grant": bindings.integrationsGrant,
                "x-request-id": requestId,
              },
              body: normalized.body,
              signal: AbortSignal.timeout(120_000),
            },
            requestId,
          );
          if (!response.ok) throw await responseError(response, requestId);
          return parseJsonResponse<OpenCloudAsanaAttachment>(
            response,
            requestId,
          );
        },
        async downloadAttachment(input) {
          const response = await safeFetch(
            asanaAttachmentTarget("download", integration, input),
            {
              headers: {
                "x-opencloud-function-grant": bindings.integrationsGrant,
                "x-request-id": requestId,
              },
              signal: AbortSignal.timeout(120_000),
            },
            requestId,
          );
          if (!response.ok) throw await responseError(response, requestId);
          const bytes = new Uint8Array(await response.arrayBuffer());
          let name = "attachment";
          const encodedName = response.headers.get("x-opencloud-file-name");
          if (encodedName) {
            try {
              name = decodeURIComponent(encodedName);
            } catch {
              name = "attachment";
            }
          }
          return {
            data: bytes,
            contentType:
              response.headers.get("content-type") ??
              "application/octet-stream",
            name,
            size: bytes.byteLength,
          };
        },
        listStories(input) {
          const { bindingId, ...storyInput } = input;
          return execute<{
            stories: OpenCloudAsanaStory[];
            nextOffset: string | null;
          }>(integration, "asana.stories.list", storyInput, bindingId);
        },
        createComment(input) {
          const { bindingId, ...storyInput } = input;
          return execute<OpenCloudAsanaStory>(
            integration,
            "asana.stories.createComment",
            storyInput,
            bindingId,
          );
        },
      };
    },
    crm(integration) {
      const operations = {
        contacts: {
          get: "crm.contacts.get",
          search: "crm.contacts.search",
          create: "crm.contacts.create",
          update: "crm.contacts.update",
          upsert: "crm.contacts.upsert",
        },
        companies: {
          get: "crm.companies.get",
          search: "crm.companies.search",
          create: "crm.companies.create",
          update: "crm.companies.update",
          upsert: "crm.companies.upsert",
        },
        deals: {
          get: "crm.deals.get",
          search: "crm.deals.search",
          create: "crm.deals.create",
          update: "crm.deals.update",
          upsert: "crm.deals.upsert",
        },
      } as const;
      const objectClient = (
        objectType: keyof typeof operations,
      ): OpenCloudCrmObjectClient => {
        const objectOperations = operations[objectType];
        return {
          get(input) {
            const { bindingId, ...recordInput } = input;
            return execute<OpenCloudCrmRecord>(
              integration,
              objectOperations.get,
              recordInput,
              bindingId,
            );
          },
          search(input = {}) {
            const { bindingId, ...searchInput } = input;
            return execute<OpenCloudCrmSearchResult>(
              integration,
              objectOperations.search,
              searchInput,
              bindingId,
            );
          },
          create(input) {
            const { bindingId, ...recordInput } = input;
            return execute<OpenCloudCrmRecord>(
              integration,
              objectOperations.create,
              recordInput,
              bindingId,
            );
          },
          update(input) {
            const { bindingId, ...recordInput } = input;
            return execute<OpenCloudCrmRecord>(
              integration,
              objectOperations.update,
              recordInput,
              bindingId,
            );
          },
          upsert(input) {
            const { bindingId, ...recordInput } = input;
            return execute<OpenCloudCrmRecord>(
              integration,
              objectOperations.upsert,
              recordInput,
              bindingId,
            );
          },
        };
      };
      return {
        bindings: () => listBindings(integration, "crm.bindings.list"),
        contacts: objectClient("contacts"),
        companies: objectClient("companies"),
        deals: objectClient("deals"),
        owners: {
          list(input = {}) {
            const { bindingId, ...listInput } = input;
            return execute<{
              owners: OpenCloudCrmOwner[];
              nextAfter: string | null;
            }>(integration, "crm.owners.list", listInput, bindingId);
          },
        },
        pipelines: {
          listDeals(input = {}) {
            const { bindingId } = input;
            return execute<{ pipelines: OpenCloudCrmPipeline[] }>(
              integration,
              "crm.dealPipelines.list",
              {},
              bindingId,
            );
          },
        },
        notes: {
          create(input) {
            const { bindingId, ...noteInput } = input;
            return execute<OpenCloudCrmRecord>(
              integration,
              "crm.notes.create",
              noteInput,
              bindingId,
            );
          },
        },
        associations: {
          create(input) {
            const { bindingId, ...associationInput } = input;
            return execute<{ associated: true }>(
              integration,
              "crm.associations.create",
              associationInput,
              bindingId,
            );
          },
        },
      };
    },
  };
}

async function integrationRequest<T>(
  bindings: RuntimeBindings,
  requestId: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await safeFetch(
    new URL(bindings.integrationsUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencloud-function-grant": bindings.integrationsGrant,
        "x-request-id": requestId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    },
    requestId,
  );
  if (!response.ok) throw await integrationError(response, requestId);
  return parseJsonResponse<T>(response, requestId);
}

/**
 * Integration failures expose the platform's own `details`, such as the
 * `connectUrl` a calling-user slot returns when the person must connect.
 */
async function integrationError(
  response: Response,
  requestId: string,
): Promise<OpenCloudError> {
  const error = await responseError(response, requestId);
  const body = error.details;
  const details =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).details
      : undefined;
  return new OpenCloudError(error.message, {
    code: error.code,
    status: error.status,
    requestId: error.requestId,
    retryable: error.retryable,
    ...(details !== undefined ? { details } : {}),
  });
}

async function platformJsonRequest<T>(
  bindings: RuntimeBindings,
  authorization: string | null,
  requestId: string,
  url: URL,
  init: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("apikey", bindings.anonKey);
  headers.set("authorization", authorization || `Bearer ${bindings.anonKey}`);
  headers.set("x-opencloud-app-id", bindings.appId);
  headers.set("x-opencloud-schema", bindings.schema);
  headers.set("accept-profile", bindings.schema);
  headers.set("content-profile", bindings.schema);
  headers.set("x-opencloud-environment", bindings.environment);
  headers.set("x-opencloud-function-namespace", bindings.functionNamespace);
  headers.set("x-request-id", requestId);
  if (bindings.devSessionId) {
    headers.set("x-opencloud-dev-session-id", bindings.devSessionId);
  }
  const { timeoutMs = 15_000, ...requestInit } = init;
  const response = await safeFetch(
    url,
    {
      ...requestInit,
      headers,
      signal: init.signal ?? AbortSignal.timeout(assertTimeout(timeoutMs)),
    },
    requestId,
  );
  if (!response.ok) throw await responseError(response, requestId);
  if (
    response.status === 204 ||
    response.headers.get("content-length") === "0"
  ) {
    return undefined as T;
  }
  return parseJsonResponse<T>(response, requestId);
}

async function safeFetch(
  url: URL,
  init: RequestInit,
  requestId: string,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    throw new OpenCloudError("OpenCloud platform request failed", {
      code: "PLATFORM_REQUEST_FAILED",
      status: 502,
      requestId,
      retryable: true,
      cause,
    });
  }
}

async function parseJsonResponse<T>(
  response: Response,
  requestId: string,
): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/[/+]json(?:;|$)/i.test(contentType)) {
    throw invalidPlatformResponse(requestId, "platform response was not JSON");
  }
  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new OpenCloudError("OpenCloud platform returned invalid JSON", {
      code: "PLATFORM_INVALID_RESPONSE",
      status: 502,
      requestId: response.headers.get("x-request-id") || requestId,
      retryable: true,
      cause,
    });
  }
}

async function responseError(
  response: Response,
  requestId: string,
): Promise<OpenCloudError> {
  const text = (await response.text()).slice(0, 2_000);
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  return new OpenCloudError(platformErrorMessage(response.status, body), {
    code: platformErrorCode(body),
    status: response.status,
    requestId: response.headers.get("x-request-id") || requestId,
    details: sanitizeDetails(body),
    retryable:
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500,
  });
}

function normalizeResponse(
  value: OpenCloudFunctionResult,
  requestId: string,
): Response {
  if (value instanceof Response) {
    const headers = new Headers(value.headers);
    responseHeaders(requestId).forEach((headerValue, name) => {
      headers.set(name, headerValue);
    });
    return new Response(value.body, {
      status: value.status,
      statusText: value.statusText,
      headers,
    });
  }
  if (value === undefined) {
    return new Response(null, {
      status: 204,
      headers: responseHeaders(requestId),
    });
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const headers = responseHeaders(requestId);
    headers.set("content-type", "text/plain; charset=utf-8");
    return new Response(String(value), { headers });
  }
  return Response.json(value, { headers: responseHeaders(requestId) });
}

function responseHeaders(requestId: string): Headers {
  return new Headers({
    "cache-control": "no-store",
    "x-request-id": requestId,
    "x-opencloud-sdk-version": OPEN_CLOUD_SDK_VERSION,
  });
}

function runtimeDeno(): DenoLike {
  const value = (globalThis as typeof globalThis & { Deno?: DenoLike }).Deno;
  if (!value?.env || typeof value.serve !== "function") {
    throw new Error("@opencloud/server must run inside an OpenCloud Function");
  }
  return value;
}

function runtimeBindings(deno: DenoLike): RuntimeBindings {
  const environment = runtimeEnvironment(deno);
  const appId = requiredBinding(deno, "OPENCLOUD_APP_ID");
  const baseUrl = requiredBinding(deno, "SUPABASE_URL");
  const runtimeSdkVersion = requiredBinding(deno, "OPENCLOUD_SDK_VERSION");
  if (runtimeSdkVersion !== OPEN_CLOUD_SDK_VERSION) {
    throw new OpenCloudError("Function SDK and runtime versions do not match", {
      code: "SDK_VERSION_MISMATCH",
      status: 500,
      details: {
        expected: OPEN_CLOUD_SDK_VERSION,
        received: runtimeSdkVersion,
      },
    });
  }
  return {
    appId,
    anonKey: requiredBinding(deno, "SUPABASE_ANON_KEY"),
    restUrl:
      environment === "dev"
        ? requiredBinding(deno, "OPENCLOUD_REST_URL")
        : new URL("/rest/v1/", baseUrl).toString(),
    schema: requiredBinding(deno, "OPENCLOUD_SCHEMA"),
    environment,
    devSessionId:
      environment === "dev"
        ? requiredBinding(deno, "OPENCLOUD_DEV_SESSION_ID")
        : null,
    aiBaseUrl: requiredBinding(deno, "OPENCLOUD_AI_BASE_URL"),
    aiGrant: requiredBinding(deno, "OPENCLOUD_AI_API_KEY"),
    aiModel: requiredBinding(deno, "OPENCLOUD_AI_MODEL"),
    filesUrl: requiredBinding(deno, "OPENCLOUD_FILES_URL"),
    filesGrant: requiredBinding(deno, "OPENCLOUD_FILES_GRANT"),
    integrationsUrl: requiredBinding(deno, "OPENCLOUD_INTEGRATIONS_URL"),
    integrationsGrant: requiredBinding(deno, "OPENCLOUD_INTEGRATIONS_GRANT"),
    secretNames: runtimeSecretNames(deno),
    functionRequestId: requiredBinding(deno, "OPENCLOUD_FUNCTION_REQUEST_ID"),
    functionCorrelationId: requiredBinding(
      deno,
      "OPENCLOUD_FUNCTION_CORRELATION_ID",
    ),
    functionNamespace: deno.env.get("OPENCLOUD_FUNCTION_NAMESPACE") || appId,
    functionName: requiredBinding(deno, "OPENCLOUD_FUNCTION_NAME"),
    deploymentVersion: requiredBinding(deno, "OPENCLOUD_DEPLOYMENT_VERSION"),
    emailUrl: deno.env.get("OPENCLOUD_EMAIL_URL") || null,
    emailToken: deno.env.get("OPENCLOUD_EMAIL_TOKEN") || null,
    notificationsUrl: deno.env.get("OPENCLOUD_NOTIFICATIONS_URL") || null,
    notificationsToken:
      deno.env.get("OPENCLOUD_NOTIFICATIONS_TOKEN") || null,
    jobsUrl: deno.env.get("OPENCLOUD_JOBS_URL") || null,
    jobsToken: deno.env.get("OPENCLOUD_JOBS_TOKEN") || null,
    containersUrl: deno.env.get("OPENCLOUD_CONTAINERS_URL") || null,
    containersToken: deno.env.get("OPENCLOUD_CONTAINERS_TOKEN") || null,
    agentTasksUrl: deno.env.get("OPENCLOUD_AGENT_TASKS_URL") || null,
    agentTasksToken: deno.env.get("OPENCLOUD_AGENT_TASKS_TOKEN") || null,
    appUsersUrl: deno.env.get("OPENCLOUD_APP_USERS_URL") || null,
    appUsersToken: deno.env.get("OPENCLOUD_APP_USERS_TOKEN") || null,
    dataSearch: searchBindings(deno.env.get("OPENCLOUD_DATA_SEARCH")),
    job: runtimeJobInvocation(deno),
    integration: runtimeIntegrationInvocation(deno),
  };
}

function runtimeIntegrationInvocation(deno: DenoLike): IntegrationRuntimeBinding | null {
  const connectionId = deno.env.get("OPENCLOUD_INTEGRATION_CONNECTION_ID") || "";
  if (!connectionId) return null;
  const trigger = deno.env.get("OPENCLOUD_INTEGRATION_TRIGGER") || "";
  const operation = deno.env.get("OPENCLOUD_INTEGRATION_OPERATION") || null;
  const consumerAppId = deno.env.get("OPENCLOUD_INTEGRATION_CONSUMER_APP_ID") || null;
  if (
    !isUuid(connectionId) ||
    !["operation", "sync", "webhook", "oauth"].includes(trigger) ||
    (operation !== null && operation.length > 128) ||
    (consumerAppId !== null && !isUuid(consumerAppId))
  ) {
    throw new OpenCloudError("Integration runtime bindings are invalid", {
      code: "RUNTIME_BINDING_INVALID",
      status: 500,
    });
  }
  return {
    connectionId,
    trigger: trigger as OpenCloudIntegrationTrigger,
    operation,
    consumerAppId,
    eventsUrl: deno.env.get("OPENCLOUD_INTEGRATION_EVENTS_URL") || null,
    eventsGrant: deno.env.get("OPENCLOUD_INTEGRATION_EVENTS_GRANT") || null,
  };
}

function integrationInvocation(
  bindings: RuntimeBindings,
  requestId: string,
): OpenCloudIntegrationInvocation | null {
  const binding = bindings.integration;
  if (!binding) return null;
  return Object.freeze({
    connectionId: binding.connectionId,
    trigger: binding.trigger,
    operation: binding.operation,
    consumerAppId: binding.consumerAppId,
    async emit(event: OpenCloudIntegrationEvent) {
      if (!binding.eventsUrl || !binding.eventsGrant) {
        throw new OpenCloudError("This integration invocation cannot emit events", {
          code: "INTEGRATION_EVENTS_UNAVAILABLE",
          status: 409,
          requestId,
          retryable: false,
        });
      }
      const invalid = (message: string) =>
        new OpenCloudError(message, {
          code: "INVALID_INTEGRATION_EVENT",
          status: 400,
          requestId,
          retryable: false,
        });
      if (!event || typeof event !== "object") throw invalid("Event must be an object");
      if (
        typeof event.type !== "string" ||
        event.type.length > 100 ||
        !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(event.type)
      ) {
        throw invalid("Event type must be a declared dotted name such as orders.created");
      }
      if (
        typeof event.id !== "string" ||
        event.id.length > 200 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(event.id)
      ) {
        throw invalid("Event ID must use letters, digits, and . _ : - (at most 200 characters)");
      }
      if (
        event.data !== undefined &&
        (!event.data || typeof event.data !== "object" || Array.isArray(event.data))
      ) {
        throw invalid("Event data must be a JSON object");
      }
      const occurredAt =
        event.occurredAt instanceof Date ? event.occurredAt.toISOString() : event.occurredAt;
      const response = await safeFetch(
        new URL(binding.eventsUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencloud-integration-events-grant": binding.eventsGrant,
            "x-request-id": requestId,
          },
          body: JSON.stringify({
            type: event.type,
            id: event.id,
            data: event.data ?? {},
            ...(occurredAt ? { occurredAt } : {}),
          }),
          signal: AbortSignal.timeout(30_000),
        },
        requestId,
      );
      if (!response.ok) throw await responseError(response, requestId);
      const result = await parseJsonResponse<{ deliveries?: unknown }>(response, requestId);
      return { deliveries: typeof result.deliveries === "number" ? result.deliveries : 0 };
    },
  });
}

function runtimeJobInvocation(deno: DenoLike): OpenCloudJobInvocation | null {
  const id = deno.env.get("OPENCLOUD_JOB_ID") || "";
  const queue = deno.env.get("OPENCLOUD_JOB_QUEUE") || "";
  const attempt = deno.env.get("OPENCLOUD_JOB_ATTEMPT") || "";
  if (!id && !queue && !attempt) return null;
  if (
    !isUuid(id) ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(queue) ||
    !/^[1-9][0-9]{0,2}$/.test(attempt)
  ) {
    throw new OpenCloudError("Background job runtime bindings are invalid", {
      code: "RUNTIME_BINDING_INVALID",
      status: 500,
    });
  }
  return { id, queue, attempt: Number(attempt) };
}

function assertQueueName(value: string, requestId: string): string {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(value)) {
    throw new OpenCloudError("Queue name is invalid", {
      code: "INVALID_QUEUE_NAME",
      status: 400,
      requestId,
      retryable: false,
    });
  }
  return value;
}

function runtimeEnvironment(deno: DenoLike): OpenCloudEnvironment {
  return deno.env.get("OPENCLOUD_ENVIRONMENT") === "dev" ? "dev" : "production";
}

function requiredBinding(deno: DenoLike, name: string): string {
  const value = deno.env.get(name);
  if (!value) {
    throw new OpenCloudError(
      `OpenCloud runtime binding ${name} is unavailable`,
      {
        code: "RUNTIME_BINDING_MISSING",
        status: 500,
      },
    );
  }
  return value;
}

function runtimeSecretNames(deno: DenoLike): ReadonlySet<string> {
  let value: unknown;
  try {
    value = JSON.parse(requiredBinding(deno, "OPENCLOUD_SECRET_NAMES"));
  } catch (cause) {
    if (cause instanceof OpenCloudError) throw cause;
    throw new OpenCloudError("OpenCloud secret bindings are invalid", {
      code: "RUNTIME_BINDING_INVALID",
      status: 500,
      cause,
    });
  }
  if (
    !Array.isArray(value) ||
    value.some((name) => typeof name !== "string" || !isSecretName(name))
  ) {
    throw new OpenCloudError("OpenCloud secret bindings are invalid", {
      code: "RUNTIME_BINDING_INVALID",
      status: 500,
    });
  }
  return new Set(value as string[]);
}

function assertIntegrationName(value: string, requestId: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new OpenCloudError("Integration name is invalid", {
      code: "INVALID_INTEGRATION_NAME",
      status: 400,
      requestId,
      retryable: false,
    });
  }
  return value;
}

function assertIntegrationOperation(
  value: string,
  requestId: string,
): string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/.test(value)
  ) {
    throw new OpenCloudError("Integration operation is invalid", {
      code: "INVALID_INTEGRATION_OPERATION",
      status: 400,
      requestId,
      retryable: false,
    });
  }
  return value;
}

function assertUuid(value: string, label: string, requestId?: string): string {
  if (!isUuid(value)) {
    throw new OpenCloudError(`${label} is invalid`, {
      code: "INVALID_INTEGRATION_BINDING",
      status: 400,
      ...(requestId ? { requestId } : {}),
      retryable: false,
    });
  }
  return value.toLowerCase();
}

function logger(bindings: RuntimeBindings, requestId: string): OpenCloudLogger {
  const write = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields: Record<string, unknown> = {},
  ) => {
    // The call's fields stay apart, under `fields`, so a field named like one
    // of the line's own keys (`message`, `level`, ...) never replaces it. The
    // runtime recognises this shape by its event and keeps each field's name.
    const own = sanitizeLogFields(fields);
    const record = {
      level,
      event: "opencloud_function_log_v2",
      message: message.slice(0, 1_000),
      app_id: bindings.appId,
      environment: bindings.environment,
      request_id: requestId,
      ...(bindings.devSessionId
        ? { dev_session_id: bindings.devSessionId }
        : {}),
      ...(Object.keys(own).length ? { fields: own } : {}),
    };
    const encoded = JSON.stringify(record);
    if (level === "error") console.error(encoded);
    else if (level === "warn") console.warn(encoded);
    else console.log(encoded);
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

async function readBoundedText(
  request: Request,
  maxBytes = 1_048_576,
): Promise<string> {
  assertIntegerRange(maxBytes, 1, 10_485_760, "Function body limit");
  const text = await request.clone().text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new OpenCloudError(`Request body exceeds ${maxBytes} bytes`, {
      code: "REQUEST_TOO_LARGE",
      status: 413,
      retryable: false,
    });
  }
  return text;
}

function jsonMutation(method: "POST" | "PATCH", value: unknown): RequestInit {
  return {
    method,
    body: JSON.stringify(value),
    headers: {
      "content-type": "application/json",
      prefer: "return=representation",
    },
  };
}

function selectExpression(columns?: readonly string[]): string {
  if (columns === undefined) return "*";
  if (!Array.isArray(columns) || columns.length < 1 || columns.length > 100) {
    throw new OpenCloudError("select requires between 1 and 100 columns", {
      code: "INVALID_DATA_QUERY",
      status: 400,
      retryable: false,
    });
  }
  return columns
    .map((column) => assertIdentifier(column, "select column"))
    .join(",");
}

function appendWhere(search: URLSearchParams, where?: OpenCloudWhere): void {
  for (const [column, value] of Object.entries(where ?? {})) {
    search.set(
      assertIdentifier(column, "filter column"),
      value === null ? "is.null" : `eq.${String(value)}`,
    );
  }
}

function assertNonEmptyRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    throw new OpenCloudError(`${label} must be a non-empty object`, {
      code: "INVALID_DATA_MUTATION",
      status: 400,
      retryable: false,
    });
  }
}

function assertIdentifier(value: string, label: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new OpenCloudError(`Invalid ${label} identifier`, {
      code: "INVALID_DATA_IDENTIFIER",
      status: 400,
      retryable: false,
    });
  }
  return value;
}

function assertIntegerRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new OpenCloudError(
      `${label} must be an integer between ${minimum} and ${maximum}`,
      { code: "INVALID_ARGUMENT", status: 400, retryable: false },
    );
  }
  return value;
}

function assertTimeout(value: number): number {
  return assertIntegerRange(value, 1, 900_000, "timeoutMs");
}

function assertSecretName(value: string): string {
  if (!isSecretName(value)) {
    throw new OpenCloudError("Invalid secret name", {
      code: "INVALID_SECRET_NAME",
      status: 500,
      retryable: false,
    });
  }
  return value;
}

function isSecretName(value: string): boolean {
  return (
    /^[A-Z][A-Z0-9_]{0,127}$/.test(value) &&
    !value.startsWith("OPENCLOUD_") &&
    !value.startsWith("SUPABASE_")
  );
}

function assertFileId(value: string): string {
  if (!isUuid(value)) {
    throw new OpenCloudError("File ID must be a UUID", {
      code: "INVALID_FILE_ID",
      status: 400,
      retryable: false,
    });
  }
  return value.toLowerCase();
}

function fileReferenceId(value: OpenCloudFileRef | string): string {
  const id = typeof value === "string" ? value : value?.id;
  return assertFileId(id);
}

function normalizeFileInput(
  input: OpenCloudFileInput,
  requestId: string,
): { body: BodyInit; name: string; contentType: string } {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => key !== "data" && key !== "name" && key !== "contentType",
    )
  ) {
    throw new OpenCloudError(
      "files.upload and files.replace require { data, name?, contentType? }",
      {
        code: "INVALID_FILE_INPUT",
        status: 400,
        requestId,
        retryable: false,
      },
    );
  }
  const value = input.data;
  let body: BodyInit;
  let inferredName: string | undefined;
  let inferredType: string | undefined;
  if (typeof value === "string") {
    body = value;
    inferredName = "file.txt";
    inferredType = "text/plain; charset=utf-8";
  } else if (value instanceof Blob) {
    body = value;
    inferredType = value.type || undefined;
    if (typeof File !== "undefined" && value instanceof File) {
      inferredName = value.name;
    }
  } else if (value instanceof ArrayBuffer) {
    body = value;
    inferredName = "file";
  } else if (value instanceof Uint8Array) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    body = copy.buffer;
    inferredName = "file";
  } else {
    throw new OpenCloudError("File body type is unsupported", {
      code: "INVALID_FILE_BODY",
      status: 400,
      requestId,
      retryable: false,
    });
  }
  const name = input.name ?? inferredName ?? "file";
  if (!name || name.length > 240 || /[\u0000-\u001f\u007f/\\]/.test(name)) {
    throw new OpenCloudError("File name is required and must be a plain name", {
      code: "INVALID_FILE_NAME",
      status: 400,
      requestId,
      retryable: false,
    });
  }
  const contentType =
    input.contentType ?? inferredType ?? "application/octet-stream";
  if (
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;[^\r\n]*)?$/.test(
      contentType,
    )
  ) {
    throw new OpenCloudError("File content type is invalid", {
      code: "INVALID_FILE_CONTENT_TYPE",
      status: 400,
      requestId,
      retryable: false,
    });
  }
  return { body, name, contentType };
}

function normalizeGenerateInput(
  input: OpenCloudGenerateTextInput,
  requestId: string,
): OpenCloudGenerateTextInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new OpenCloudError(
      "AI generation requires { prompt, instructions? }",
      {
        code: "INVALID_AI_INPUT",
        status: 400,
        requestId,
        retryable: false,
      },
    );
  }
  if (
    typeof input.prompt !== "string" ||
    input.prompt.trim().length < 1 ||
    input.prompt.length > 1_000_000 ||
    (input.instructions !== undefined &&
      (typeof input.instructions !== "string" ||
        input.instructions.length > 100_000)) ||
    (input.reasoningEffort !== undefined &&
      !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        input.reasoningEffort,
      )) ||
    (input.attachments !== undefined && !Array.isArray(input.attachments)) ||
    (input.model !== undefined && !isAiModelId(input.model))
  ) {
    throw new OpenCloudError("AI generation input is invalid", {
      code: "INVALID_AI_INPUT",
      status: 400,
      requestId,
      retryable: false,
    });
  }
  let attachmentBytes = 0;
  for (const attachment of input.attachments ?? []) {
    if (
      attachment &&
      typeof attachment === "object" &&
      !Array.isArray(attachment) &&
      attachment.type === "file"
    ) {
      if (
        Object.keys(attachment).some(
          (key) => key !== "type" && key !== "file" && key !== "detail",
        ) ||
        (attachment.detail !== undefined &&
          !["auto", "low", "high", "original"].includes(attachment.detail))
      ) {
        throw new OpenCloudError("AI managed-file attachment is invalid", {
          code: "INVALID_AI_ATTACHMENT",
          status: 400,
          requestId,
          retryable: false,
        });
      }
      fileReferenceId(attachment.file);
      continue;
    }
    if (
      !attachment ||
      typeof attachment !== "object" ||
      Array.isArray(attachment) ||
      attachment.type !== "image" ||
      Object.keys(attachment).some(
        (key) =>
          key !== "type" &&
          key !== "data" &&
          key !== "contentType" &&
          key !== "detail",
      ) ||
      !(attachment.data instanceof Uint8Array) ||
      attachment.data.byteLength < 1 ||
      attachment.data.byteLength > 15 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        attachment.contentType,
      ) ||
      (attachment.detail !== undefined &&
        !["auto", "low", "high", "original"].includes(attachment.detail))
    ) {
      throw new OpenCloudError("AI image attachment is invalid", {
        code: "INVALID_AI_ATTACHMENT",
        status: 400,
        requestId,
        retryable: false,
      });
    }
    attachmentBytes += attachment.data.byteLength;
  }
  if ((input.attachments?.length ?? 0) > 4 || attachmentBytes > 20 * 1024 * 1024) {
    throw new OpenCloudError("AI attachments exceed the allowed limit", {
      code: "AI_ATTACHMENT_LIMIT_EXCEEDED",
      status: 413,
      requestId,
      retryable: false,
    });
  }
  return input;
}

/** A provider-native (`claude-haiku-5-5`) or `provider/model` id. */
function isAiModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 220 &&
    /^[a-z0-9][a-z0-9._:/-]*$/.test(value) &&
    !value.endsWith("/") &&
    !value.includes("//")
  );
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

const BASE64_DECODE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < 26; i++) {
    table[65 + i] = i; // A-Z
    table[97 + i] = 26 + i; // a-z
  }
  for (let i = 0; i < 10; i++) table[48 + i] = 52 + i; // 0-9
  table[43] = 62; // +
  table[47] = 63; // /
  return table;
})();

function decodeBase64(input: string): Uint8Array {
  const len = input.length;
  if (len === 0) return new Uint8Array(0);
  if ((len & 3) !== 0) throw new Error("Invalid base64 length");
  const pad = input.charCodeAt(len - 1) === 61
    ? (input.charCodeAt(len - 2) === 61 ? 2 : 1)
    : 0;
  const out = new Uint8Array((len >>> 2) * 3 - pad);
  const fullEnd = pad > 0 ? len - 4 : len;
  let outPos = 0;
  for (let i = 0; i < fullEnd; i += 4) {
    const c0 = input.charCodeAt(i);
    const c1 = input.charCodeAt(i + 1);
    const c2 = input.charCodeAt(i + 2);
    const c3 = input.charCodeAt(i + 3);
    if ((c0 | c1 | c2 | c3) > 127) throw new Error("Invalid base64 character");
    const v0 = BASE64_DECODE[c0]!;
    const v1 = BASE64_DECODE[c1]!;
    const v2 = BASE64_DECODE[c2]!;
    const v3 = BASE64_DECODE[c3]!;
    if ((v0 | v1 | v2 | v3) < 0) throw new Error("Invalid base64 character");
    const triple = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    out[outPos++] = (triple >>> 16) & 0xff;
    out[outPos++] = (triple >>> 8) & 0xff;
    out[outPos++] = triple & 0xff;
  }
  if (pad === 1) {
    const c0 = input.charCodeAt(fullEnd);
    const c1 = input.charCodeAt(fullEnd + 1);
    const c2 = input.charCodeAt(fullEnd + 2);
    if ((c0 | c1 | c2) > 127) throw new Error("Invalid base64 character");
    const v0 = BASE64_DECODE[c0]!;
    const v1 = BASE64_DECODE[c1]!;
    const v2 = BASE64_DECODE[c2]!;
    if ((v0 | v1 | v2) < 0 || (v2 & 0x3) !== 0) throw new Error("Invalid base64 padding");
    const triple = (v0 << 18) | (v1 << 12) | (v2 << 6);
    out[outPos++] = (triple >>> 16) & 0xff;
    out[outPos++] = (triple >>> 8) & 0xff;
  } else if (pad === 2) {
    const c0 = input.charCodeAt(fullEnd);
    const c1 = input.charCodeAt(fullEnd + 1);
    if ((c0 | c1) > 127) throw new Error("Invalid base64 character");
    const v0 = BASE64_DECODE[c0]!;
    const v1 = BASE64_DECODE[c1]!;
    if ((v0 | v1) < 0 || (v1 & 0xf) !== 0) throw new Error("Invalid base64 padding");
    const triple = (v0 << 18) | (v1 << 12);
    out[outPos++] = (triple >>> 16) & 0xff;
  }
  return out;
}

function normalizeGenerateImageInput(
  input: OpenCloudGenerateImageInput,
  requestId: string,
): OpenCloudGenerateImageInput {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "prompt") ||
    typeof input.prompt !== "string" ||
    input.prompt.trim().length < 1 ||
    input.prompt.length > 32_000
  ) {
    throw new OpenCloudError("AI image generation requires { prompt }", {
      code: "INVALID_AI_INPUT",
      status: 400,
      requestId,
      retryable: false,
    });
  }
  return input;
}

function completionText(value: unknown, requestId: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidPlatformResponse(requestId, "AI response was not an object");
  }
  const choices = (value as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    throw invalidPlatformResponse(
      requestId,
      "AI response had no single choice",
    );
  }
  const choice = choices[0];
  const message =
    choice && typeof choice === "object" && !Array.isArray(choice)
      ? (choice as Record<string, unknown>).message
      : null;
  const content =
    message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>).content
      : null;
  if (typeof content !== "string") {
    throw invalidPlatformResponse(requestId, "AI response content was invalid");
  }
  return content;
}

function completionTextStream(
  response: Response,
  requestId: string,
): ReadableStream<Uint8Array> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^text\/event-stream(?:;|$)/i.test(contentType)) {
    throw invalidPlatformResponse(
      requestId,
      "AI stream was not event-stream data",
    );
  }
  if (!response.body) {
    throw invalidPlatformResponse(requestId, "AI stream had no body");
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let completed = false;

  const consumeLine = (
    rawLine: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trimStart();
    if (data === "[DONE]") {
      completed = true;
      return;
    }
    if (!data || completed) return;

    let value: unknown;
    try {
      value = JSON.parse(data) as unknown;
    } catch {
      throw invalidPlatformResponse(
        requestId,
        "AI stream contained invalid JSON",
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw invalidPlatformResponse(requestId, "AI stream event was invalid");
    }
    const record = value as Record<string, unknown>;
    if (record.error) {
      throw invalidPlatformResponse(requestId, "AI stream failed");
    }
    const choices = record.choices;
    if (!Array.isArray(choices)) {
      throw invalidPlatformResponse(
        requestId,
        "AI stream choices were invalid",
      );
    }
    if (choices.length === 0) return;
    if (choices.length !== 1) {
      throw invalidPlatformResponse(
        requestId,
        "AI stream had no single choice",
      );
    }
    const choice = choices[0];
    const delta =
      choice && typeof choice === "object" && !Array.isArray(choice)
        ? (choice as Record<string, unknown>).delta
        : null;
    if (!delta || typeof delta !== "object" || Array.isArray(delta)) {
      throw invalidPlatformResponse(requestId, "AI stream delta was invalid");
    }
    const content = (delta as Record<string, unknown>).content;
    if (content === undefined) return;
    if (typeof content !== "string") {
      throw invalidPlatformResponse(requestId, "AI stream content was invalid");
    }
    if (content) controller.enqueue(encoder.encode(content));
  };

  const consumeBuffer = (
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      consumeLine(buffer.slice(0, newline), controller);
      buffer = buffer.slice(newline + 1);
    }
    if (buffer.length > 1_000_000) {
      throw invalidPlatformResponse(requestId, "AI stream event was too large");
    }
  };

  return response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        consumeBuffer(controller);
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) consumeLine(buffer, controller);
        if (!completed) {
          throw invalidPlatformResponse(
            requestId,
            "AI stream ended before completion",
          );
        }
      },
    }),
  );
}

function generatedImage(
  value: unknown,
  requestId: string,
): OpenCloudGeneratedImage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidPlatformResponse(
      requestId,
      "AI image response was not an object",
    );
  }
  const images = (value as Record<string, unknown>).data;
  if (!Array.isArray(images) || images.length !== 1) {
    throw invalidPlatformResponse(
      requestId,
      "AI image response had no single image",
    );
  }
  const image = images[0];
  if (!image || typeof image !== "object" || Array.isArray(image)) {
    throw invalidPlatformResponse(requestId, "AI image response was invalid");
  }
  const record = image as Record<string, unknown>;
  const b64Json = typeof record.b64_json === "string" ? record.b64_json : "";
  if (
    !b64Json ||
    b64Json.length > Math.ceil((25 * 1024 * 1024) / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      b64Json,
    )
  ) {
    throw invalidPlatformResponse(requestId, "AI image data was invalid");
  }
  let binary: string;
  try {
    binary = atob(b64Json);
  } catch (cause) {
    throw new OpenCloudError("OpenCloud platform returned invalid image data", {
      code: "PLATFORM_INVALID_RESPONSE",
      status: 502,
      requestId,
      retryable: true,
      cause,
    });
  }
  if (binary.length > 25 * 1024 * 1024) {
    throw invalidPlatformResponse(requestId, "AI image data was too large");
  }
  const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    data[index] = binary.charCodeAt(index);
  }
  if (
    data.byteLength < 8 ||
    ![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => data[index] === byte,
    )
  ) {
    throw invalidPlatformResponse(requestId, "AI image was not a PNG");
  }
  const revisedPrompt = record.revised_prompt;
  if (
    revisedPrompt !== undefined &&
    (typeof revisedPrompt !== "string" || revisedPrompt.length > 32_000)
  ) {
    throw invalidPlatformResponse(
      requestId,
      "AI image revised prompt was invalid",
    );
  }
  return {
    data,
    contentType: "image/png",
    revisedPrompt: revisedPrompt ?? null,
  };
}

function parseFile(value: unknown, requestId: string): OpenCloudFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidPlatformResponse(requestId, "file metadata was not an object");
  }
  const input = value as Record<string, unknown>;
  const id = requiredString(input.id, "file.id", requestId);
  assertFileId(id);
  return {
    id,
    name: requiredString(input.name, "file.name", requestId),
    contentType: requiredString(
      input.contentType,
      "file.contentType",
      requestId,
    ),
    size: requiredNonNegativeInteger(input.size, "file.size", requestId),
    createdAt: requiredIso(input.createdAt, "file.createdAt", requestId),
    updatedAt: requiredIso(input.updatedAt, "file.updatedAt", requestId),
  };
}

function requiredString(
  value: unknown,
  field: string,
  requestId: string,
): string {
  if (typeof value !== "string" || !value) {
    throw invalidPlatformResponse(requestId, `${field} was invalid`);
  }
  return value;
}

function requiredNonNegativeInteger(
  value: unknown,
  field: string,
  requestId: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidPlatformResponse(requestId, `${field} was invalid`);
  }
  return value as number;
}

function requiredIso(value: unknown, field: string, requestId: string): string {
  const output = requiredString(value, field, requestId);
  if (!Number.isFinite(Date.parse(output))) {
    throw invalidPlatformResponse(requestId, `${field} was invalid`);
  }
  return output;
}

function decodeFileName(value: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function invalidPlatformResponse(
  requestId: string,
  detail: string,
): OpenCloudError {
  return new OpenCloudError(`OpenCloud ${detail}`, {
    code: "PLATFORM_INVALID_RESPONSE",
    status: 502,
    requestId,
    retryable: true,
  });
}

function withHeader(input: Headers, name: string, value: string): Headers {
  const headers = new Headers(input);
  headers.set(name, value);
  return headers;
}

function platformErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const nested =
      record.error && typeof record.error === "object"
        ? (record.error as Record<string, unknown>)
        : null;
    if (typeof nested?.message === "string" && nested.message) {
      return `OpenCloud platform request failed (${status}): ${nested.message}`;
    }
    for (const key of ["message", "error_description", "hint", "details"]) {
      if (typeof record[key] === "string" && record[key]) {
        return `OpenCloud platform request failed (${status}): ${record[key]}`;
      }
    }
  }
  return `OpenCloud platform request failed (${status})`;
}

function platformErrorCode(body: unknown): string {
  if (!body || typeof body !== "object") return "PLATFORM_REQUEST_FAILED";
  const record = body as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : null;
  for (const value of [nested?.code, record.code]) {
    if (typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(value)) {
      return value;
    }
  }
  return "PLATFORM_REQUEST_FAILED";
}

function sanitizeDetails(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 2_000);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeDetails(item, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(
    value as Record<string, unknown>,
  ).slice(0, 50)) {
    if (/token|secret|password|authorization|cookie|key|grant/i.test(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = sanitizeDetails(item, depth + 1);
    }
  }
  return output;
}

function sanitizeLogFields(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = sanitizeDetails(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
