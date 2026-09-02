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

export class CliContractError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "CliContractError";
    this.retryable = options.retryable ?? false;
  }
}

export class OperationTerminalError extends CliContractError {
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
    const source =
      input.inline ??
      (await readFile(input.resolvePath(String(input.file)), "utf8"));
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
    throw new OperationTerminalError(operation);
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
    throw new OperationTerminalError(operation);
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
}): Promise<{ output: string; size: number; sha256: string }> {
  if (!input.response.body) {
    throw new CliContractError(
      "INVALID_DOWNLOAD_RESPONSE",
      "OpenCloud returned no file body",
    );
  }
  const destination = path.resolve(input.destination);
  if (!input.force) {
    await assertPathAbsent(destination, "OUTPUT_FILE_EXISTS");
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const digest = createHash("sha256");
  let size = 0;
  try {
    const handle = await open(temporary, "wx", 0o600);
    const output = handle.createWriteStream({ autoClose: true });
    const source = Readable.fromWeb(
      input.response
        .body as unknown as import("node:stream/web").ReadableStream,
    );
    source.on("data", (chunk: Buffer) => {
      size += chunk.length;
      digest.update(chunk);
    });
    await pipeline(source, output);
    if (input.force) {
      await rename(temporary, destination);
    } else {
      await link(temporary, destination);
      await rm(temporary, { force: true });
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return { output: destination, size, sha256: digest.digest("hex") };
}

const credentialPattern =
  /(?:\bBearer\s+\S+|\b(?:oc_(?:owner|agent|app)|sk|gh[pousr])[-_][A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/gi;

function redactMessage(value: unknown): string {
  return String(value ?? "OpenCloud command failed")
    .replace(credentialPattern, "[REDACTED]")
    .slice(0, 2_000);
}

function safeCode(value: unknown, fallback: string): string {
  const code = String(value ?? "");
  return /^[A-Z][A-Z0-9_]{1,99}$/.test(code) ? code : fallback;
}

function apiErrorFields(error: ApiError): Record<string, unknown> {
  const body =
    error.body && typeof error.body === "object"
      ? (error.body as Record<string, unknown>)
      : {};
  const nested =
    body.error && typeof body.error === "object"
      ? (body.error as Record<string, unknown>)
      : {};
  return {
    code: safeCode(body.code ?? nested.code, `HTTP_${error.status}`),
    message: redactMessage(body.message ?? nested.message ?? error.message),
    status: error.status,
    retryable:
      typeof body.retryable === "boolean"
        ? body.retryable
        : typeof nested.retryable === "boolean"
          ? nested.retryable
          : error.status >= 500,
    ...(typeof body.requestId === "string"
      ? { requestId: body.requestId }
      : typeof nested.requestId === "string"
        ? { requestId: nested.requestId }
        : {}),
  };
}

export function structuredCliError(error: unknown): {
  ok: false;
  error: Record<string, unknown>;
} {
  if (error instanceof ApiError) {
    return { ok: false, error: apiErrorFields(error) };
  }
  if (error instanceof OperationTerminalError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: redactMessage(error.message),
        retryable: false,
        operationId: error.operation.id,
        operationState: error.operation.state,
        ...(error.operation.error && typeof error.operation.error === "object"
          ? {
              operationErrorCode: safeCode(
                (error.operation.error as Record<string, unknown>).code,
                "OPERATION_ERROR",
              ),
            }
          : {}),
      },
    };
  }
  if (error instanceof OperationWaitTimeoutError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: redactMessage(error.message),
        retryable: true,
        operationId: error.operation.id,
        operationState: error.operation.state,
      },
    };
  }
  const candidate =
    error && typeof error === "object"
      ? (error as { code?: unknown; retryable?: unknown; message?: unknown })
      : {};
  return {
    ok: false,
    error: {
      code: safeCode(candidate.code, "CLI_ERROR"),
      message: redactMessage(
        error instanceof Error ? error.message : (candidate.message ?? error),
      ),
      retryable: candidate.retryable === true,
    },
  };
}
