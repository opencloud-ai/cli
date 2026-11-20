import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Command } from "commander";
import { ApiError, OpenCloudClient } from "./api-client.js";
import { computeErrorCatalog, computeErrorCodeSchema, computeErrorDetailsSchema, computeErrorSchema } from "@opencloud/contracts/containers";
import { callerFailure } from "./caller-failure.js";
import { requestIdForError } from "./cli-http.js";
import { CliContractError, hintOf, withHint } from "./cli-contract-error.js";
import { isZodError, issueSummary, readableIssues } from "./readable-issues.js";

export interface OperationOptions {
  idempotencyKey?: string;
  follow: boolean;
  interval: string;
  timeout: string;
}

export interface OperationLike {
  id: string;
  state: string;
  error?: unknown;
  [key: string]: unknown;
}

export { CliContractError };

export class OperationTerminalError extends CliContractError {
  /** The release a failed operation names, with the error OpenCloud recorded on it. */
  deployment: { id: string; error: Record<string, unknown> } | undefined;

  constructor(readonly operation: OperationLike) {
    super(
      operation.state === "cancelled"
        ? "OPERATION_CANCELLED"
        : "OPERATION_FAILED",
      `OpenCloud operation ${operation.id} ${operation.state}`,
    );
    this.name = "OperationTerminalError";
  }
}

const OPERATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOG_TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A failed operation with the cause OpenCloud recorded on the release it
 * names. A compensated deploy or rollback only says DEPLOYMENT_COMPENSATED;
 * the release's own error says why, such as a container that never became
 * ready or exited with code 3, and the hint names the logs that show it.
 */
async function terminalOperationError(client: Pick<OpenCloudClient, "get">, operation: OperationLike): Promise<OperationTerminalError> {
  const failure = new OperationTerminalError(operation);
  const { appId, deploymentId } = operation;
  if (operation.state !== "failed" || typeof appId !== "string" || typeof deploymentId !== "string" ||
      !OPERATION_UUID.test(appId) || !OPERATION_UUID.test(deploymentId)) return failure;
  let cause: Record<string, unknown>;
  try {
    cause = record(record(await client.get(`/v1/apps/${encodeURIComponent(appId)}/deployments/${encodeURIComponent(deploymentId)}`)).error);
  } catch {
    // The operation's own failure is still reported.
    return failure;
  }
  if (!Object.keys(cause).length) return failure;
  failure.deployment = { id: deploymentId, error: cause };
  if (typeof cause.code === "string" && cause.code.startsWith("COMPUTE_")) {
    const workload = record(cause.details).workloadName;
    const window = typeof operation.createdAt === "string" && LOG_TIME.test(operation.createdAt) &&
      typeof operation.updatedAt === "string" && LOG_TIME.test(operation.updatedAt)
      ? ` --from ${operation.createdAt} --to ${operation.updatedAt}`
      : " --from <start> --to <end>";
    const name = typeof workload === "string" && /^[a-z][a-z0-9-]{0,62}$/.test(workload) ? ` --workload ${workload}` : "";
    withHint(failure, `OpenCloud kept the release that was live before. To see what the new release's containers wrote, run \`opencloud logs ${appId} --page --surface container${name}${window}\`.`);
  }
  return failure;
}

export class OperationWaitTimeoutError extends CliContractError {
  constructor(readonly operation: OperationLike) {
    super(
      "OPERATION_WAIT_TIMEOUT",
      `Timed out waiting for OpenCloud operation ${operation.id}; recover with opencloud operation get ${operation.id} --follow`,
      { retryable: true },
    );
    this.name = "OperationWaitTimeoutError";
  }
}

export function addOperationOptions(command: Command): Command {
  return command
    .option("--idempotency-key <key>", "stable key for this intended mutation")
    .option("--no-follow", "return after the durable operation is accepted")
    .option("--interval <seconds>", "poll interval", "2")
    .option("--timeout <seconds>", "maximum follow time", "900");
}

/**
 * A bounded number in the forms 3.20 accepted (`1e2`, `5.`, `0x10`), for
 * options whose zero is out of range anyway. Options where an empty value
 * would mean zero use parseDecimalInteger.
 */
export function parseBoundedNumber(
  raw: unknown,
  name: string,
  minimum: number,
  maximum: number,
  integer = true,
): number {
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value)) ||
    value < minimum ||
    value > maximum
  ) {
    throw new CliContractError(
      "INVALID_OPTION",
      `${name} must be ${integer ? "an integer" : "a number"} from ${minimum} through ${maximum}`,
    );
  }
  return value;
}

/**
 * Plain decimal digits only. Number() reads "" and " " as 0 and accepts 0x2
 * or 1e1, so `--replicas "$UNSET"` would otherwise mean zero replicas.
 */
export function parseDecimalInteger(raw: unknown, name: string, minimum: number, maximum: number): number {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CliContractError("INVALID_OPTION", `${name} must be an integer from ${minimum} through ${maximum}, in plain digits`);
  }
  return value;
}

export function parseCommaList(raw: unknown, name: string): string[] {
  const values = String(raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.length || new Set(values).size !== values.length) {
    throw new CliContractError(
      "INVALID_OPTION",
      `${name} must contain one or more unique comma-separated values`,
    );
  }
  return values;
}

export async function jsonOption(input: {
  inline?: string | undefined;
  file?: string | undefined;
  resolvePath: (value: string) => string;
  defaultValue?: unknown;
  kind: "object" | "array";
}): Promise<unknown> {
  if (input.inline !== undefined && input.file !== undefined) {
    throw new CliContractError(
      "INVALID_OPTION",
      "Pass an inline JSON value or a JSON file, not both",
    );
  }
  let value = input.defaultValue;
  if (input.inline !== undefined || input.file !== undefined) {
    // A file the caller named that cannot be read is theirs to fix.
    const source =
      input.inline ??
      (await readFile(input.resolvePath(String(input.file)), "utf8").catch(
        (error: unknown) => {
          throw callerFailure(error);
        },
      ));
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw new CliContractError("INVALID_JSON", "Input is not valid JSON", {
        cause: error,
      });
    }
  }
  const valid =
    input.kind === "array"
      ? Array.isArray(value)
      : Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (!valid) {
    throw new CliContractError(
      "INVALID_JSON_SHAPE",
      `Input JSON must be ${input.kind === "array" ? "an array" : "an object"}`,
    );
  }
  return value;
}

export async function secretFromStdin(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += bytes.length;
    if (length > 64 * 1024 + 2) {
      throw new CliContractError(
        "SECRET_TOO_LARGE",
        "Secret input exceeds 65536 bytes",
      );
    }
    chunks.push(bytes);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const value = raw.replace(/\r?\n$/, "");
  if (!value) {
    throw new CliContractError(
      "SECRET_INPUT_REQUIRED",
      "Read a non-empty secret value from standard input",
    );
  }
  if (Buffer.byteLength(value) > 64 * 1024) {
    throw new CliContractError(
      "SECRET_TOO_LARGE",
      "Secret input exceeds 65536 bytes",
    );
  }
  return value;
}

export function operationFrom(value: unknown): OperationLike | null {
  if (!value || typeof value !== "object") return null;
  const candidate =
    "operation" in value &&
    value.operation &&
    typeof value.operation === "object"
      ? value.operation
      : value;
  const id = "id" in candidate ? candidate.id : undefined;
  const state = "state" in candidate ? candidate.state : undefined;
  return typeof id === "string" && typeof state === "string"
    ? (candidate as OperationLike)
    : null;
}

export function replaceOperation(
  started: unknown,
  operation: OperationLike,
): unknown {
  if (
    started &&
    typeof started === "object" &&
    "operation" in started &&
    started.operation &&
    typeof started.operation === "object"
  ) {
    return { ...started, operation };
  }
  return operation;
}

export async function followOperation(input: {
  client: Pick<OpenCloudClient, "get">;
  started: unknown;
  options: OperationOptions;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}): Promise<unknown> {
  let operation = operationFrom(input.started);
  if (!operation) {
    throw new CliContractError(
      "INVALID_OPERATION_RESPONSE",
      "OpenCloud did not return a durable operation coordinate",
    );
  }
  if (["failed", "cancelled"].includes(operation.state)) {
    throw await terminalOperationError(input.client, operation);
  }
  if (operation.state === "succeeded" || !input.options.follow) {
    return input.started;
  }

  const intervalMs =
    parseBoundedNumber(input.options.interval, "--interval", 0.05, 60, false) *
    1_000;
  const timeoutMs =
    parseBoundedNumber(input.options.timeout, "--timeout", 1, 1_800, false) *
    1_000;
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;
  while (!["succeeded", "failed", "cancelled"].includes(operation.state)) {
    if (now() >= deadline) throw new OperationWaitTimeoutError(operation);
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
    operation = operationFrom(
      await input.client.get(
        `/v1/operations/${encodeURIComponent(operation.id)}`,
      ),
    );
    if (!operation) {
      throw new CliContractError(
        "INVALID_OPERATION_RESPONSE",
        "OpenCloud returned an invalid durable operation",
      );
    }
  }
  if (operation.state !== "succeeded") {
    throw await terminalOperationError(input.client, operation);
  }
  return replaceOperation(input.started, operation);
}

export async function assertPathAbsent(
  destinationValue: string,
  code: "TOKEN_FILE_EXISTS" | "OUTPUT_FILE_EXISTS",
): Promise<string> {
  const destination = path.resolve(destinationValue);
  try {
    await lstat(destination);
    throw new CliContractError(
      code,
      code === "TOKEN_FILE_EXISTS"
        ? `Refusing to overwrite credential token file ${destination}`
        : `Refusing to overwrite output file ${destination}; pass --force to replace it`,
    );
  } catch (error) {
    if (
      error instanceof CliContractError ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }
  return destination;
}

export async function persistCredentialToken(input: {
  response: unknown;
  destination: string;
  /** @internal Deterministic fault-injection seam for path-swap tests. */
  afterExistingFileOpened?: (() => void | Promise<void>) | undefined;
}): Promise<Record<string, unknown>> {
  const destination = path.resolve(input.destination);
  const response = input.response as Record<string, unknown>;
  const token = response?.token;
  if (typeof token !== "string" || !token) {
    throw new CliContractError(
      "INVALID_CREDENTIAL_RESPONSE",
      "OpenCloud did not return the one-time credential",
    );
  }
  const serialized = Buffer.from(`${token}\n`, "utf8");
  const metadata = (): Record<string, unknown> => {
    const { token: _secret, ...safe } = response;
    return { ...safe, tokenFile: destination };
  };
  const acceptExisting = async (): Promise<Record<string, unknown>> => {
    const noFollow =
      process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
    let handle;
    try {
      handle = await open(destination, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      throw new CliContractError(
        "UNSAFE_TOKEN_FILE",
        `Existing credential token path could not be opened safely: ${destination}`,
        { cause: error },
      );
    }
    try {
      await input.afterExistingFileOpened?.();
      const destinationMetadata = await handle.stat();
      if (
        !destinationMetadata.isFile() ||
        (process.platform !== "win32" &&
          (destinationMetadata.mode & 0o777) !== 0o600)
      ) {
        throw new CliContractError(
          "UNSAFE_TOKEN_FILE",
          `Existing credential token path is not a mode-0600 regular file: ${destination}`,
        );
      }
      const existing = await handle.readFile();
      let currentHandle;
      try {
        currentHandle = await open(
          destination,
          fsConstants.O_RDONLY | noFollow,
        );
      } catch (error) {
        throw new CliContractError(
          "UNSAFE_TOKEN_FILE",
          `Existing credential token path changed while it was being verified: ${destination}`,
          { cause: error },
        );
      }
      try {
        const currentMetadata = await currentHandle.stat();
        if (
          !currentMetadata.isFile() ||
          currentMetadata.dev !== destinationMetadata.dev ||
          currentMetadata.ino !== destinationMetadata.ino
        ) {
          throw new CliContractError(
            "UNSAFE_TOKEN_FILE",
            `Existing credential token path changed while it was being verified: ${destination}`,
          );
        }
      } finally {
        await currentHandle.close();
      }
      if (
        existing.byteLength !== serialized.byteLength ||
        !timingSafeEqual(existing, serialized)
      ) {
        throw new CliContractError(
          "TOKEN_FILE_EXISTS",
          `Refusing to overwrite credential token file ${destination}`,
        );
      }
      return metadata();
    } finally {
      await handle.close();
    }
  };
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized);
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return await acceptExisting();
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return metadata();
}

export async function downloadToFile(input: {
  response: Response;
  destination: string;
  force: boolean;
  expected?: { bytes: number; sha256: string };
}): Promise<{ output: string; size: number; sha256: string }> {
  if (!input.response.body) {
    throw new CliContractError(
      "INVALID_DOWNLOAD_RESPONSE",
      "OpenCloud returned no file body",
    );
  }
  const destination = path.resolve(input.destination);
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const digest = createHash("sha256");
  let size = 0;
  let sha256 = "";
  try {
    if (!input.force) {
      await assertPathAbsent(destination, "OUTPUT_FILE_EXISTS");
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const handle = await open(temporary, "wx", 0o600);
    const output = handle.createWriteStream({ autoClose: true });
    const source = Readable.fromWeb(
      input.response
        .body as unknown as import("node:stream/web").ReadableStream,
    );
    source.on("data", (chunk: Buffer) => {
      size += chunk.length;
      digest.update(chunk);
      if (input.expected && size > input.expected.bytes) {
        source.destroy(new CliContractError("DOWNLOAD_INTEGRITY_FAILED", "Download exceeds its declared size"));
      }
    });
    await pipeline(source, output);
    sha256 = digest.digest("hex");
    if (input.expected && (size !== input.expected.bytes || sha256 !== input.expected.sha256)) {
      throw new CliContractError("DOWNLOAD_INTEGRITY_FAILED", "Download size or SHA-256 does not match the export; no output file was replaced");
    }
    if (input.force) {
      await rename(temporary, destination);
    } else {
      await link(temporary, destination);
      await rm(temporary, { force: true });
    }
  } catch (error) {
    if (!input.response.body.locked) await input.response.body.cancel().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return { output: destination, size, sha256 };
}

const credentialPattern =
  /(?:\bBearer\s+\S+|\b(?:oc_(?:owner|agent|app)|sk|gh[pousr])[-_][A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/gi;

/** Replaces bearer tokens, OpenCloud, provider and GitHub keys, and JWTs. */
export function redactCredentials(value: string): string {
  return value.replace(credentialPattern, "[REDACTED]");
}

function redactMessage(value: unknown): string {
  return redactCredentials(String(value ?? "OpenCloud command failed")).slice(
    0,
    2_000,
  );
}

function safeCode(value: unknown, fallback: string): string {
  const code = String(value ?? "");
  return /^[A-Z][A-Z0-9_]{1,99}$/.test(code) ? code : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The listed identifiers of an error's details that are strings or null. */
function identifiers(details: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.flatMap((name) =>
    (typeof details[name] === "string" && String(details[name]).length <= 200) || details[name] === null
      ? [[name, details[name]]]
      : []));
}

const shortText = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit;

/**
 * What a refused request's details say about the input, as OpenCloud names it:
 * the field, the values it accepts and their aliases (an unknown log surface),
 * the ones to use instead (a name that stands for lines of several), and each
 * refused field with its reason (a malformed request). Only these, checked
 * and bounded, so nothing else in a body is printed.
 */
export function inputDetails(details: Record<string, unknown>): Record<string, unknown> | null {
  const picked: Record<string, unknown> = {};
  if (shortText(details.field, 200)) picked.field = details.field;
  if (Array.isArray(details.allowed) && details.allowed.length <= 50 && details.allowed.every((value) => shortText(value, 100))) {
    picked.allowed = details.allowed;
  }
  // The values to use instead, when one name stands for lines of several.
  if (Array.isArray(details.use) && details.use.length && details.use.length <= 10 && details.use.every((value) => shortText(value, 100))) {
    picked.use = details.use;
  }
  const aliases = record(details.aliases);
  const aliasEntries = Object.entries(aliases);
  if (aliasEntries.length && aliasEntries.length <= 50 && aliasEntries.every(([name, value]) => shortText(name, 100) && shortText(value, 100))) {
    picked.aliases = Object.fromEntries(aliasEntries);
  }
  if (Array.isArray(details.fields)) {
    const fields = details.fields.slice(0, 20).map(record).filter((value) => shortText(value.field, 200) && shortText(value.message, 300))
      .map((value) => ({ field: value.field, ...(shortText(value.code, 100) ? { code: value.code } : {}), message: redactMessage(value.message) }));
    if (fields.length) picked.fields = fields;
  }
  return Object.keys(picked).length ? picked : null;
}

/**
 * A definite refusal: OpenCloud answered with a 4xx code of its own, not
 * retryable and naming no operation, so the request took no effect. A proxy's
 * uncoded answer, a timeout and a retryable code (which may mean the same
 * request is still being handled) are not. Nor is a compute code whose
 * effects are not yet known, such as COMPUTE_OUTCOME_UNKNOWN, a 409.
 */
export function isDefiniteRefusal(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status < 400 || error.status > 499 || error.status === 408) return false;
  if (error.retryable || error.operation !== null || typeof error.code !== "string" || !error.code) return false;
  const compute = computeErrorCodeSchema.safeParse(error.code);
  if (compute.success) {
    const { origin, retryScope } = computeErrorCatalog[compute.data];
    return origin !== "unknown" && retryScope !== "observer_reconciliation";
  }
  return true;
}

/** The next step OpenCloud names for an error, in `details.suggestedFix`. */
function suggestedFix(details: Record<string, unknown>): string | null {
  const value = details.suggestedFix;
  return typeof value === "string" && value.trim() ? redactMessage(value.trim()).slice(0, 500) : null;
}

/**
 * Names the releases involved and the way forward: the server's own next step
 * when it gives one (a development session production overtook is stopped
 * and started again), otherwise pull or --force for a stale copy.
 */
function staleReleaseFields(details: Record<string, unknown>): Record<string, unknown> {
  return {
    ...identifiers(details, ["latestDeploymentId", "latestVersion", "expectedActiveDeploymentId", "actualActiveDeploymentId"]),
    hint: suggestedFix(details) ??
      "Run opencloud pull <directory> to update this copy and reapply your change, or pass --force to replace the latest release.",
  };
}

/** Development sessions OpenCloud refuses because they were overtaken, stopped or expired. */
const DEV_SESSION_REFUSALS = new Set(["DEV_SESSION_STALE", "DEV_SESSION_STOPPED", "DEV_SESSION_EXPIRED"]);

function apiErrorFields(error: ApiError): Record<string, unknown> {
  const body =
    error.body && typeof error.body === "object"
      ? (error.body as Record<string, unknown>)
      : {};
  const nested =
    body.error && typeof body.error === "object"
      ? (body.error as Record<string, unknown>)
      : {};
  const code = safeCode(body.code ?? nested.code, `HTTP_${error.status}`);
  const compute = computeErrorSchema.safeParse({
    statusCode: error.status, code, message: body.message ?? error.message, details: error.details,
  });
  const details = Object.keys(record(body.details)).length ? record(body.details) : record(nested.details);
  const fix = code === "ACTIVE_DEPLOYMENT_CHANGED" ? null : suggestedFix(details);
  const input = compute.success ? null : inputDetails(details);
  return {
    code,
    message: redactMessage(body.message ?? nested.message ?? error.message),
    status: error.status,
    ...(code === "ACTIVE_DEPLOYMENT_CHANGED" ? staleReleaseFields(details) : {}),
    // details.status names the session's state; `status` is already the HTTP status.
    ...(DEV_SESSION_REFUSALS.has(code)
      ? { ...identifiers(details, ["sessionId"]), ...(typeof details.status === "string" ? { sessionStatus: details.status } : {}),
          ...identifiers(details, ["baseDeploymentId"]) }
      : {}),
    ...(fix ? { hint: fix } : {}),
    ...(compute.success ? { details: compute.data.details } : input ? { details: input } : {}),
    retryable:
      compute.success ? compute.data.details.retryable : typeof body.retryable === "boolean"
        ? body.retryable
        : typeof nested.retryable === "boolean"
          ? nested.retryable
          // As the client read it: details.retryable, else 408, 425, 429 and 5xx.
          : error.retryable,
    ...(typeof body.requestId === "string"
      ? { requestId: body.requestId }
      : typeof nested.requestId === "string"
        ? { requestId: nested.requestId }
        : error.requestId
          ? { requestId: error.requestId }
          : {}),
  };
}

const causeCodePattern = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * The first coded cause below an error, such as ECONNREFUSED, ENOTFOUND,
 * CERT_HAS_EXPIRED or UND_ERR_CONNECT_TIMEOUT below fetch's "fetch failed".
 */
export function errorCause(
  error: unknown,
): { code: string; message: string | null } | null {
  let current: unknown =
    error && typeof error === "object"
      ? (error as { cause?: unknown }).cause
      : undefined;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const value = current as {
      code?: unknown;
      message?: unknown;
      errors?: unknown;
      cause?: unknown;
    };
    // Node reports a failed connection to several addresses as an AggregateError.
    const first = Array.isArray(value.errors)
      ? (value.errors[0] as { message?: unknown } | undefined)
      : undefined;
    if (typeof value.code === "string" && causeCodePattern.test(value.code)) {
      const message =
        typeof value.message === "string" && value.message
          ? value.message
          : typeof first?.message === "string" && first.message
            ? first.message
            : null;
      return { code: value.code, message };
    }
    current = value.cause ?? first;
  }
  return null;
}

const PENDING_STATES = new Set(["prepared", "attempted", "unknown", "completed"]);
const PENDING_IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The unresolved journal entry an error is about, as the journal retained it:
 * its command, key, state and server coordinates, checked field by field.
 */
function pendingFields(error: unknown): Record<string, unknown> | null {
  const value = record((error as { pending?: unknown } | null)?.pending);
  if (typeof value.command !== "string" || !/^opencloud [a-z][a-z -]{0,80}$/.test(value.command) ||
      typeof value.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/.test(value.idempotencyKey) ||
      typeof value.state !== "string" || !PENDING_STATES.has(value.state)) return null;
  return {
    command: value.command,
    idempotencyKey: value.idempotencyKey,
    generatedKey: value.generatedKey === true,
    state: value.state,
    ...(typeof value.unknownCode === "string" && /^[A-Z][A-Z0-9_]{1,99}$/.test(value.unknownCode) ? { unknownCode: value.unknownCode } : {}),
    ...Object.fromEntries(["appId", "operationId", "draftId", "sessionId"].flatMap((name) =>
      typeof value[name] === "string" && PENDING_IDENTIFIER.test(String(value[name])) ? [[name, value[name]]] : [])),
    ...(Number.isSafeInteger(value.revision) && Number(value.revision) > 0 ? { revision: value.revision } : {}),
  };
}

/** The keys every structured error owns; extra fields never replace them. */
const RESERVED_FIELDS = new Set(["code", "message", "status", "retryable", "details", "issues", "cause", "requestId", "pending", "hint"]);

/** Extra identifiers a CLI error names, such as the releases involved. */
function contractFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof CliContractError) || !error.fields) return {};
  return Object.fromEntries(Object.entries(error.fields).flatMap(([name, value]) =>
    /^[a-z][A-Za-z0-9]{0,63}$/.test(name) && !RESERVED_FIELDS.has(name) && (value === null || typeof value === "number" ||
      typeof value === "boolean" || (typeof value === "string" && value.length <= 200)) ? [[name, value]] : []));
}

/**
 * A failure as the CLI prints it, with what to run next: the unresolved
 * mutation it concerns and a hint added for this failure, which replaces a
 * generic one in place.
 */
export function structuredCliError(error: unknown): {
  ok: false;
  error: Record<string, unknown>;
} {
  const fields = structuredFields(error);
  const pending = pendingFields(error);
  const hint = hintOf(error);
  return {
    ok: false,
    error: {
      ...fields,
      ...contractFields(error),
      ...(pending ? { pending } : {}),
      ...(hint ? { hint: redactMessage(hint) } : {}),
    },
  };
}

/**
 * The error OpenCloud recorded on a release, as printed with its failed
 * operation: code, message and the details the compute contract defines
 * (such as exitCode, signal or workloadName), each checked against its own
 * schema, so a partial set is kept and nothing else is printed.
 */
function deploymentErrorFields(deployment: { id: string; error: Record<string, unknown> }): Record<string, unknown> {
  const { error } = deployment;
  const message = typeof error.message === "string" && error.message ? redactMessage(error.message).slice(0, 500) : null;
  const given = record(error.details);
  const details = Object.fromEntries(Object.entries(computeErrorDetailsSchema.shape).flatMap(([name, schema]) => {
    const parsed = given[name] === undefined ? null : schema.safeParse(given[name]);
    return parsed?.success ? [[name, parsed.data]] : [];
  }));
  return {
    deploymentId: deployment.id,
    deploymentError: {
      code: safeCode(error.code, "DEPLOYMENT_ERROR"),
      ...(message ? { message } : {}),
      ...(Object.keys(details).length ? { details } : {}),
    },
  };
}

function structuredFields(error: unknown): Record<string, unknown> {
  if (error instanceof ApiError) {
    return apiErrorFields(error);
  }
  if (error instanceof OperationTerminalError) {
    const operationError = record(error.operation.error);
    return {
      code: error.code,
      message: redactMessage(error.message),
      retryable: false,
      operationId: error.operation.id,
      operationState: error.operation.state,
      ...(error.operation.error && typeof error.operation.error === "object"
        ? {
            operationErrorCode: safeCode(operationError.code, "OPERATION_ERROR"),
            ...(typeof operationError.message === "string" && operationError.message
              ? { operationErrorMessage: redactMessage(operationError.message).slice(0, 500) }
              : {}),
          }
        : {}),
      ...(error.deployment ? deploymentErrorFields(error.deployment) : {}),
    };
  }
  if (error instanceof OperationWaitTimeoutError) {
    return {
      code: error.code,
      message: redactMessage(error.message),
      retryable: true,
      operationId: error.operation.id,
      operationState: error.operation.state,
    };
  }
  const candidate =
    error && typeof error === "object"
      ? (error as { code?: unknown; retryable?: unknown; message?: unknown })
      : {};
  const cause = errorCause(error);
  const requestId = requestIdForError(error);
  // A Zod error's message is its whole issue tree as JSON; list each problem instead.
  const issues = error instanceof CliContractError ? error.issues
    : isZodError(error) ? readableIssues(error.issues) : undefined;
  const message = isZodError(error) && issues?.length
    ? issueSummary("The input", issues)
    : error instanceof Error ? error.message : (candidate.message ?? error);
  const details = error instanceof CliContractError && error.details ? inputDetails(error.details) : null;
  return {
    code: safeCode(candidate.code, "CLI_ERROR"),
    message: redactMessage(message),
    retryable: candidate.retryable === true,
    ...(details ? { details } : {}),
    ...(issues?.length
      ? { issues: issues.slice(0, 50).map((issue) => ({ path: issue.path, message: redactMessage(issue.message).slice(0, 500) })) }
      : {}),
    ...(cause
      ? {
          cause: {
            code: cause.code,
            ...(cause.message
              ? { message: redactMessage(cause.message).slice(0, 500) }
              : {}),
          },
        }
      : {}),
    ...(requestId ? { requestId } : {}),
  };
}
