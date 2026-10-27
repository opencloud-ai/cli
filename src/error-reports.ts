import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommanderError, type Command } from "commander";
import { ApiError } from "./api-client.js";
import {
  COMMAND_VARIABLE,
  PRODUCT_NAME_VARIABLE,
  brandText,
  resolveBrand,
} from "./brand.js";
import { isCallerFailure } from "./caller-failure.js";
import {
  cliUserAgent,
  getCliVersion,
  newRequestId,
  runtimeDescription,
  withCliHeaders,
} from "./cli-http.js";
import {
  OperationTerminalError,
  errorCause,
  redactCredentials,
  structuredCliError,
} from "./owner-parity.js";

/**
 * Automatic error reports. When a command fails unexpectedly, the CLI sends
 * one short, redacted report to the API the command used. Reporting never
 * changes the command's output, stderr or exit code, never retries, and
 * waits at most ERROR_REPORT_TIMEOUT_MS.
 */

export const ERROR_REPORT_ENDPOINT = "/v1/platform-errors/reports";
export const ERROR_REPORT_TIMEOUT_MS = 2_500;
export const TELEMETRY_SETTINGS_FILE = "telemetry.json";

export const ERROR_REPORT_NOTICE = [
  "OpenCloud CLI sends error reports to OpenCloud to help fix problems. A report",
  "includes the command name, error details, the CLI version and your operating",
  "system, and is linked to your signed-in account. To turn reports off, run",
  "`opencloud telemetry disable` or set OPENCLOUD_TELEMETRY=0.",
].join("\n");

/** The platform's limits; a report outside them is refused as a whole. */
const LIMITS = {
  bodyBytes: 64 * 1024,
  message: 2_000,
  stack: 16_000,
  route: 300,
  name: 120,
  code: 120,
  release: 80,
  client: 100,
  contextKeys: 40,
  contextString: 500,
} as const;

const UUID =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTEXT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface TelemetrySettings {
  schemaVersion: 1;
  /** Absent until `opencloud telemetry enable` or `disable` runs. */
  errorReports?: boolean;
  /** When the one-time terminal notice was shown. */
  noticeShownAt?: string;
}

export type ErrorReportMode = "send" | "log" | "off";
export type ErrorReportSource =
  | "default"
  | "config"
  | "env:OPENCLOUD_TELEMETRY"
  | "env:DO_NOT_TRACK";

export interface ErrorReportSettings {
  mode: ErrorReportMode;
  source: ErrorReportSource;
  settingsFile: string;
  stored: TelemetrySettings;
}

/** A missing or unreadable settings file means the defaults. */
export function readTelemetrySettings(file: string): TelemetrySettings {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { schemaVersion: 1 };
  }
  if (!value || typeof value !== "object") return { schemaVersion: 1 };
  const stored = value as Record<string, unknown>;
  if (stored.schemaVersion !== 1) return { schemaVersion: 1 };
  return {
    schemaVersion: 1,
    ...(typeof stored.errorReports === "boolean"
      ? { errorReports: stored.errorReports }
      : {}),
    ...(typeof stored.noticeShownAt === "string"
      ? { noticeShownAt: stored.noticeShownAt }
      : {}),
  };
}

/** Atomically replaces the settings file with a mode-0600 copy. */
export function writeTelemetrySettings(
  file: string,
  settings: TelemetrySettings,
): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(settings)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, file);
    if (process.platform !== "win32") chmodSync(file, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const TELEMETRY_OFF = new Set(["0", "false", "off", "no"]);
const TELEMETRY_ON = new Set(["1", "true", "on", "yes"]);

/**
 * OPENCLOUD_TELEMETRY=log only prints reports, so it applies even with
 * DO_NOT_TRACK. Otherwise DO_NOT_TRACK wins, then OPENCLOUD_TELEMETRY, then
 * the settings file; reports are on by default.
 */
export function resolveErrorReportSettings(
  env: NodeJS.ProcessEnv,
  settingsFile: string,
): ErrorReportSettings {
  const stored = readTelemetrySettings(settingsFile);
  const base = { settingsFile, stored };
  const telemetry = env.OPENCLOUD_TELEMETRY?.trim().toLowerCase() ?? "";
  const doNotTrack = env.DO_NOT_TRACK?.trim() ?? "";
  if (telemetry === "log") {
    return { ...base, mode: "log", source: "env:OPENCLOUD_TELEMETRY" };
  }
  if (doNotTrack && doNotTrack !== "0") {
    return { ...base, mode: "off", source: "env:DO_NOT_TRACK" };
  }
  if (TELEMETRY_OFF.has(telemetry)) {
    return { ...base, mode: "off", source: "env:OPENCLOUD_TELEMETRY" };
  }
  if (TELEMETRY_ON.has(telemetry)) {
    return { ...base, mode: "send", source: "env:OPENCLOUD_TELEMETRY" };
  }
  if (stored.errorReports !== undefined) {
    return { ...base, mode: stored.errorReports ? "send" : "off", source: "config" };
  }
  return { ...base, mode: "send", source: "default" };
}

export function errorReportStatus(settings: ErrorReportSettings): {
  errorReports: boolean;
  mode: ErrorReportMode;
  source: ErrorReportSource;
  settingsFile: string;
} {
  return {
    errorReports: settings.mode === "send",
    mode: settings.mode,
    source: settings.source,
    settingsFile: settings.settingsFile,
  };
}

/**
 * CLI codes for outcomes the caller resolves, which, like Commander's usage
 * errors and API 4xx answers, are not faults in the CLI or OpenCloud: a
 * missing or invalid argument, option or input, a refusal to overwrite or
 * replace without --force, another unresolved mutation, something that does
 * not exist or is too large, and an app that failed the validation OpenCloud
 * ran. Every other code is reported.
 */
const CALLER_OUTCOME_CODES = new Set([
  "ACTIVE_DEPLOYMENT_CHANGED",
  "APP_MISMATCH",
  "APP_OWNER_IDEMPOTENCY_KEY_REQUIRED",
  "APP_REQUIRED",
  "BACKUP_NOT_FOUND",
  "DEPLOYMENT_REQUIRED",
  "DEV_SESSION_NOT_FOUND",
  "DEV_VERIFICATION_FAILED",
  "DRAFT_VALIDATION_FAILED",
  "INVALID_DRAFT_CHANGES",
  "INVALID_IDEMPOTENCY_KEY",
  "INVALID_INTEGRATION_EVENT",
  "INVALID_INTEGRATION_NAME",
  "INVALID_JSON",
  "INVALID_JSON_SHAPE",
  "INVALID_OPTION",
  "INVALID_OPTIONS",
  "LOCAL_CHANGES",
  "MUTATION_APP_BINDING_MISMATCH",
  "MUTATION_AUTHORITY_SOURCE_CONFLICT",
  "MUTATION_IN_PROGRESS",
  "NO_LIVE_RELEASE",
  "OUTPUT_FILE_EXISTS",
  "PLATFORM_BUILD_UNSUPPORTED",
  "SECRET_INPUT_REQUIRED",
  "SECRET_TOO_LARGE",
  "SOURCE_TOO_LARGE",
  "TOKEN_FILE_EXISTS",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isCommanderError(error: unknown): boolean {
  if (error instanceof CommanderError) return true;
  const code = record(error)?.code;
  return typeof code === "string" && code.startsWith("commander.");
}

/**
 * A failure is reported when the CLI itself failed, OpenCloud answered 5xx
 * or not at all, or a durable operation failed or has an unknown outcome.
 * API 4xx answers, usage errors, a missing login, an invalid manifest and
 * cancelled operations are outcomes for the caller, not faults.
 */
export function isReportableFailure(error: unknown): boolean {
  if (isCommanderError(error) || isCallerFailure(error)) return false;
  if (error instanceof ApiError) {
    return error.status >= 500 || record(error.operation)?.state === "failed";
  }
  if (error instanceof OperationTerminalError) {
    return error.operation.state === "failed";
  }
  return !CALLER_OUTCOME_CODES.has(String(structuredCliError(error).error.code));
}

/**
 * An error the bundler raises on purpose about the app's source: its own
 * plain Error, a manifest schema error, or a YAML or JSON parse error. A
 * TypeError, RangeError or system error from the bundler is a fault.
 */
export function isSourceValidationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Node raises system and internal errors as plain Errors too.
  const raised = error as { syscall?: unknown; errno?: unknown; code?: unknown };
  if (
    typeof raised.syscall === "string" ||
    typeof raised.errno === "number" ||
    (typeof raised.code === "string" && raised.code.startsWith("ERR_"))
  ) {
    return false;
  }
  return (
    error.constructor === Error ||
    error.constructor === SyntaxError ||
    error.name === "ZodError" ||
    error.name.startsWith("YAML")
  );
}

export function isTelemetryRoute(route: string | null): boolean {
  return route === "telemetry" || Boolean(route?.startsWith("telemetry "));
}

export interface RedactionOptions {
  /** Replaced with `~`. */
  homeDirectory?: string | null | undefined;
  /** Replaced with `<tmp>`; on Windows it can name the user. */
  temporaryDirectory?: string | null | undefined;
  /** Argument, option and environment values, replaced with `[VALUE]`. */
  privateValues?: readonly string[] | undefined;
  /** Whether paths ignore case, as on Windows and macOS; defaults to this platform. */
  ignorePathCase?: boolean | undefined;
}

const openCloudToken = /\b(?:oc|github_pat)_[A-Za-z0-9][A-Za-z0-9_-]{7,}/g;
const basicCredential = /\bBasic\s+[A-Za-z0-9+/=._-]{8,}/gi;
const secretName =
  /password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|signature|authorization|cookie|credential/i;
/**
 * name=value, name: value, "name": "value" and { name: 'value' }. A name
 * starts after a separator and has at most 64 characters, so matching stays
 * linear on long runs of name characters.
 */
const assignment =
  /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z0-9_.-]{1,64})\1(\s*[:=]\s*)("(?:[^"\\\n]|\\.){0,2000}"|'(?:[^'\\\n]|\\.){0,2000}'|[^\s"'&,;)\]}]{1,2000})/g;
const urlPattern = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;
/** File systems that ignore case, where a path can be written either way. */
const caseInsensitivePaths =
  process.platform === "win32" || process.platform === "darwin";

/** Values that can identify something; short numbers, booleans and one or two characters cannot. */
function scrubbableValues(values: readonly string[]): string[] {
  return [...new Set(values)]
    .filter(
      (value) =>
        typeof value === "string" &&
        value.length >= 3 &&
        !/^(?:[+-]?\d{1,5}(?:\.\d+)?|true|false|null)$/i.test(value),
    )
    .sort((left, right) => right.length - left.length);
}

const wordCharacter = /[A-Za-z0-9]/;
const pathNameCharacter = /[A-Za-z0-9._-]/;

/**
 * Replaces target wherever it is not part of a longer word or name. Plain
 * searching has no size limit, unlike a regular expression of a long value.
 */
function replaceStandalone(
  text: string,
  target: string,
  replacement: string,
  nameCharacter: RegExp,
  ignoreCase: boolean,
): string {
  // Case folding that changes lengths (rare Unicode) falls back to exact matching.
  const fold =
    ignoreCase &&
    text.toLowerCase().length === text.length &&
    target.toLowerCase().length === target.length;
  const haystack = fold ? text.toLowerCase() : text;
  const needle = fold ? target.toLowerCase() : target;
  if (!needle) return text;
  let result = "";
  let copied = 0;
  for (let index = haystack.indexOf(needle); index >= 0; ) {
    const end = index + needle.length;
    const before = text.charAt(index - 1);
    const after = text.charAt(end);
    if ((!before || !nameCharacter.test(before)) && (!after || !nameCharacter.test(after))) {
      result += text.slice(copied, index) + replacement;
      copied = end;
      index = haystack.indexOf(needle, end);
    } else {
      index = haystack.indexOf(needle, index + 1);
    }
  }
  return result + text.slice(copied);
}

/** A directory as written and as resolved, such as macOS's /private/var. */
function directoryForms(directory: string | null | undefined): string[] {
  if (!directory || directory.length < 2 || path.parse(directory).root === directory) {
    return [];
  }
  let resolved = directory;
  try {
    resolved = realpathSync(directory);
  } catch {
    // A directory that does not exist is only matched as written.
  }
  return [...new Set([directory, resolved].flatMap((form) => [form, form.replaceAll("\\", "/")]))];
}

/** Strips URL credentials, query strings and fragments, keeping trailing punctuation. */
function withoutUrlExtras(url: string): string {
  const trailing = /[).,;:!\]]*$/.exec(url)?.[0] ?? "";
  return (
    url
      .slice(0, url.length - trailing.length)
      .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/i, "$1")
      .replace(/[?#].*$/, "") + trailing
  );
}

function redactAssignment(
  match: string,
  quote: string,
  name: string,
  separator: string,
  value: string,
): string {
  if (!secretName.test(name) || /^\[(?:REDACTED|VALUE)\b/.test(value)) return match;
  const redacted = value.startsWith('"')
    ? '"[REDACTED]"'
    : value.startsWith("'")
      ? "'[REDACTED]'"
      : "[REDACTED]";
  return `${quote}${name}${quote}${separator}${redacted}`;
}

/**
 * Removes private values, the home and temporary directories, credentials
 * and URL queries. The patterns are built once for all of a report's text.
 */
function createRedactor(options: RedactionOptions): (value: string) => string {
  const ignorePathCase = options.ignorePathCase ?? caseInsensitivePaths;
  const replacements: Array<(text: string) => string> = [
    ...scrubbableValues(options.privateValues ?? []).map(
      (secret) => (text: string) =>
        replaceStandalone(text, secret, "[VALUE]", wordCharacter, true),
    ),
    // /home/alice, but not /home/alice.old or /mnt/home/alice. The longest
    // form goes first, as the temporary directory can be in the home directory.
    ...[
      ...directoryForms(options.temporaryDirectory).map((form) => [form, "<tmp>"] as const),
      ...directoryForms(options.homeDirectory).map((form) => [form, "~"] as const),
    ]
      .sort(([left], [right]) => right.length - left.length)
      .map(
        ([directory, replacement]) => (text: string) =>
          replaceStandalone(text, directory, replacement, pathNameCharacter, ignorePathCase),
      ),
  ];
  return (value) => {
    let text = value;
    for (const replace of replacements) text = replace(text);
    return redactCredentials(text)
      .replace(openCloudToken, "[REDACTED]")
      .replace(basicCredential, "Basic [REDACTED]")
      .replace(assignment, redactAssignment)
      .replace(urlPattern, withoutUrlExtras);
  };
}

export function redactReportText(
  value: string,
  options: RedactionOptions = {},
): string {
  return createRedactor(options)(value);
}

/**
 * Parsers quote the file they read: YAML prints the lines after a blank
 * line, and V8 quotes JSON input. Keep the description, not the excerpt.
 */
function withoutSourceExcerpts(message: string): string {
  return (message.split(/\r?\n[ \t]*\r?\n/, 1)[0] ?? "").replace(
    /"[\s\S]*"(?:\.\.\.)? is not valid JSON/g,
    '"[CONTENT]" is not valid JSON',
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = Math.max(0, max - 1);
  // Never leave half of a surrogate pair.
  if (/[\uD800-\uDBFF]/.test(value.charAt(end - 1))) end -= 1;
  return `${value.slice(0, end)}…`;
}

type ContextValue = string | number | boolean | null;

export interface CliErrorReport {
  source: "cli";
  kind: "cli_error" | "cli_crash";
  occurredAt: string;
  message: string;
  errorName: string | null;
  errorCode: string | null;
  stack: string | null;
  requestId: string | null;
  operationId: string | null;
  httpStatus: number | null;
  appId: string | null;
  release: string;
  route: string | null;
  client: {
    name: "opencloud-cli";
    version: string;
    platform: string;
    arch: string;
    runtime: string;
  };
  context: Record<string, ContextValue>;
}

/** What a report may say about the command that failed. */
export interface FailureContext {
  /** The command path without values, such as `app dev start`. */
  route: string | null;
  /** Names of the options the command was given, such as `--api-url`. */
  optionNames: readonly string[];
  /** Argument and option values, which never leave the machine. */
  privateValues: readonly string[];
  /** The connected directory's or runtime session's app. */
  appId: string | null;
  hostedAgent: boolean;
}

export interface ReportInput extends FailureContext {
  kind: CliErrorReport["kind"];
  crashOrigin?: string | null | undefined;
  occurredAt: Date;
  durationMs: number;
  exitCode: number;
  env: NodeJS.ProcessEnv;
  homeDirectory: string | null;
  temporaryDirectory?: string | null | undefined;
  stdoutIsTTY: boolean;
}

const CI_VARIABLES = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "TF_BUILD",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "CODEBUILD_BUILD_ID",
];

function isCi(env: NodeJS.ProcessEnv): boolean {
  return CI_VARIABLES.some((name) => {
    const value = env[name]?.trim().toLowerCase();
    return Boolean(value) && value !== "0" && value !== "false";
  });
}

/**
 * Settings rather than private values: the telemetry switch and an installer
 * wrapper's brand names. Removing a brand's name would remove that word, such
 * as "sprout", wherever a report uses it.
 */
const SETTING_VARIABLES = new Set([
  "OPENCLOUD_TELEMETRY",
  PRODUCT_NAME_VARIABLE,
  COMMAND_VARIABLE,
]);

/** Values of OpenCloud's own environment variables, such as paths and URLs. */
export function environmentValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(
      ([name, value]) =>
        name.startsWith("OPENCLOUD_") &&
        !SETTING_VARIABLES.has(name) &&
        typeof value === "string",
    )
    .map(([, value]) => value as string);
}

function errorName(error: unknown): string | null {
  const name =
    error instanceof Error ? error.name : record(error)?.name;
  return typeof name === "string" && name ? truncate(name, LIMITS.name) : null;
}

function messageOf(error: unknown, structured: Record<string, unknown>): string {
  // An API error's message is the API's own, as the CLI printed it.
  if (error instanceof ApiError) return String(structured.message ?? "");
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(structured.message ?? "");
}

/** The stack's frames under a header rebuilt from the redacted message. */
function reportStack(
  error: unknown,
  name: string | null,
  message: string,
  redact: (text: string) => string,
): string | null {
  const stack =
    error instanceof Error && typeof error.stack === "string"
      ? error.stack
      : null;
  if (!stack) return null;
  const frames = stack
    .split("\n")
    .filter((line) => /^\s+at\s/.test(line))
    .slice(0, 200)
    .map((line) => redact(line.slice(0, 1_000)));
  if (!frames.length) return null;
  return truncate(`${name ?? "Error"}: ${message}\n${frames.join("\n")}`, LIMITS.stack);
}

function errorSyscall(error: unknown): string | null {
  const syscall = record(error)?.syscall ?? record(record(error)?.cause)?.syscall;
  return typeof syscall === "string" && /^[a-z_]{1,40}$/.test(syscall)
    ? syscall
    : null;
}

function sanitizeContext(
  context: Record<string, unknown>,
): Record<string, ContextValue> {
  const result: Record<string, ContextValue> = {};
  for (const [key, value] of Object.entries(context)) {
    if (Object.keys(result).length >= LIMITS.contextKeys) break;
    if (!CONTEXT_KEY.test(key)) continue;
    if (value === null || typeof value === "boolean") result[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "string") {
      result[key] = truncate(value, LIMITS.contextString);
    }
  }
  return result;
}

function optional<T>(value: unknown, valid: (candidate: unknown) => candidate is T): T | null {
  return valid(value) ? value : null;
}

const isRequestId = (value: unknown): value is string =>
  typeof value === "string" && REQUEST_ID.test(value);
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
const isHttpStatus = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 599;

export function buildErrorReport(
  error: unknown,
  input: ReportInput,
): CliErrorReport {
  const structured = structuredCliError(error).error;
  const redact = createRedactor({
    homeDirectory: input.homeDirectory,
    temporaryDirectory: input.temporaryDirectory,
    privateValues: input.privateValues,
  });
  const name = errorName(error);
  // Redaction can shorten a message, so it runs on more than the limit, but
  // bounded; a word cut at that bound is dropped, as it would no longer match.
  const fullMessage = messageOf(error, structured);
  const boundedMessage =
    fullMessage.length > LIMITS.message * 4
      ? fullMessage.slice(0, LIMITS.message * 4).replace(/\S*$/, "")
      : fullMessage;
  const message = truncate(
    redact(withoutSourceExcerpts(boundedMessage)).trim() || "OpenCloud command failed",
    LIMITS.message,
  );
  const cause = errorCause(error);
  const apiOperation = error instanceof ApiError ? record(error.operation) : null;
  const version = getCliVersion();
  return {
    source: "cli",
    kind: input.kind,
    occurredAt: input.occurredAt.toISOString(),
    message,
    errorName: name,
    errorCode:
      typeof structured.code === "string"
        ? truncate(structured.code, LIMITS.code)
        : null,
    stack: reportStack(error, name, message, redact),
    requestId: optional(structured.requestId, isRequestId),
    operationId:
      optional(structured.operationId, isUuid) ?? optional(apiOperation?.id, isUuid),
    httpStatus: error instanceof ApiError ? optional(error.status, isHttpStatus) : null,
    appId: optional(input.appId, isUuid),
    release: truncate(version, LIMITS.release),
    route: input.route ? truncate(input.route, LIMITS.route) : null,
    client: {
      name: "opencloud-cli",
      version: truncate(version, LIMITS.client),
      platform: truncate(process.platform, LIMITS.client),
      arch: truncate(process.arch, LIMITS.client),
      runtime: truncate(runtimeDescription(), LIMITS.client),
    },
    context: sanitizeContext({
      exitCode: input.exitCode,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      retryable: structured.retryable === true,
      ci: isCi(input.env),
      tty: input.stdoutIsTTY,
      hostedAgent: input.hostedAgent,
      ...(typeof structured.operationState === "string"
        ? { operationState: structured.operationState }
        : typeof apiOperation?.state === "string"
          ? { operationState: apiOperation.state }
          : {}),
      ...(typeof structured.operationErrorCode === "string"
        ? { operationErrorCode: structured.operationErrorCode }
        : {}),
      ...(cause ? { causeCode: cause.code } : {}),
      ...(errorSyscall(error) ? { syscall: errorSyscall(error) } : {}),
      ...(input.crashOrigin ? { crashOrigin: input.crashOrigin } : {}),
      nodeZlib: process.versions.zlib ?? null,
      osRelease: os.release(),
      options: input.optionNames.join(","),
    }),
  };
}

/** One report as the request body, kept under the platform's 64 KB limit. */
export function serializeReport(report: CliErrorReport): string {
  let current = report;
  let body = JSON.stringify({ reports: [current] });
  // Escaped characters can make the JSON longer than its character limits.
  while (Buffer.byteLength(body) > LIMITS.bodyBytes) {
    if (current.stack) {
      const half = Math.floor(current.stack.length / 2);
      current = { ...current, stack: half >= 200 ? truncate(current.stack, half) : null };
    } else if (current.message.length > 100) {
      current = { ...current, message: truncate(current.message, Math.floor(current.message.length / 2)) };
    } else {
      current = { ...current, context: {} };
      body = JSON.stringify({ reports: [current] });
      break;
    }
    body = JSON.stringify({ reports: [current] });
  }
  return body;
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) if (typeof item === "string") into.push(item);
  }
}

/**
 * The route, option names and private values of the command about to run.
 * A value that names a path is also kept resolved, as messages show it.
 */
export function describeInvocation(
  command: Command,
  cwd?: string,
): Pick<FailureContext, "route" | "optionNames" | "privateValues"> {
  let base: string | null;
  try {
    base = cwd ?? process.env.INIT_CWD ?? process.cwd();
  } catch {
    // The working directory was removed; values are still removed as given.
    base = null;
  }
  const route: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    route.unshift(current.name());
  }
  const optionNames = new Set<string>();
  const values: string[] = [];
  for (let current: Command | null = command; current; current = current.parent) {
    for (const option of current.options) {
      const key = option.attributeName();
      const source = current.getOptionValueSource(key);
      if (source === undefined || source === "default") continue;
      const value: unknown = current.getOptionValue(key);
      // A --no-x and its --x share one value.
      if (option.negate ? value !== false : value === false) continue;
      optionNames.add(option.long ?? option.short ?? key);
      if (!option.argChoices) collectStrings(value, values);
    }
  }
  command.registeredArguments.forEach((argument, index) => {
    if (!argument.argChoices) collectStrings(command.processedArgs[index], values);
  });
  return {
    route: route.length ? truncate(route.join(" "), LIMITS.route) : null,
    optionNames: [...optionNames].sort(),
    privateValues: values.flatMap((value) =>
      base && value && !value.includes("://") ? [value, path.resolve(base, value)] : [value],
    ),
  };
}

/** Where a report goes and with which credential, resolved when it is sent. */
export interface FailureSource {
  context: FailureContext;
  /** The API the command used, else the one it is configured for. */
  apiUrl: string | null;
  /** A bearer token that belongs to apiUrl, or null to report anonymously. */
  credential(): string | null;
}

/** A stored credential, as the credential store holds it. */
export type StoredApiCredential =
  | { kind: "account"; apiUrl: string; accessToken: string; accessExpiresAt: string }
  | { kind: "workspace"; apiUrl: string; appId: string; token: string; expiresAt: string };

export interface ReportAuthorityInput {
  /** The API base URL of the command's last request. */
  lastUsedApiUrl: string | null;
  /** --api-url or OPENCLOUD_API_URL. */
  apiUrlOption?: string | undefined;
  /** --token or OPENCLOUD_TOKEN. */
  tokenOption?: string | undefined;
  /** The connected directory's binding. */
  workspace: { apiUrl: string; appId: string } | null;
  session: {
    state: string;
    apiUrl: string;
    schemaVersion?: number;
    appId?: string;
    token?: string;
  } | null;
  defaultApiUrl: string;
  /** Canonical API URL, or throws when it is not one. */
  normalize: (apiUrl: string) => string;
  /** The bearer token this process sent to an API. */
  usedCredential: (apiUrl: string) => string | null;
  /** Credentials this process already loaded or saved, newest last. */
  knownCredentials: () => readonly StoredApiCredential[];
  /** The stored account login, read without the OS credential service. */
  storedAccount: (apiUrl: string) => StoredApiCredential | null;
  now?: number | undefined;
}

/**
 * The API a report goes to, the app it concerns, and its credential: the
 * token the command sent to that API; else its --token where the command
 * would send it; else the runtime session's; else a login or workspace
 * credential this process already loaded; else a login kept in the
 * protected file. The OS credential service is never opened for a report:
 * it can block or prompt. Nothing that belongs to another API is used.
 */
export function resolveReportAuthority(
  input: ReportAuthorityInput,
): Pick<FailureSource, "apiUrl" | "credential"> &
  Pick<FailureContext, "appId" | "hostedAgent"> {
  const canonical = (value: string | null | undefined): string | null => {
    if (!value) return null;
    try {
      return input.normalize(value);
    } catch {
      return null;
    }
  };
  const session = input.session?.state === "ready" ? input.session : null;
  const apiUrl = canonical(
    input.lastUsedApiUrl ??
      input.apiUrlOption ??
      input.workspace?.apiUrl ??
      input.session?.apiUrl ??
      input.defaultApiUrl,
  );
  // client() sends --token to this API, and a ready session's token to its own.
  const tokenApiUrl = canonical(
    input.apiUrlOption ?? input.workspace?.apiUrl ?? input.session?.apiUrl,
  );
  const appId = input.workspace?.appId ?? session?.appId ?? null;
  const valid = (credential: StoredApiCredential | null): string | null => {
    if (!credential || canonical(credential.apiUrl) !== apiUrl) return null;
    // Another app's credential would attribute the report to that app.
    if (credential.kind === "workspace" && appId && credential.appId !== appId) return null;
    const expiresAt =
      credential.kind === "account" ? credential.accessExpiresAt : credential.expiresAt;
    return Date.parse(expiresAt) > (input.now ?? Date.now()) + 5_000
      ? credential.kind === "account"
        ? credential.accessToken
        : credential.token
      : null;
  };
  return {
    apiUrl,
    appId,
    hostedAgent: session?.schemaVersion === 2,
    credential: () => {
      if (!apiUrl) return null;
      const used = input.usedCredential(apiUrl);
      if (used) return used;
      if (input.tokenOption && tokenApiUrl === apiUrl) return input.tokenOption;
      if (
        !input.workspace &&
        session &&
        typeof session.token === "string" &&
        canonical(session.apiUrl) === apiUrl
      ) {
        return session.token;
      }
      for (const credential of [...input.knownCredentials()].reverse()) {
        const token = valid(credential);
        if (token) return token;
      }
      return valid(input.storedAccount(apiUrl));
    },
  };
}

export interface CrashReportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface ErrorReporterOptions {
  settingsFile: string;
  source: () => FailureSource;
  env?: NodeJS.ProcessEnv | undefined;
  stderr?: { isTTY?: boolean | undefined; write(text: string): unknown } | undefined;
  stdoutIsTTY?: boolean | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  homeDirectory?: string | null | undefined;
  now?: (() => Date) | undefined;
  /** Writes to stderr while the process crashes. */
  writeSync?: ((text: string) => void) | undefined;
  /** Sends a crash report and returns once it is sent or abandoned. */
  sendSync?: ((request: CrashReportRequest) => void) | undefined;
}

export type ReportOutcome =
  | "skipped"
  | "excluded"
  | "not_reportable"
  | "disabled"
  | "logged"
  | "no_destination"
  | "sent"
  | "refused"
  | "failed";

/** Runs in a child process: Node cannot wait for a request while it crashes. */
const CRASH_SENDER = `
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  let request;
  try { request = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { process.exit(0); }
  fetch(request.url, { method: "POST", headers: request.headers, body: request.body, redirect: "manual", signal: AbortSignal.timeout(request.timeoutMs) })
    .then((response) => response.body && response.body.cancel())
    .catch(() => undefined)
    .finally(() => process.exit(0));
});
`;

function sendFromChildProcess(request: CrashReportRequest): void {
  spawnSync(process.execPath, ["-e", CRASH_SENDER], {
    input: JSON.stringify({ ...request, timeoutMs: Math.max(1, request.timeoutMs - 500) }),
    timeout: request.timeoutMs,
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
}

interface PreparedReport {
  settings: ErrorReportSettings;
  apiUrl: string | null;
  token: string | null;
  body: string;
}

export class ErrorReporter {
  private reported = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly stderr: { isTTY?: boolean | undefined; write(text: string): unknown };
  private readonly timeoutMs: number;

  constructor(private readonly options: ErrorReporterOptions) {
    this.env = options.env ?? process.env;
    this.stderr = options.stderr ?? process.stderr;
    this.timeoutMs = options.timeoutMs ?? ERROR_REPORT_TIMEOUT_MS;
  }

  settings(): ErrorReportSettings {
    return resolveErrorReportSettings(this.env, this.options.settingsFile);
  }

  status(): ReturnType<typeof errorReportStatus> {
    return errorReportStatus(this.settings());
  }

  /** Records an explicit choice; the one-time notice is only for the default. */
  configure(errorReports: boolean): void {
    const stored = readTelemetrySettings(this.options.settingsFile);
    writeTelemetrySettings(this.options.settingsFile, { ...stored, errorReports });
  }

  /** Reports a failed command. Never throws, writes only the notice or log, and is bounded in time. */
  async reportFailure(error: unknown): Promise<ReportOutcome> {
    try {
      const prepared = this.prepare(error, "cli_error");
      if (typeof prepared === "string") return prepared;
      const { settings, apiUrl, token, body } = prepared;
      if (settings.mode === "log") {
        this.stderr.write(`${body}\n`);
        return "logged";
      }
      if (!apiUrl) return "no_destination";
      this.showNoticeOnce(settings, (text) => this.stderr.write(text));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      timer.unref?.();
      try {
        const response = await withCliHeaders(this.options.fetch)(
          `${apiUrl}${ERROR_REPORT_ENDPOINT}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body,
            redirect: "manual",
            signal: controller.signal,
          },
        );
        await response.body?.cancel().catch(() => undefined);
        return response.status === 202 ? "sent" : "refused";
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return "failed";
    }
  }

  /**
   * Reports an uncaught exception or unhandled rejection from Node's
   * monitor, which runs before Node prints the crash and exits as usual.
   */
  reportCrash(error: unknown, origin: string): ReportOutcome {
    try {
      // A closed output pipe, as in `opencloud app list | head -1`, is not a fault.
      if (record(error)?.code === "EPIPE") return "not_reportable";
      const prepared = this.prepare(error, "cli_crash", origin);
      if (typeof prepared === "string") return prepared;
      const { settings, apiUrl, token, body } = prepared;
      const write = this.options.writeSync ?? ((text: string) => writeSync(2, text));
      if (settings.mode === "log") {
        write(`${body}\n`);
        return "logged";
      }
      if (!apiUrl) return "no_destination";
      this.showNoticeOnce(settings, write);
      (this.options.sendSync ?? sendFromChildProcess)({
        url: `${apiUrl}${ERROR_REPORT_ENDPOINT}`,
        headers: {
          "content-type": "application/json",
          "user-agent": cliUserAgent(),
          "x-request-id": newRequestId(),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body,
        timeoutMs: this.timeoutMs,
      });
      return "sent";
    } catch {
      return "failed";
    }
  }

  installCrashMonitor(): void {
    process.on("uncaughtExceptionMonitor", (error, origin) => {
      this.reportCrash(error, origin);
    });
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private prepare(
    error: unknown,
    kind: CliErrorReport["kind"],
    crashOrigin?: string,
  ): ReportOutcome | PreparedReport {
    if (this.reported) return "skipped";
    if (kind === "cli_error" && !isReportableFailure(error)) return "not_reportable";
    const source = this.options.source();
    if (isTelemetryRoute(source.context.route)) return "excluded";
    const settings = this.settings();
    if (settings.mode === "off") return "disabled";
    // One report per process, however it ends.
    this.reported = true;
    const token = source.credential();
    const privateValues = [
      ...source.context.privateValues,
      ...environmentValues(this.env),
      ...(token ? [token] : []),
    ];
    const report = buildErrorReport(error, {
      ...source.context,
      privateValues,
      kind,
      crashOrigin: crashOrigin ?? null,
      occurredAt: this.now(),
      durationMs: performance.now(),
      exitCode: 1,
      env: this.env,
      homeDirectory:
        this.options.homeDirectory === undefined ? os.homedir() : this.options.homeDirectory,
      temporaryDirectory: process.platform === "win32" ? os.tmpdir() : null,
      stdoutIsTTY: this.options.stdoutIsTTY ?? process.stdout.isTTY === true,
    });
    return { settings, apiUrl: source.apiUrl, token, body: serializeReport(report) };
  }

  /** Before the first report sent by default, tell a person in a terminal once. */
  private showNoticeOnce(
    settings: ErrorReportSettings,
    write: (text: string) => unknown,
  ): void {
    if (
      settings.source !== "default" ||
      settings.stored.noticeShownAt !== undefined ||
      this.stderr.isTTY !== true
    ) {
      return;
    }
    write(`${brandText(ERROR_REPORT_NOTICE, resolveBrand(this.env))}\n`);
    try {
      writeTelemetrySettings(settings.settingsFile, {
        ...settings.stored,
        noticeShownAt: this.now().toISOString(),
      });
    } catch {
      // The notice shows again next time when the setting cannot be kept.
    }
  }
}
