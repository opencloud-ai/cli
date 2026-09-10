import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  type Stats,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import {
  mutationDisposition,
  type MutationCommandId,
  type MutationRecoveryDisposition,
} from "./mutation-dispositions.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;
const CREDENTIAL_LIKE =
  /(?:\bBearer\b|(?:oc_(?:owner|agent|app)|sk|gh[pousr])[-_][A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 5_000;
const JOURNAL_ROOT_ENTRIES = new Set([
  ".binding-lock",
  ".binding-lock.lock",
  ".identity-lock-target",
  ".identity-lock-target.lock",
  ".identity.json",
  "binding.json",
  "entries",
  "locks",
]);
const ORPHAN_BINDING_TEMP =
  /^\.binding\.json\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;
const ORPHAN_IDENTITY_TEMP =
  /^\.\.identity\.json\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

export const MUTATION_JOURNAL_ENV = "OPENCLOUD_MUTATION_JOURNAL_DIR";
export const APP_OWNER_MUTATION_JOURNAL_DIRECTORY =
  "/workspace/.opencloud/agent-mutations" as const;

export function assertAppOwnerMutationJournalDirectory(
  configuredDirectory: string | undefined,
): typeof APP_OWNER_MUTATION_JOURNAL_DIRECTORY {
  if (configuredDirectory !== APP_OWNER_MUTATION_JOURNAL_DIRECTORY) {
    throw new MutationJournalError(
      "INVALID_APP_OWNER_MUTATION_JOURNAL_DIRECTORY",
      `${MUTATION_JOURNAL_ENV} must equal ${APP_OWNER_MUTATION_JOURNAL_DIRECTORY} for an app-owner runtime`,
    );
  }
  return APP_OWNER_MUTATION_JOURNAL_DIRECTORY;
}

export class MutationJournalError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "MutationJournalError";
    this.retryable = retryable;
  }
}

export interface MutationJournalDirectoryInput {
  configuredDirectory?: string | undefined;
  workspaceFile?: string | undefined;
  configDirectory: string;
  apiUrl: string;
  appId: string;
}

export interface MutationJournalOpenInput {
  directory: string;
  apiUrl: string;
  appId: string;
  authority?: MutationJournalAuthorityBinding | undefined;
  rejectParentSymlinks?: boolean | undefined;
  requireMountPoint?: boolean | undefined;
  now?: (() => Date) | undefined;
  /** Test-only crash injection after a durable initialization boundary. */
  onInitializationCheckpoint?:
    | ((
        checkpoint: MutationJournalInitializationCheckpoint,
      ) => void | Promise<void>)
    | undefined;
}

export type MutationJournalInitializationCheckpoint =
  | "identity_durable"
  | "binding_durable"
  | "ready_durable";

export interface MutationJournalAuthorityBinding {
  rootRunId: string;
  familyId: string;
}

export interface SafeMutationCheckpoint {
  stage: string;
  artifactSha256?: string | undefined;
  draftId?: string | undefined;
  sessionId?: string | undefined;
  activeRevisionId?: string | undefined;
  receiptId?: string | undefined;
  verificationId?: string | undefined;
  operationId?: string | undefined;
  deploymentOperationId?: string | undefined;
  verificationOperationId?: string | undefined;
  revision?: number | undefined;
  offset?: number | undefined;
  localStateStored?: boolean | undefined;
  devStopped?: boolean | undefined;
}

export interface MutationIntentSpec {
  commandId: MutationCommandId;
  safeScope: unknown;
  safeRequest: unknown;
  explicitIdempotencyKey?: string | undefined;
  retireDevStoppedWorkflow?: boolean | undefined;
}

interface MutationJournalBinding {
  schemaVersion: 2;
  journalId: string;
  apiBaseSha256: string;
  appId: string;
}

interface MutationJournalIdentityWitness {
  schemaVersion: 2 | 3;
  state: "initializing" | "ready";
  journalId: string;
  apiBaseSha256: string;
  appId: string;
  rootDev: string;
  rootIno: string;
  rootUid: string | null;
  entriesDev: string;
  entriesIno: string;
  entriesUid: string | null;
  locksDev: string;
  locksIno: string;
  locksUid: string | null;
}

type MutationEntryState = "prepared" | "attempted" | "unknown" | "completed";

interface MutationJournalEntry {
  schemaVersion: 1;
  entryId: string;
  commandId: MutationCommandId;
  disposition: MutationRecoveryDisposition;
  scopeDigest: string;
  requestDigest: string;
  idempotencyKey: string;
  authorityRootRunId: string | null;
  authorityFamilyId: string | null;
  state: MutationEntryState;
  attemptCount: number;
  attemptedAt: string | null;
  operationId: string | null;
  checkpoint: SafeMutationCheckpoint | null;
  unknownCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const BINDING_KEYS = [
  "apiBaseSha256",
  "appId",
  "journalId",
  "schemaVersion",
].sort();
const WITNESS_V2_KEYS = [
  "apiBaseSha256",
  "appId",
  "entriesDev",
  "entriesIno",
  "entriesUid",
  "journalId",
  "locksDev",
  "locksIno",
  "locksUid",
  "rootDev",
  "rootIno",
  "rootUid",
  "schemaVersion",
].sort();
const WITNESS_V3_KEYS = [...WITNESS_V2_KEYS, "state"].sort();
const ENTRY_KEYS = [
  "attemptCount",
  "attemptedAt",
  "authorityFamilyId",
  "authorityRootRunId",
  "checkpoint",
  "commandId",
  "completedAt",
  "createdAt",
  "disposition",
  "entryId",
  "idempotencyKey",
  "operationId",
  "requestDigest",
  "schemaVersion",
  "scopeDigest",
  "state",
  "unknownCode",
  "updatedAt",
].sort();
const CHECKPOINT_KEYS = new Set([
  "stage",
  "artifactSha256",
  "draftId",
  "sessionId",
  "activeRevisionId",
  "receiptId",
  "verificationId",
  "operationId",
  "deploymentOperationId",
  "verificationOperationId",
  "revision",
  "offset",
  "localStateStored",
  "devStopped",
]);

function normalizedApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MutationJournalError(
      "INVALID_MUTATION_JOURNAL_BINDING",
      "The mutation journal API URL is invalid",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new MutationJournalError(
      "INVALID_MUTATION_JOURNAL_BINDING",
      "The mutation journal API URL must be an HTTP(S) URL without credentials, query, or fragment",
    );
  }
  return url.href.replace(/\/+$/, "");
}

function assertAppId(appId: string): void {
  if (!UUID.test(appId)) {
    throw new MutationJournalError(
      "INVALID_MUTATION_JOURNAL_BINDING",
      "The mutation journal app ID must be a UUID",
    );
  }
}

function identityDigest(apiUrl: string, appId: string): string {
  return createHash("sha256")
    .update(normalizedApiUrl(apiUrl))
    .update("\0")
    .update(appId.toLowerCase())
    .digest("hex");
}

function apiBaseSha256(apiUrl: string): string {
  return createHash("sha256")
    .update(normalizedApiUrl(apiUrl))
    .digest("hex");
}

export function resolveMutationJournalDirectory(
  input: MutationJournalDirectoryInput,
): string {
  assertAppId(input.appId);
  const configured = input.configuredDirectory;
  if (configured !== undefined) {
    if (!configured.trim() || !path.isAbsolute(configured)) {
      throw new MutationJournalError(
        "INVALID_MUTATION_JOURNAL_DIRECTORY",
        `${MUTATION_JOURNAL_ENV} must be a non-empty absolute path`,
      );
    }
    return path.normalize(configured);
  }
  const suffix = identityDigest(input.apiUrl, input.appId);
  if (input.workspaceFile) {
    return path.join(
      path.dirname(path.resolve(input.workspaceFile)),
      "agent-mutations",
      suffix,
    );
  }
  return path.join(
    path.resolve(input.configDirectory),
    "mutation-journals",
    suffix,
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MutationJournalError(
        "INVALID_MUTATION_DESCRIPTOR",
        "Mutation descriptors cannot contain non-finite numbers",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new MutationJournalError(
    "INVALID_MUTATION_DESCRIPTOR",
    "Mutation descriptors must contain only JSON-compatible values",
  );
}

export function mutationDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validateIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!SAFE_IDEMPOTENCY_KEY.test(key) || CREDENTIAL_LIKE.test(key)) {
    throw new MutationJournalError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency keys must be 8 through 200 credential-safe letters, numbers, dots, colons, underscores, or dashes",
    );
  }
  return key;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

function parseBinding(raw: string, file: string): MutationJournalBinding {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new MutationJournalError(
      "CORRUPT_MUTATION_JOURNAL",
      `Mutation journal binding is not valid JSON: ${file}`,
    );
  }
  if (
    !value ||
    typeof value !== "object" ||
    !exactKeys(value as Record<string, unknown>, BINDING_KEYS) ||
    (value as Record<string, unknown>).schemaVersion !== 2 ||
    typeof (value as Record<string, unknown>).journalId !== "string" ||
    !UUID.test(String((value as Record<string, unknown>).journalId)) ||
    typeof (value as Record<string, unknown>).apiBaseSha256 !== "string" ||
    !SHA256.test(
      String((value as Record<string, unknown>).apiBaseSha256),
    ) ||
    typeof (value as Record<string, unknown>).appId !== "string"
  ) {
    throw new MutationJournalError(
      "CORRUPT_MUTATION_JOURNAL",
      `Mutation journal binding has an invalid schema: ${file}`,
    );
  }
  const binding = value as MutationJournalBinding;
  assertAppId(binding.appId);
  return binding;
}

function parseIdentityWitness(
  raw: string,
  file: string,
): MutationJournalIdentityWitness {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new MutationJournalError(
      "CORRUPT_MUTATION_JOURNAL",
      `Mutation journal identity witness is not valid JSON: ${file}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MutationJournalError(
      "CORRUPT_MUTATION_JOURNAL",
      `Mutation journal identity witness has an invalid schema: ${file}`,
    );
  }
  const item = value as Record<string, unknown>;
  const witnessKeys =
    item.schemaVersion === 2
      ? WITNESS_V2_KEYS
      : item.schemaVersion === 3
        ? WITNESS_V3_KEYS
        : null;
  if (
    witnessKeys === null ||
    !exactKeys(item, witnessKeys) ||
    (item.schemaVersion === 3 &&
      item.state !== "initializing" &&
      item.state !== "ready") ||
    typeof item.journalId !== "string" ||
    !UUID.test(item.journalId) ||
    typeof item.apiBaseSha256 !== "string" ||
    !SHA256.test(item.apiBaseSha256) ||
    typeof item.appId !== "string" ||
    !UUID.test(item.appId) ||
    typeof item.rootDev !== "string" ||
    !/^\d+$/.test(item.rootDev) ||
    typeof item.rootIno !== "string" ||
    !/^\d+$/.test(item.rootIno) ||
    typeof item.entriesDev !== "string" ||
    !/^\d+$/.test(item.entriesDev) ||
    typeof item.entriesIno !== "string" ||
    !/^\d+$/.test(item.entriesIno) ||
    typeof item.locksDev !== "string" ||
    !/^\d+$/.test(item.locksDev) ||
    typeof item.locksIno !== "string" ||
    !/^\d+$/.test(item.locksIno) ||
    !(
      item.rootUid === null ||
      (typeof item.rootUid === "string" && /^\d+$/.test(item.rootUid))
    ) ||
    !(
      item.entriesUid === null ||
      (typeof item.entriesUid === "string" && /^\d+$/.test(item.entriesUid))
    ) ||
    !(
      item.locksUid === null ||
      (typeof item.locksUid === "string" && /^\d+$/.test(item.locksUid))
    )
  ) {
    throw new MutationJournalError(
      "CORRUPT_MUTATION_JOURNAL",
      `Mutation journal identity witness has an invalid schema: ${file}`,
    );
  }
  return {
    ...item,
    state: item.schemaVersion === 2 ? "ready" : item.state,
  } as unknown as MutationJournalIdentityWitness;
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function parseCheckpoint(value: unknown): SafeMutationCheckpoint | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some((key) => !CHECKPOINT_KEYS.has(key)) ||
    typeof candidate.stage !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(candidate.stage)
  ) {
    return null;
  }
  for (const key of [
    "draftId",
    "sessionId",
    "activeRevisionId",
    "receiptId",
    "verificationId",
    "operationId",
    "deploymentOperationId",
    "verificationOperationId",
  ]) {
    if (candidate[key] !== undefined && !UUID.test(String(candidate[key]))) {
      return null;
    }
  }
  if (
    candidate.artifactSha256 !== undefined &&
    !SHA256.test(String(candidate.artifactSha256))
  ) {
    return null;
  }
  for (const key of ["revision", "offset"]) {
    if (
      candidate[key] !== undefined &&
      (!Number.isSafeInteger(candidate[key]) || Number(candidate[key]) < 0)
    ) {
      return null;
    }
  }
  for (const key of ["localStateStored", "devStopped"]) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "boolean") {
      return null;
    }
  }
  return candidate as unknown as SafeMutationCheckpoint;
}

function parseEntry(raw: string, file: string): MutationJournalEntry {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new MutationJournalError(
      "CORRUPT_MUTATION_JOURNAL",
      `Mutation journal entry is not valid JSON: ${file}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MutationJournalError(
      "CORRUPT_MUTATION_JOURNAL",
      `Mutation journal entry has an invalid schema: ${file}`,
    );
  }
  const item = value as Record<string, unknown>;
  const checkpoint = parseCheckpoint(item.checkpoint);
  const valid =
    exactKeys(item, ENTRY_KEYS) &&
    item.schemaVersion === 1 &&
    typeof item.entryId === "string" &&
    UUID.test(item.entryId) &&
    typeof item.commandId === "string" &&
    typeof item.disposition === "string" &&
    typeof item.scopeDigest === "string" &&
    SHA256.test(item.scopeDigest) &&
    typeof item.requestDigest === "string" &&
    SHA256.test(item.requestDigest) &&
    typeof item.idempotencyKey === "string" &&
    SAFE_IDEMPOTENCY_KEY.test(item.idempotencyKey) &&
    ((item.authorityRootRunId === null && item.authorityFamilyId === null) ||
      (typeof item.authorityRootRunId === "string" &&
        UUID.test(item.authorityRootRunId) &&
        typeof item.authorityFamilyId === "string" &&
        UUID.test(item.authorityFamilyId))) &&
    ["prepared", "attempted", "unknown", "completed"].includes(
      String(item.state),
    ) &&
    Number.isSafeInteger(item.attemptCount) &&
    Number(item.attemptCount) >= 0 &&
    (item.attemptedAt === null || isIsoDate(item.attemptedAt)) &&
    (item.operationId === null ||
      (typeof item.operationId === "string" && UUID.test(item.operationId))) &&
    (item.checkpoint === null || checkpoint !== null) &&
    (item.unknownCode === null ||
      (typeof item.unknownCode === "string" &&
        /^[A-Z][A-Z0-9_]{1,99}$/.test(item.unknownCode))) &&
    isIsoDate(item.createdAt) &&
    isIsoDate(item.updatedAt) &&
    (item.completedAt === null || isIsoDate(item.completedAt));
  if (!valid) {
    throw new MutationJournalError(
      "CORRUPT_MUTATION_JOURNAL",
      `Mutation journal entry has an invalid schema: ${file}`,
    );
  }
  mutationDisposition(item.commandId as string);
  return { ...(item as unknown as MutationJournalEntry), checkpoint };
}

async function assertNoSymlinkComponents(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new MutationJournalError(
          "UNSAFE_MUTATION_JOURNAL_PATH",
          `Configured mutation journal path has a non-directory or symlink component: ${current}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function linuxMountInfoContains(
  mountInfo: string,
  directory: string,
): boolean {
  const expected = path.resolve(directory);
  for (const line of mountInfo.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const fields = line.slice(0, separator).split(" ");
    if (fields.length < 6) continue;
    if (path.resolve(decodeMountInfoPath(fields[4]!)) === expected) return true;
  }
  return false;
}

async function assertLinuxMountPoint(directory: string): Promise<void> {
  if (process.platform !== "linux") {
    throw new MutationJournalError(
      "UNSUPPORTED_MUTATION_JOURNAL_PLATFORM",
      "App-owner runtime mutation journals require a dedicated Linux mount",
    );
  }
  let mountInfo: string;
  try {
    mountInfo = await readFile("/proc/self/mountinfo", "utf8");
  } catch {
    throw new MutationJournalError(
      "UNSUPPORTED_MUTATION_JOURNAL_PLATFORM",
      "The app-owner runtime could not verify its dedicated mutation journal mount",
    );
  }
  if (!linuxMountInfoContains(mountInfo, directory)) {
    throw new MutationJournalError(
      "UNSAFE_MUTATION_JOURNAL_PATH",
      "The app-owner runtime mutation journal path is not its dedicated persistent mount",
    );
  }
}

async function secureDirectory(
  directory: string,
  rejectParentSymlinks = false,
  requireDedicatedJournalRoot = false,
): Promise<void> {
  const absolute = path.resolve(directory);
  if (requireDedicatedJournalRoot && absolute === path.parse(absolute).root) {
    throw new MutationJournalError(
      "UNSAFE_MUTATION_JOURNAL_PATH",
      "A filesystem root cannot be used as a mutation journal",
    );
  }
  if (rejectParentSymlinks) await assertNoSymlinkComponents(directory);
  let created = false;
  let metadata: Stats;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    created = (await mkdir(directory, { recursive: true, mode: 0o700 })) !== undefined;
    metadata = await lstat(directory);
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o700)
  ) {
    throw new MutationJournalError(
      "UNSAFE_MUTATION_JOURNAL_PATH",
      `Mutation journal path must be a mode-0700 real directory: ${directory}`,
    );
  }
  if (requireDedicatedJournalRoot && !created) {
    const unexpected = (await readdir(directory)).filter(
      (entry) =>
        !JOURNAL_ROOT_ENTRIES.has(entry) &&
        !ORPHAN_BINDING_TEMP.test(entry) &&
        !ORPHAN_IDENTITY_TEMP.test(entry),
    );
    if (unexpected.length > 0) {
      throw new MutationJournalError(
        "UNSAFE_MUTATION_JOURNAL_PATH",
        "The mutation journal directory contains files that are not owned by the journal",
      );
    }
  }
  if (rejectParentSymlinks) {
    await assertNoSymlinkComponents(directory);
    if ((await realpath(directory)) !== path.resolve(directory)) {
      throw new MutationJournalError(
        "UNSAFE_MUTATION_JOURNAL_PATH",
        "Configured mutation journal path resolves outside its fixed runtime location",
      );
    }
  }
}

interface SecureOpenedFile {
  handle: FileHandle;
  metadata: Stats;
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
  uid: number | null;
  canonicalPath: string;
}

interface RetainedDirectoryAnchor {
  handle: number | null;
  identity: DirectoryIdentity;
  anchoredPath: string;
}

async function directoryIdentity(directory: string): Promise<DirectoryIdentity> {
  if (!["linux", "darwin"].includes(process.platform)) {
    const metadata = await lstat(directory).catch(() => null);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      throw new MutationJournalError(
        "MUTATION_JOURNAL_ROOT_CHANGED",
        "The mutation journal root is no longer a real directory",
      );
    }
    const canonicalPath = await realpath(directory);
    const current = await lstat(directory).catch(() => null);
    if (
      !current?.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== metadata.dev ||
      current.ino !== metadata.ino ||
      current.uid !== metadata.uid
    ) {
      throw new MutationJournalError(
        "MUTATION_JOURNAL_ROOT_CHANGED",
        "The mutation journal root changed while its identity was inspected",
      );
    }
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      uid: typeof metadata.uid === "number" ? metadata.uid : null,
      canonicalPath,
    };
  }
  const flags =
    fsConstants.O_RDONLY |
    (process.platform === "win32"
      ? 0
      : fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  let first: FileHandle;
  try {
    first = await open(directory, flags);
  } catch {
    throw new MutationJournalError(
      "MUTATION_JOURNAL_ROOT_CHANGED",
      "The mutation journal root could not be opened as its original real directory",
    );
  }
  try {
    const metadata = await first.stat();
    if (!metadata.isDirectory()) {
      throw new MutationJournalError(
        "MUTATION_JOURNAL_ROOT_CHANGED",
        "The mutation journal root is no longer a real directory",
      );
    }
    const canonicalPath = await realpath(directory);
    const second = await open(directory, flags).catch(() => null);
    if (!second) {
      throw new MutationJournalError(
        "MUTATION_JOURNAL_ROOT_CHANGED",
        "The mutation journal root changed while its identity was inspected",
      );
    }
    try {
      const current = await second.stat();
      if (
        current.dev !== metadata.dev ||
        current.ino !== metadata.ino ||
        current.uid !== metadata.uid
      ) {
        throw new MutationJournalError(
          "MUTATION_JOURNAL_ROOT_CHANGED",
          "The mutation journal root changed while its identity was inspected",
        );
      }
    } finally {
      await second.close();
    }
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      uid: typeof metadata.uid === "number" ? metadata.uid : null,
      canonicalPath,
    };
  } finally {
    await first.close();
  }
}

async function anchoredDirectoryStats(directory: string): Promise<Stats> {
  const handle = await open(
    directory,
    fsConstants.O_RDONLY |
      (process.platform === "win32" ? 0 : fsConstants.O_DIRECTORY),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) {
      throw new MutationJournalError(
        "MUTATION_JOURNAL_ROOT_CHANGED",
        "The retained mutation journal anchor is not a directory",
      );
    }
    return metadata;
  } finally {
    await handle.close();
  }
}

async function retainDirectoryAnchor(
  directory: string,
  requireDescriptorPath = false,
): Promise<RetainedDirectoryAnchor> {
  const flags =
    fsConstants.O_RDONLY |
    (process.platform === "win32"
      ? 0
      : fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  if (
    requireDescriptorPath &&
    !["linux", "darwin"].includes(process.platform)
  ) {
    throw new MutationJournalError(
      "UNSUPPORTED_MUTATION_JOURNAL_PLATFORM",
      "This platform cannot retain an inode-anchored mutation journal directory",
    );
  }
  if (!["linux", "darwin"].includes(process.platform)) {
    return {
      handle: null,
      identity: await directoryIdentity(directory),
      anchoredPath: directory,
    };
  }
  const handle = openSync(directory, flags);
  try {
    const metadata = fstatSync(handle);
    if (!metadata.isDirectory()) {
      throw new MutationJournalError(
        "UNSAFE_MUTATION_JOURNAL_PATH",
        "The mutation journal root is not a directory",
      );
    }
    const identity = await directoryIdentity(directory);
    if (
      metadata.dev !== identity.dev ||
      metadata.ino !== identity.ino ||
      (typeof metadata.uid === "number" ? metadata.uid : null) !== identity.uid
    ) {
      throw new MutationJournalError(
        "MUTATION_JOURNAL_ROOT_CHANGED",
        "The mutation journal root changed while its anchor was retained",
      );
    }
    const anchoredPath =
      process.platform === "linux"
        ? `/proc/self/fd/${handle}`
        : process.platform === "darwin"
          ? `/dev/fd/${handle}`
          : directory;
    const anchoredIdentity = await anchoredDirectoryStats(anchoredPath);
    if (
      anchoredIdentity.dev !== identity.dev ||
      anchoredIdentity.ino !== identity.ino ||
      (typeof anchoredIdentity.uid === "number" ? anchoredIdentity.uid : null) !==
        identity.uid
    ) {
      throw new MutationJournalError(
        "UNSUPPORTED_MUTATION_JOURNAL_PLATFORM",
        "The operating system did not preserve the mutation journal directory anchor",
      );
    }
    return { handle, identity, anchoredPath };
  } catch (error) {
    closeSync(handle);
    throw error;
  }
}

async function openSecureRegularFile(
  file: string,
): Promise<SecureOpenedFile | null> {
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  let handle: FileHandle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new MutationJournalError(
      "UNSAFE_MUTATION_JOURNAL_PATH",
      `Mutation journal file could not be opened safely: ${file}`,
    );
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (process.platform !== "win32" &&
        (metadata.mode & 0o777) !== 0o600)
    ) {
      throw new MutationJournalError(
        "UNSAFE_MUTATION_JOURNAL_PATH",
        `Mutation journal file must be a mode-0600 regular file: ${file}`,
      );
    }
    return { handle, metadata };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function secureRegularFile(file: string): Promise<boolean> {
  const opened = await openSecureRegularFile(file);
  if (!opened) return false;
  await opened.handle.close();
  return true;
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const descriptorRoot = /^\/(?:proc\/self|dev)\/fd\/\d+$/.test(directory);
  const handle = await open(
    directory,
    fsConstants.O_RDONLY |
      fsConstants.O_DIRECTORY |
      (descriptorRoot ? 0 : fsConstants.O_NOFOLLOW),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) {
      throw new MutationJournalError(
        "UNSAFE_MUTATION_JOURNAL_PATH",
        `Mutation journal parent is not a real directory: ${directory}`,
      );
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function ensureLockTarget(file: string): Promise<void> {
  if (await secureRegularFile(file)) return;
  try {
    const handle = await open(file, "wx", 0o600);
    try {
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await secureRegularFile(file);
}

async function readOptional(file: string): Promise<string | null> {
  const opened = await openSecureRegularFile(file);
  if (!opened) return null;
  try {
    const value = await opened.handle.readFile("utf8");
    const current = await openSecureRegularFile(file);
    if (!current) {
      throw new MutationJournalError(
        "UNSAFE_MUTATION_JOURNAL_PATH",
        `Mutation journal file changed while it was being read: ${file}`,
      );
    }
    try {
      if (
        current.metadata.dev !== opened.metadata.dev ||
        current.metadata.ino !== opened.metadata.ino
      ) {
        throw new MutationJournalError(
          "UNSAFE_MUTATION_JOURNAL_PATH",
          `Mutation journal file changed while it was being read: ${file}`,
        );
      }
    } finally {
      await current.handle.close();
    }
    return value;
  } finally {
    await opened.handle.close();
  }
}

async function cleanupOrphanBindingTemps(directory: string): Promise<void> {
  for (const entry of await readdir(directory)) {
    if (!ORPHAN_BINDING_TEMP.test(entry)) continue;
    const file = path.join(directory, entry);
    const opened = await openSecureRegularFile(file);
    if (!opened) continue;
    await opened.handle.close();
    await rm(file);
  }
}

async function cleanupOrphanAtomicTemps(
  directory: string,
  targetBasename: string,
): Promise<void> {
  const escaped = targetBasename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^\\.${escaped}\\.\\d+\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$`,
    "i",
  );
  for (const entry of await readdir(directory)) {
    if (!pattern.test(entry)) continue;
    const file = path.join(directory, entry);
    const opened = await openSecureRegularFile(file);
    if (!opened) continue;
    await opened.handle.close();
    await rm(file);
  }
}

export class MutationRun {
  constructor(
    private readonly journal: MutationJournal,
    private entry: MutationJournalEntry,
    private readonly file: string,
    readonly recovered: boolean,
    private readonly assertBeforeEffect: () => Promise<void>,
    private readonly assertAnchored: () => Promise<void>,
  ) {}

  get idempotencyKey(): string {
    return this.entry.idempotencyKey;
  }

  get disposition(): MutationRecoveryDisposition {
    return this.entry.disposition;
  }

  get attempted(): boolean {
    return this.entry.attemptedAt !== null;
  }

  get operationId(): string | null {
    return this.entry.operationId;
  }

  get checkpoint(): SafeMutationCheckpoint | null {
    return this.entry.checkpoint;
  }

  get unknownCode(): string | null {
    return this.entry.unknownCode;
  }

  get completed(): boolean {
    return this.entry.state === "completed";
  }

  async markAttempted(): Promise<void> {
    await this.assertBeforeEffect();
    const now = this.journal.timestamp();
    this.entry = {
      ...this.entry,
      state: "attempted",
      attemptCount: this.entry.attemptCount + 1,
      attemptedAt: now,
      unknownCode: null,
      updatedAt: now,
      completedAt: null,
    };
    await atomicWrite(this.file, this.entry);
    await this.assertBeforeEffect();
  }

  async checkpointOperation(operationId: string): Promise<void> {
    await this.assertAnchored();
    if (!UUID.test(operationId)) {
      throw new MutationJournalError(
        "INVALID_OPERATION_RESPONSE",
        "OpenCloud did not return a valid durable operation identifier",
      );
    }
    const now = this.journal.timestamp();
    this.entry = {
      ...this.entry,
      state: "attempted",
      operationId,
      unknownCode: null,
      updatedAt: now,
      completedAt: null,
    };
    await atomicWrite(this.file, this.entry);
    await this.assertAnchored();
  }

  async checkpointStage(checkpoint: SafeMutationCheckpoint): Promise<void> {
    await this.assertAnchored();
    if (!parseCheckpoint(checkpoint)) {
      throw new MutationJournalError(
        "INVALID_MUTATION_CHECKPOINT",
        "Mutation checkpoint contains unsafe or invalid recovery coordinates",
      );
    }
    const now = this.journal.timestamp();
    this.entry = {
      ...this.entry,
      state: "attempted",
      operationId: checkpoint.operationId ?? this.entry.operationId,
      checkpoint: { ...checkpoint },
      unknownCode: null,
      updatedAt: now,
      completedAt: null,
    };
    await atomicWrite(this.file, this.entry);
    await this.assertAnchored();
  }

  async markUnknown(code = "MUTATION_OUTCOME_UNKNOWN"): Promise<never> {
    await this.assertAnchored();
    if (!/^[A-Z][A-Z0-9_]{1,99}$/.test(code)) {
      throw new MutationJournalError(
        "INVALID_MUTATION_CHECKPOINT",
        "Mutation unknown-outcome code is invalid",
      );
    }
    const now = this.journal.timestamp();
    this.entry = {
      ...this.entry,
      state: "unknown",
      unknownCode: code,
      updatedAt: now,
      completedAt: null,
    };
    await atomicWrite(this.file, this.entry);
    await this.assertAnchored();
    throw new MutationJournalError(
      code,
      "The previous request may have taken effect, but this endpoint has no safe replay coordinate. Inspect current app state, then retry with a new explicit --idempotency-key only when a new mutation is intended.",
    );
  }

  failIfUnknown(): void {
    if (this.entry.state === "unknown") {
      throw new MutationJournalError(
        this.entry.unknownCode ?? "MUTATION_OUTCOME_UNKNOWN",
        "The previous request may have taken effect, and the CLI will not retry it blindly. Inspect current app state, then use a new explicit --idempotency-key only when a new mutation is intended.",
      );
    }
  }

  async complete(): Promise<void> {
    await this.assertAnchored();
    const now = this.journal.timestamp();
    this.entry = {
      ...this.entry,
      state: "completed",
      unknownCode: null,
      updatedAt: now,
      completedAt: now,
    };
    await atomicWrite(this.file, this.entry);
    await this.assertAnchored();
  }
}

export class MutationJournal {
  readonly directory: string;
  private readonly rootHandle: number | null;
  private readonly entriesHandle: number | null;
  private readonly locksHandle: number | null;
  private readonly anchoredDirectory: string;
  private readonly entriesDirectory: string;
  private readonly locksDirectory: string;
  private readonly binding: MutationJournalBinding;
  private witness: MutationJournalIdentityWitness;
  private readonly witnessFile: string;
  private readonly rootIdentity: DirectoryIdentity;
  private readonly entriesIdentity: DirectoryIdentity;
  private readonly locksIdentity: DirectoryIdentity;
  private readonly authority: MutationJournalAuthorityBinding | null;
  private readonly requireMountPoint: boolean;
  private readonly now: () => Date;

  private constructor(
    input: MutationJournalOpenInput,
    rootAnchor: RetainedDirectoryAnchor,
    entriesAnchor: RetainedDirectoryAnchor,
    locksAnchor: RetainedDirectoryAnchor,
    witness: MutationJournalIdentityWitness,
    witnessFile: string,
  ) {
    this.directory = path.resolve(input.directory);
    this.rootHandle = rootAnchor.handle;
    this.entriesHandle = entriesAnchor.handle;
    this.locksHandle = locksAnchor.handle;
    this.anchoredDirectory = rootAnchor.anchoredPath;
    this.entriesDirectory = entriesAnchor.anchoredPath;
    this.locksDirectory = locksAnchor.anchoredPath;
    this.binding = {
      schemaVersion: 2,
      journalId: witness.journalId,
      apiBaseSha256: apiBaseSha256(input.apiUrl),
      appId: input.appId.toLowerCase(),
    };
    this.witness = witness;
    this.witnessFile = witnessFile;
    this.rootIdentity = rootAnchor.identity;
    this.entriesIdentity = entriesAnchor.identity;
    this.locksIdentity = locksAnchor.identity;
    this.authority = input.authority
      ? {
          rootRunId: input.authority.rootRunId.toLowerCase(),
          familyId: input.authority.familyId.toLowerCase(),
        }
      : null;
    this.requireMountPoint = input.requireMountPoint ?? false;
    this.now = input.now ?? (() => new Date());
  }

  static async open(input: MutationJournalOpenInput): Promise<MutationJournal> {
    assertAppId(input.appId);
    if (
      input.authority &&
      (!UUID.test(input.authority.rootRunId) ||
        !UUID.test(input.authority.familyId))
    ) {
      throw new MutationJournalError(
        "INVALID_MUTATION_JOURNAL_AUTHORITY",
        "The mutation journal authority root and family IDs must be UUIDs",
      );
    }
    const directory = path.resolve(input.directory);
    if (directory === path.parse(directory).root) {
      throw new MutationJournalError(
        "UNSAFE_MUTATION_JOURNAL_PATH",
        "A filesystem root cannot be used as a mutation journal",
      );
    }
    const parent = path.dirname(directory);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (input.rejectParentSymlinks) await assertNoSymlinkComponents(parent);
    if (input.requireMountPoint) await assertLinuxMountPoint(directory);
    await secureDirectory(
      directory,
      input.rejectParentSymlinks ?? false,
      true,
    );
    let rootAnchor: RetainedDirectoryAnchor | null = null;
    let entriesAnchor: RetainedDirectoryAnchor | null = null;
    let locksAnchor: RetainedDirectoryAnchor | null = null;
    try {
      rootAnchor = await retainDirectoryAnchor(
        directory,
        input.rejectParentSymlinks ?? false,
      );
      const namedEntriesDirectory = path.join(
        rootAnchor.anchoredPath,
        "entries",
      );
      const namedLocksDirectory = path.join(rootAnchor.anchoredPath, "locks");
      await secureDirectory(namedEntriesDirectory, false);
      await secureDirectory(namedLocksDirectory, false);
      entriesAnchor = await retainDirectoryAnchor(
        namedEntriesDirectory,
        input.requireMountPoint ?? false,
      );
      locksAnchor = await retainDirectoryAnchor(
        namedLocksDirectory,
        input.requireMountPoint ?? false,
      );
      const witnessParent = input.requireMountPoint
        ? rootAnchor.anchoredPath
        : parent;
      const witnessFile = input.requireMountPoint
        ? path.join(witnessParent, ".identity.json")
        : path.join(
            witnessParent,
            `.${path.basename(directory)}.mutation-journal-identity.json`,
          );
      const witnessLock = input.requireMountPoint
        ? path.join(witnessParent, ".identity-lock-target")
        : `${witnessFile}.lock-target`;
      await ensureLockTarget(witnessLock);
      const release = await lockfile.lock(witnessLock, {
        realpath: false,
        stale: LOCK_STALE_MS,
        update: LOCK_UPDATE_MS,
        retries: {
          retries: 100,
          factor: 1.2,
          minTimeout: 20,
          maxTimeout: 500,
        },
      });
      try {
        await cleanupOrphanAtomicTemps(
          witnessParent,
          path.basename(witnessFile),
        );
      const rawWitness = await readOptional(witnessFile);
      let witness: MutationJournalIdentityWitness;
      if (rawWitness === null) {
        witness = {
          schemaVersion: 3,
          state: "initializing",
          journalId: randomUUID(),
          apiBaseSha256: apiBaseSha256(input.apiUrl),
          appId: input.appId.toLowerCase(),
          rootDev: String(rootAnchor.identity.dev),
          rootIno: String(rootAnchor.identity.ino),
          rootUid:
            rootAnchor.identity.uid === null
              ? null
              : String(rootAnchor.identity.uid),
          entriesDev: String(entriesAnchor.identity.dev),
          entriesIno: String(entriesAnchor.identity.ino),
          entriesUid:
            entriesAnchor.identity.uid === null
              ? null
              : String(entriesAnchor.identity.uid),
          locksDev: String(locksAnchor.identity.dev),
          locksIno: String(locksAnchor.identity.ino),
          locksUid:
            locksAnchor.identity.uid === null
              ? null
              : String(locksAnchor.identity.uid),
        };
        await atomicWrite(witnessFile, witness);
        await input.onInitializationCheckpoint?.("identity_durable");
      } else {
        witness = parseIdentityWitness(rawWitness, witnessFile);
        if (
          witness.apiBaseSha256 !== apiBaseSha256(input.apiUrl) ||
          witness.appId.toLowerCase() !== input.appId.toLowerCase()
        ) {
          throw new MutationJournalError(
            "MUTATION_JOURNAL_BINDING_MISMATCH",
            "The configured mutation journal identity belongs to a different OpenCloud API or app",
          );
        }
        if (
          witness.rootDev !== String(rootAnchor.identity.dev) ||
          witness.rootIno !== String(rootAnchor.identity.ino) ||
          witness.rootUid !==
            (rootAnchor.identity.uid === null
              ? null
              : String(rootAnchor.identity.uid)) ||
          witness.entriesDev !== String(entriesAnchor.identity.dev) ||
          witness.entriesIno !== String(entriesAnchor.identity.ino) ||
          witness.entriesUid !==
            (entriesAnchor.identity.uid === null
              ? null
              : String(entriesAnchor.identity.uid)) ||
          witness.locksDev !== String(locksAnchor.identity.dev) ||
          witness.locksIno !== String(locksAnchor.identity.ino) ||
          witness.locksUid !==
            (locksAnchor.identity.uid === null
              ? null
              : String(locksAnchor.identity.uid))
        ) {
          throw new MutationJournalError(
            "MUTATION_JOURNAL_ROOT_CHANGED",
            "The witnessed mutation journal root was replaced; no request was started",
          );
        }
      }
      const journal = new MutationJournal(
        input,
        rootAnchor,
        entriesAnchor,
        locksAnchor,
        witness,
        witnessFile,
      );
      await journal.assertRootIdentity();
      const initializing =
        witness.schemaVersion === 3 && witness.state === "initializing";
      await journal.validateBinding(initializing);
      if (initializing) {
        await input.onInitializationCheckpoint?.("binding_durable");
        await journal.markIdentityReady();
        await input.onInitializationCheckpoint?.("ready_durable");
      }
      await journal.assertRootIdentity();
      rootAnchor = null;
      entriesAnchor = null;
      locksAnchor = null;
      return journal;
      } finally {
        await release();
      }
    } finally {
      if (rootAnchor?.handle !== null && rootAnchor?.handle !== undefined) {
        closeSync(rootAnchor.handle);
      }
      if (
        entriesAnchor?.handle !== null &&
        entriesAnchor?.handle !== undefined
      ) {
        closeSync(entriesAnchor.handle);
      }
      if (locksAnchor?.handle !== null && locksAnchor?.handle !== undefined) {
        closeSync(locksAnchor.handle);
      }
    }
  }

  private async assertRootIdentity(): Promise<void> {
    if (this.requireMountPoint) await assertLinuxMountPoint(this.directory);
    const current = await directoryIdentity(this.directory);
    if (
      current.dev !== this.rootIdentity.dev ||
      current.ino !== this.rootIdentity.ino ||
      current.uid !== this.rootIdentity.uid ||
      current.canonicalPath !== this.rootIdentity.canonicalPath
    ) {
      throw new MutationJournalError(
        "MUTATION_JOURNAL_ROOT_CHANGED",
        "The mutation journal root was replaced or redirected; no request was started",
      );
    }
  }

  private async assertAnchoredRootIdentity(): Promise<void> {
    await this.assertRetainedDirectory(
      this.rootHandle,
      this.anchoredDirectory,
      this.rootIdentity,
      "root",
    );
  }

  private async assertRetainedDirectory(
    handle: number | null,
    anchoredPath: string,
    identity: DirectoryIdentity,
    label: string,
  ): Promise<void> {
    if (handle === null) {
      const current = await directoryIdentity(anchoredPath);
      if (
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        current.uid !== identity.uid ||
        current.canonicalPath !== identity.canonicalPath
      ) {
        throw new MutationJournalError(
          "MUTATION_JOURNAL_ROOT_CHANGED",
          `The mutation journal ${label} directory was replaced or redirected`,
        );
      }
      return;
    }
    let retained: Stats | null = null;
    try {
      retained = fstatSync(handle);
    } catch {
      retained = null;
    }
    if (
      !retained?.isDirectory() ||
      retained.dev !== identity.dev ||
      retained.ino !== identity.ino ||
      (typeof retained.uid === "number" ? retained.uid : null) !==
        identity.uid
    ) {
      throw new MutationJournalError(
        "MUTATION_JOURNAL_ROOT_CHANGED",
        `The retained mutation journal ${label} directory anchor was lost`,
      );
    }
    const anchored = await anchoredDirectoryStats(anchoredPath);
    if (
      anchored.dev !== identity.dev ||
      anchored.ino !== identity.ino ||
      (typeof anchored.uid === "number" ? anchored.uid : null) !==
        identity.uid
    ) {
      throw new MutationJournalError(
        "MUTATION_JOURNAL_ROOT_CHANGED",
        `The retained mutation journal ${label} directory anchor was redirected`,
      );
    }
  }

  private async assertJournalDirectoryIdentities(
    requireNamedDirectories: boolean,
  ): Promise<void> {
    await this.assertRetainedDirectory(
      this.entriesHandle,
      this.entriesDirectory,
      this.entriesIdentity,
      "entries",
    );
    await this.assertRetainedDirectory(
      this.locksHandle,
      this.locksDirectory,
      this.locksIdentity,
      "locks",
    );
    if (!requireNamedDirectories) return;
    for (const [name, expected] of [
      ["entries", this.entriesIdentity],
      ["locks", this.locksIdentity],
    ] as const) {
      const current = await directoryIdentity(
        path.join(this.anchoredDirectory, name),
      );
      if (
        current.dev !== expected.dev ||
        current.ino !== expected.ino ||
        current.uid !== expected.uid
      ) {
        throw new MutationJournalError(
          "MUTATION_JOURNAL_ROOT_CHANGED",
          `The mutation journal ${name} directory was replaced; no request was started`,
        );
      }
    }
  }

  private assertBindingValue(existing: MutationJournalBinding): void {
    if (
      existing.journalId !== this.binding.journalId ||
      existing.apiBaseSha256 !== this.binding.apiBaseSha256 ||
      existing.appId.toLowerCase() !== this.binding.appId
    ) {
      throw new MutationJournalError(
        "MUTATION_JOURNAL_BINDING_MISMATCH",
        "The configured mutation journal belongs to a different OpenCloud API or app",
      );
    }
  }

  private async assertIdentityWitness(): Promise<void> {
    const raw = await readOptional(this.witnessFile);
    if (raw === null) {
      throw new MutationJournalError(
        "MUTATION_JOURNAL_ROOT_CHANGED",
        "The mutation journal identity witness disappeared; no request was started",
      );
    }
    const current = parseIdentityWitness(raw, this.witnessFile);
    if (
      current.schemaVersion !== this.witness.schemaVersion ||
      current.state !== this.witness.state ||
      current.journalId !== this.witness.journalId ||
      current.apiBaseSha256 !== this.witness.apiBaseSha256 ||
      current.appId.toLowerCase() !== this.witness.appId ||
      current.rootDev !== this.witness.rootDev ||
      current.rootIno !== this.witness.rootIno ||
      current.rootUid !== this.witness.rootUid ||
      current.entriesDev !== this.witness.entriesDev ||
      current.entriesIno !== this.witness.entriesIno ||
      current.entriesUid !== this.witness.entriesUid ||
      current.locksDev !== this.witness.locksDev ||
      current.locksIno !== this.witness.locksIno ||
      current.locksUid !== this.witness.locksUid
    ) {
      throw new MutationJournalError(
        "MUTATION_JOURNAL_ROOT_CHANGED",
        "The mutation journal identity witness changed; no request was started",
      );
    }
  }

  private async markIdentityReady(): Promise<void> {
    if (
      this.witness.schemaVersion !== 3 ||
      this.witness.state !== "initializing"
    ) {
      return;
    }
    await this.assertAnchoredRootIdentity();
    await this.assertJournalDirectoryIdentities(true);
    await this.assertIdentityWitness();
    await this.assertRootIdentity();
    const readyWitness: MutationJournalIdentityWitness = {
      ...this.witness,
      state: "ready",
    };
    await atomicWrite(this.witnessFile, readyWitness);
    this.witness = readyWitness;
    await this.assertIdentityWitness();
    await this.assertAnchoredRootIdentity();
    await this.assertJournalDirectoryIdentities(true);
    await this.assertRootIdentity();
  }

  private async validateBinding(
    allowCreate = false,
    requireExternalIdentity = true,
  ): Promise<void> {
    await this.assertAnchoredRootIdentity();
    await this.assertJournalDirectoryIdentities(requireExternalIdentity);
    await this.assertIdentityWitness();
    if (requireExternalIdentity) await this.assertRootIdentity();
    const bindingLock = path.join(this.anchoredDirectory, ".binding-lock");
    await ensureLockTarget(bindingLock);
    const release = await lockfile.lock(bindingLock, {
      realpath: false,
      stale: LOCK_STALE_MS,
      update: LOCK_UPDATE_MS,
      retries: { retries: 100, factor: 1.2, minTimeout: 20, maxTimeout: 500 },
    });
    try {
      await this.assertAnchoredRootIdentity();
      await this.assertJournalDirectoryIdentities(requireExternalIdentity);
      await this.assertIdentityWitness();
      if (requireExternalIdentity) await this.assertRootIdentity();
      await cleanupOrphanBindingTemps(this.anchoredDirectory);
      const bindingFile = path.join(this.anchoredDirectory, "binding.json");
      const raw = await readOptional(bindingFile);
      if (raw === null) {
        if (!allowCreate) {
          throw new MutationJournalError(
            "MUTATION_JOURNAL_BINDING_MISMATCH",
            "The mutation journal binding disappeared; no request was started",
          );
        }
        await atomicWrite(bindingFile, this.binding);
      } else {
        this.assertBindingValue(parseBinding(raw, bindingFile));
      }
      await this.assertAnchoredRootIdentity();
      await this.assertJournalDirectoryIdentities(requireExternalIdentity);
      await this.assertIdentityWitness();
      if (requireExternalIdentity) await this.assertRootIdentity();
    } finally {
      await release();
    }
  }

  async assertPersistentIdentity(): Promise<void> {
    await this.validateBinding(false, true);
  }

  async assertAnchoredPersistence(): Promise<void> {
    await this.validateBinding(false, false);
  }

  timestamp(): string {
    return this.now().toISOString();
  }

  async run<T>(
    spec: MutationIntentSpec,
    callback: (run: MutationRun) => Promise<T>,
  ): Promise<T> {
    const invocationStartedAt = this.timestamp();
    await this.assertPersistentIdentity();
    await this.assertPersistentIdentity();
    const disposition = mutationDisposition(spec.commandId);
    if (disposition.boundary !== "exact_app") {
      throw new MutationJournalError(
        "INVALID_MUTATION_JOURNAL_SCOPE",
        `Command ${spec.commandId} is not an exact-app journal mutation`,
      );
    }
    const scopeDigest = mutationDigest(spec.safeScope);
    const requestDigest = mutationDigest(spec.safeRequest);
    const explicitKey =
      spec.explicitIdempotencyKey !== undefined
        ? validateIdempotencyKey(spec.explicitIdempotencyKey)
        : null;
    if (this.authority && explicitKey === null) {
      throw new MutationJournalError(
        "APP_OWNER_IDEMPOTENCY_KEY_REQUIRED",
        "App-owner Agent mutations require an explicit --idempotency-key; no request was started",
        true,
      );
    }
    const slot = createHash("sha256")
      .update(
        explicitKey === null
          ? `generated\0${spec.commandId}\0${scopeDigest}`
          : `explicit\0${explicitKey}`,
      )
      .digest("hex");
    const lockTarget = path.join(this.locksDirectory, slot);
    const entryFile = path.join(this.entriesDirectory, `${slot}.json`);
    await ensureLockTarget(lockTarget);
    let compromised: Error | null = null;
    const release = await lockfile.lock(lockTarget, {
      realpath: false,
      stale: LOCK_STALE_MS,
      update: LOCK_UPDATE_MS,
      retries: {
        retries: 2_000,
        factor: 1.15,
        minTimeout: 20,
        maxTimeout: 1_000,
        randomize: true,
      },
      onCompromised: (error) => {
        compromised = error;
      },
    });
    const assertLock = () => {
      if (compromised) {
        throw new MutationJournalError(
          "MUTATION_JOURNAL_LOCK_LOST",
          "The mutation journal lock was lost; no further request will be started",
          true,
        );
      }
    };
    const assertPersistent = async () => {
      assertLock();
      await this.assertPersistentIdentity();
      assertLock();
    };
    const assertAnchored = async () => {
      assertLock();
      await this.assertAnchoredPersistence();
      assertLock();
    };
    try {
      await assertPersistent();
      const raw = await readOptional(entryFile);
      let entry = raw === null ? null : parseEntry(raw, entryFile);
      const concurrentCompletion =
        entry?.state === "completed" &&
        entry.completedAt !== null &&
        Date.parse(invocationStartedAt) <= Date.parse(entry.completedAt);
      if (
        entry?.state === "completed" &&
        !concurrentCompletion &&
        explicitKey === null
      ) {
        entry = null;
      }
      if (entry) {
        const mayInspectRetainedDevWorkflow =
          explicitKey === null &&
          spec.retireDevStoppedWorkflow === true &&
          entry.commandId === "opencloud app dev promote" &&
          entry.checkpoint?.sessionId !== undefined;
        if (
          entry.authorityRootRunId !== (this.authority?.rootRunId ?? null) ||
          entry.authorityFamilyId !== (this.authority?.familyId ?? null)
        ) {
          throw new MutationJournalError(
            "MUTATION_JOURNAL_AUTHORITY_MISMATCH",
            "This retained mutation belongs to a different runtime authority root or credential family; no request was started",
          );
        }
        const retainedIdentityChanged =
          entry.commandId !== spec.commandId ||
          entry.disposition !== disposition.recovery ||
          (explicitKey !== null && entry.idempotencyKey !== explicitKey);
        const retainedDescriptorChanged =
          entry.scopeDigest !== scopeDigest ||
          entry.requestDigest !== requestDigest;
        if (
          retainedIdentityChanged ||
          (!mayInspectRetainedDevWorkflow && retainedDescriptorChanged)
        ) {
          throw new MutationJournalError(
            "MUTATION_IN_PROGRESS",
            "A different unresolved mutation already owns this exact target. Recover it before starting another request.",
            true,
          );
        }
      } else {
        const now = this.timestamp();
        const entryId = randomUUID();
        entry = {
          schemaVersion: 1,
          entryId,
          commandId: spec.commandId,
          disposition: disposition.recovery,
          scopeDigest,
          requestDigest,
          idempotencyKey: explicitKey ?? `ocj1:${entryId}`,
          authorityRootRunId: this.authority?.rootRunId ?? null,
          authorityFamilyId: this.authority?.familyId ?? null,
          state: "prepared",
          attemptCount: 0,
          attemptedAt: null,
          operationId: null,
          checkpoint: null,
          unknownCode: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        };
        await assertPersistent();
        await atomicWrite(entryFile, entry);
        await assertPersistent();
      }
      await assertPersistent();
      const result = await callback(
        new MutationRun(
          this,
          entry,
          entryFile,
          entry.attemptedAt !== null || concurrentCompletion,
          assertPersistent,
          assertAnchored,
        ),
      );
      await assertAnchored();
      return result;
    } finally {
      await release().catch((error: unknown) => {
        if (!compromised) throw error;
      });
    }
  }
}
