import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseManifest,
  validateMigrationIdConvention,
  type OpenCloudManifest,
} from "@opencloud/contracts";
import { OPEN_CLOUD_SDK_VERSION } from "@opencloud/js";
import * as tar from "tar";
import YAML from "yaml";

interface AuthorManifest {
  schemaVersion?: number;
  appId?: string;
  version?: string;
  frontend?: {
    directory?: string;
    spa?: boolean;
  };
  runtime?: {
    sdk?: {
      version?: string;
    };
  };
  files?: unknown;
  migrations?: Array<{
    id?: string;
    file?: string;
    sha256?: string;
  }>;
  functions?: unknown[];
  cron?: unknown[];
  health?: unknown;
  secrets?: Record<string, unknown>;
}

export interface BuiltBundle {
  manifest: OpenCloudManifest;
  archive: Buffer;
  sha256: string;
  files: string[];
  sourceManifest: string;
  sourceFiles: string[];
  e2eTest?: BuiltE2eTest;
  warnings: BundleWarning[];
}

export interface BuiltE2eTest {
  path: typeof OPEN_CLOUD_E2E_TEST_PATH;
  source: string;
  sha256: string;
}

export interface BundleWarning {
  code:
    | "UNDECLARED_MIGRATION_FILE"
    | "UNDECLARED_FUNCTION_ENTRYPOINT"
    | "FRONTEND_SDK_NOT_REFERENCED";
  path: string;
  message: string;
}

export interface BundleOptions {
  version?: string;
}

interface BundleSelection {
  files: Map<string, string>;
  directories: Set<string>;
}

const manifestNames = [
  "opencloud.yaml",
  "opencloud.yml",
  "opencloud.json",
] as const;

export const OPEN_CLOUD_E2E_TEST_PATH = "tests/opencloud.e2e.js" as const;
export const OPEN_CLOUD_E2E_TEST_MAX_BYTES = 64 * 1024;

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isManifestName(value: string): boolean {
  return (manifestNames as readonly string[]).includes(value);
}

export async function buildBundle(
  directory: string,
  options: BundleOptions = {},
): Promise<BuiltBundle> {
  const root = path.resolve(directory);
  await assertDirectory(root, "App bundle root");
  const manifestFile = await findManifest(root);
  const sourceManifest = bundleRelativePath(root, manifestFile);
  const source = await readFile(manifestFile, "utf8");
  const raw = (
    manifestFile.endsWith(".json") ? JSON.parse(source) : YAML.parse(source)
  ) as AuthorManifest;
  if (options.version) raw.version = options.version;
  raw.schemaVersion ??= 2;
  raw.runtime ??= {};
  raw.runtime.sdk ??= {};
  raw.runtime.sdk.version ??= OPEN_CLOUD_SDK_VERSION;
  raw.migrations ??= [];
  for (const migration of raw.migrations) {
    if (!migration.file) throw new Error("Every migration needs a file");
    const migrationFile = resolveBundlePath(
      root,
      migration.file,
      "Migration file",
    );
    assertNotAuthorManifestInput(
      root,
      migrationFile,
      `Migration file ${migration.file}`,
    );
    await assertNoSymlinkComponents(
      root,
      migrationFile,
      `Migration file ${migration.file}`,
    );
    await assertFile(migrationFile, `Migration file ${migration.file}`);
    try {
      validateMigrationIdConvention(await readFile(migrationFile, "utf8"));
    } catch (error) {
      throw new Error(
        `Migration file ${migration.file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    migration.sha256 = await sha256File(migrationFile);
  }
  const manifest = parseManifest(raw);
  const selection = await selectBundleFiles(root, manifest, manifestFile);
  const e2eTest = await selectE2eTest(root, selection, manifestFile);
  if (e2eTest) {
    assertE2eTestOutsideFrontend(manifest.frontend.directory);
  }
  const warnings = [
    ...(await findUndeclaredConventionalFiles(root, manifest)),
    ...(await findFrontendSdkWarnings(manifest, selection)),
  ].sort((left, right) => comparePaths(left.path, right.path));
  const sourceFiles = [sourceManifest, ...selection.files.keys()].sort(
    comparePaths,
  );

  const temporary = await mkdtemp(path.join(os.tmpdir(), "opencloud-bundle-"));
  const staging = path.join(temporary, "root");
  const archiveFile = path.join(temporary, "bundle.tgz");
  try {
    await mkdir(staging);
    for (const directoryName of [...selection.directories].sort(comparePaths)) {
      const destination = path.join(staging, ...directoryName.split("/"));
      await mkdir(destination, { recursive: true });
      await chmod(destination, 0o755);
    }
    for (const [fileName, sourceFile] of [...selection.files].sort(([a], [b]) =>
      comparePaths(a, b),
    )) {
      const destination = path.join(staging, ...fileName.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(sourceFile, destination);
      await chmod(destination, 0o644);
    }
    await writeFile(
      path.join(staging, "opencloud.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o644 },
    );

    const files = ["opencloud.json", ...selection.files.keys()].sort(
      comparePaths,
    );
    const archiveEntries = [...selection.directories, ...files].sort(
      comparePaths,
    );
    await tar.create(
      {
        cwd: staging,
        file: archiveFile,
        gzip: true,
        portable: true,
        noMtime: true,
        noDirRecurse: true,
        strict: true,
      },
      archiveEntries,
    );
    const archive = await readFile(archiveFile);
    return {
      manifest,
      archive,
      sha256: createHash("sha256").update(archive).digest("hex"),
      files,
      sourceManifest,
      sourceFiles,
      ...(e2eTest ? { e2eTest } : {}),
      warnings,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function assertE2eTestOutsideFrontend(
  frontendDirectory: string,
): void {
  const relative = path.posix.relative(
    frontendDirectory,
    OPEN_CLOUD_E2E_TEST_PATH,
  );
  const overlaps =
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith("../") &&
      !path.posix.isAbsolute(relative));
  if (overlaps) {
    throw new Error(
      `${OPEN_CLOUD_E2E_TEST_PATH} must stay outside frontend.directory so verification source is never served publicly`,
    );
  }
}

async function selectE2eTest(
  root: string,
  selection: BundleSelection,
  manifestFile: string,
): Promise<BuiltE2eTest | undefined> {
  const absoluteFile = resolveBundlePath(
    root,
    OPEN_CLOUD_E2E_TEST_PATH,
    "OpenCloud E2E test",
  );
  let info;
  try {
    info = await lstat(absoluteFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  await assertNoSymlinkComponents(root, absoluteFile, "OpenCloud E2E test");
  if (info.isSymbolicLink()) {
    throw new Error("OpenCloud E2E test cannot be a symlink");
  }
  if (!info.isFile()) {
    throw new Error("OpenCloud E2E test is not a regular file");
  }
  if (info.size > OPEN_CLOUD_E2E_TEST_MAX_BYTES) {
    throw new Error(
      `OpenCloud E2E test exceeds ${OPEN_CLOUD_E2E_TEST_MAX_BYTES} bytes: ${OPEN_CLOUD_E2E_TEST_PATH}`,
    );
  }

  const bytes = await readFile(absoluteFile);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  validateE2eTestSource(source);
  addSelectedFile(root, absoluteFile, selection, manifestFile);
  return {
    path: OPEN_CLOUD_E2E_TEST_PATH,
    source,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function validateE2eTestSource(source: string): void {
  const code = maskJavaScriptCommentsAndLiterals(source);
  const imports = [
    ...source.matchAll(
      /\bimport\s*\{([\s\S]*?)\}\s*from\s*(["'])([^"']+)\2\s*;?/g,
    ),
  ].filter((match) => {
    const index = match.index ?? -1;
    return index >= 0 && code.slice(index, index + 6) === "import";
  });
  const importTokenCount = code.match(/\bimport\b/g)?.length ?? 0;
  if (
    imports.length !== 1 ||
    importTokenCount !== 1 ||
    imports[0]?.[3] !== "@opencloud/test"
  ) {
    throw new Error(
      `OpenCloud E2E test must have exactly one named import from "@opencloud/test": ${OPEN_CLOUD_E2E_TEST_PATH}`,
    );
  }
  const importedNames = (imports[0]?.[1] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    importedNames.length !== 2 ||
    !importedNames.includes("test") ||
    !importedNames.includes("expect")
  ) {
    throw new Error(
      `OpenCloud E2E test must import exactly test and expect from "@opencloud/test": ${OPEN_CLOUD_E2E_TEST_PATH}`,
    );
  }
  if (!/\btest\s*\(/.test(code)) {
    throw new Error(
      `OpenCloud E2E test must declare at least one test(...): ${OPEN_CLOUD_E2E_TEST_PATH}`,
    );
  }
  if (
    /\b(?:test|describe)(?:\s*[.]\s*[A-Za-z_$][\w$]*)*\s*[.]\s*(?:skip|only)\s*\(/.test(
      code,
    )
  ) {
    throw new Error(
      `OpenCloud E2E test cannot use skip or only: ${OPEN_CLOUD_E2E_TEST_PATH}`,
    );
  }
  if (/\bimport\s*\(/.test(code)) {
    throw new Error(
      `OpenCloud E2E test cannot use dynamic imports: ${OPEN_CLOUD_E2E_TEST_PATH}`,
    );
  }

  const forbiddenPatterns: Array<[RegExp, string]> = [
    [/\bfetch\s*\(/, "fetch"],
    [/\b(?:XMLHttpRequest|WebSocket|EventSource)\b/, "direct network APIs"],
    [/\bnavigator\s*[.]\s*sendBeacon\s*\(/, "sendBeacon"],
    [
      /[.]\s*(?:evaluate|evaluateAll|evaluateHandle|\$eval|\$\$eval)\s*\(/,
      "browser evaluation",
    ],
    [/[.]\s*(?:route|unroute|routeFromHAR)\s*\(/, "network routing"],
    [
      /[.]\s*(?:goto|setContent|addInitScript|addScriptTag|exposeBinding|exposeFunction)\s*\(/,
      "direct page or script injection",
    ],
    [
      /\brequest\s*[.]\s*(?:delete|fetch|get|head|patch|post|put)\s*\(/,
      "direct request access",
    ],
  ];
  for (const [pattern, label] of forbiddenPatterns) {
    if (pattern.test(code)) {
      throw new Error(
        `OpenCloud E2E test cannot use ${label}; drive the app through the bounded @opencloud/test UI fixtures: ${OPEN_CLOUD_E2E_TEST_PATH}`,
      );
    }
  }
  if (/\/(?:rest|storage|functions)\/v1(?:\/|\b)/.test(source)) {
    throw new Error(
      `OpenCloud E2E test cannot access platform backend routes directly; drive the app through the bounded @opencloud/test UI fixtures: ${OPEN_CLOUD_E2E_TEST_PATH}`,
    );
  }
}

function maskJavaScriptCommentsAndLiterals(source: string): string {
  let output = "";
  let index = 0;
  let state:
    | "code"
    | "line-comment"
    | "block-comment"
    | "single-quote"
    | "double-quote"
    | "template" = "code";
  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === "code") {
      if (character === "/" && next === "/") {
        output += "  ";
        index += 2;
        state = "line-comment";
        continue;
      }
      if (character === "/" && next === "*") {
        output += "  ";
        index += 2;
        state = "block-comment";
        continue;
      }
      if (character === "'") state = "single-quote";
      else if (character === '"') state = "double-quote";
      else if (character === "`") state = "template";
      output += state === "code" ? character : " ";
      index += 1;
      continue;
    }
    if (state === "line-comment") {
      if (character === "\n") {
        output += "\n";
        state = "code";
      } else output += " ";
      index += 1;
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 2;
        state = "code";
      } else {
        output += character === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    const terminator =
      state === "single-quote" ? "'" : state === "double-quote" ? '"' : "`";
    if (character === "\\") {
      output += " ";
      if (index + 1 < source.length) output += next === "\n" ? "\n" : " ";
      index += 2;
      continue;
    }
    output += character === "\n" ? "\n" : " ";
    index += 1;
    if (character === terminator) state = "code";
  }
  return output;
}

async function findFrontendSdkWarnings(
  manifest: OpenCloudManifest,
  selection: BundleSelection,
): Promise<BundleWarning[]> {
  const frontendPrefix = manifest.frontend.directory + "/";
  const candidates = [...selection.files.entries()].filter(
    ([relative]) =>
      relative.startsWith(frontendPrefix) &&
      /[.](?:html|js|mjs|cjs|ts|tsx|jsx)$/.test(relative),
  );
  for (const [, sourceFile] of candidates) {
    const content = await readFile(sourceFile, "utf8");
    if (
      content.includes("/_opencloud/sdk.js") &&
      /\bopencloud\b/.test(content)
    ) {
      return [];
    }
  }
  return [
    {
      code: "FRONTEND_SDK_NOT_REFERENCED",
      path: manifest.frontend.directory,
      message:
        'Frontend source does not import the deployment-pinned OpenCloud SDK. Import { opencloud } from "/_opencloud/sdk.js".',
    },
  ];
}
async function findUndeclaredConventionalFiles(
  root: string,
  manifest: OpenCloudManifest,
): Promise<BundleWarning[]> {
  const declaredMigrations = new Set(
    manifest.migrations.map((item) => item.file),
  );
  const declaredFunctions = new Set(
    manifest.functions.map((item) => item.entrypoint),
  );
  const warnings: BundleWarning[] = [];
  for (const relative of await conventionalFiles(root, "migrations")) {
    if (relative.endsWith(".sql") && !declaredMigrations.has(relative)) {
      warnings.push({
        code: "UNDECLARED_MIGRATION_FILE",
        path: relative,
        message: `${relative} exists but is not declared in opencloud.yaml migrations.`,
      });
    }
  }
  for (const relative of await conventionalFiles(root, "functions")) {
    if (
      /^functions\/[^/]+\/index\.(?:ts|js|mjs)$/.test(relative) &&
      !declaredFunctions.has(relative)
    ) {
      warnings.push({
        code: "UNDECLARED_FUNCTION_ENTRYPOINT",
        path: relative,
        message: `${relative} looks like a Function entrypoint but is not declared in opencloud.yaml functions.`,
      });
    }
  }
  return warnings.sort((left, right) => comparePaths(left.path, right.path));
}

async function conventionalFiles(
  root: string,
  directoryName: string,
): Promise<string[]> {
  const start = path.join(root, directoryName);
  try {
    const info = await lstat(start);
    if (!info.isDirectory() || info.isSymbolicLink()) return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await visit(target);
      else if (info.isFile()) output.push(bundleRelativePath(root, target));
    }
  };
  await visit(start);
  return output;
}

async function findManifest(root: string): Promise<string> {
  for (const name of manifestNames) {
    const candidate = path.join(root, name);
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) {
        throw new Error(`Author manifest cannot be a symlink: ${name}`);
      }
      if (info.isFile()) return candidate;
      throw new Error(`Author manifest is not a regular file: ${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("No opencloud.yaml, opencloud.yml, or opencloud.json found");
}

async function selectBundleFiles(
  root: string,
  manifest: OpenCloudManifest,
  manifestFile: string,
): Promise<BundleSelection> {
  const selection: BundleSelection = {
    files: new Map(),
    directories: new Set(),
  };
  const addDirectoryTree = async (
    relativeDirectory: string,
    label: string,
  ): Promise<void> => {
    const absoluteDirectory = resolveBundlePath(root, relativeDirectory, label);
    assertNotLocalMetadataPath(root, absoluteDirectory, label);
    await assertNoSymlinkComponents(root, absoluteDirectory, label);
    await assertDirectory(absoluteDirectory, label);
    await walkDirectory(root, absoluteDirectory, selection, manifestFile);
  };

  await addDirectoryTree(
    manifest.frontend.directory,
    `Frontend directory ${manifest.frontend.directory}`,
  );

  for (const migration of manifest.migrations) {
    const absoluteFile = resolveBundlePath(
      root,
      migration.file,
      `Migration file ${migration.file}`,
    );
    assertNotLocalMetadataPath(
      root,
      absoluteFile,
      `Migration file ${migration.file}`,
    );
    assertNotAuthorManifestInput(
      root,
      absoluteFile,
      `Migration file ${migration.file}`,
    );
    await assertNoSymlinkComponents(
      root,
      absoluteFile,
      `Migration file ${migration.file}`,
    );
    await assertFile(absoluteFile, `Migration file ${migration.file}`);
    addSelectedFile(root, absoluteFile, selection, manifestFile);
  }

  const functionDirectories = new Set(
    manifest.functions.map((definition) =>
      path.posix.dirname(definition.entrypoint),
    ),
  );
  for (const functionDirectory of [...functionDirectories].sort(comparePaths)) {
    await addDirectoryTree(
      functionDirectory,
      `Function source directory ${functionDirectory}`,
    );
  }
  for (const definition of manifest.functions) {
    const entrypoint = resolveBundlePath(
      root,
      definition.entrypoint,
      `Function entrypoint ${definition.entrypoint}`,
    );
    assertNotLocalMetadataPath(
      root,
      entrypoint,
      `Function entrypoint ${definition.entrypoint}`,
    );
    assertNotAuthorManifestInput(
      root,
      entrypoint,
      `Function entrypoint ${definition.entrypoint}`,
    );
    await assertNoSymlinkComponents(
      root,
      entrypoint,
      `Function entrypoint ${definition.entrypoint}`,
    );
    await assertFile(
      entrypoint,
      `Function entrypoint ${definition.entrypoint}`,
    );
  }

  return selection;
}

async function walkDirectory(
  root: string,
  directory: string,
  selection: BundleSelection,
  manifestFile: string,
): Promise<void> {
  const relativeDirectory = bundleRelativePath(root, directory);
  if (relativeDirectory) selection.directories.add(relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => comparePaths(a.name, b.name));
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const info = await lstat(target);
    const relative = bundleRelativePath(root, target);
    if (relative === ".opencloud" || relative.startsWith(".opencloud/")) {
      continue;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`App bundles cannot contain symlinks: ${relative}`);
    }
    if (info.isDirectory()) {
      await walkDirectory(root, target, selection, manifestFile);
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`App bundles only support regular files: ${relative}`);
    }
    addSelectedFile(root, target, selection, manifestFile);
  }
}

function assertNotLocalMetadataPath(
  root: string,
  target: string,
  label: string,
): void {
  const relative = bundleRelativePath(root, target);
  if (relative === ".opencloud" || relative.startsWith(".opencloud/")) {
    throw new Error(
      `${label} cannot use the reserved .opencloud metadata directory`,
    );
  }
}

function addSelectedFile(
  root: string,
  file: string,
  selection: BundleSelection,
  manifestFile: string,
): void {
  const relative = bundleRelativePath(root, file);
  if (
    file === manifestFile ||
    (path.posix.dirname(relative) === "." && isManifestName(relative))
  )
    return;
  selection.files.set(relative, file);
  addParentDirectories(relative, selection.directories);
}

function addParentDirectories(
  relativeFile: string,
  directories: Set<string>,
): void {
  let current = path.posix.dirname(relativeFile);
  while (current !== ".") {
    directories.add(current);
    current = path.posix.dirname(current);
  }
}

function resolveBundlePath(
  root: string,
  relative: string,
  label: string,
): string {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.posix.isAbsolute(relative) ||
    relative.includes("\\")
  ) {
    throw new Error(`${label} must be a relative path using forward slashes`);
  }
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "..")) {
    throw new Error(`${label} cannot escape the app bundle`);
  }
  const resolved = path.resolve(root, ...parts);
  const withinRoot = path.relative(root, resolved);
  if (
    withinRoot === ".." ||
    withinRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(withinRoot)
  ) {
    throw new Error(`${label} cannot escape the app bundle`);
  }
  return resolved;
}

function bundleRelativePath(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Selected path escapes the app bundle: ${target}`);
  }
  return relative.split(path.sep).join("/");
}

function assertNotAuthorManifestInput(
  root: string,
  target: string,
  label: string,
): void {
  const relative = bundleRelativePath(root, target);
  if (path.posix.dirname(relative) === "." && isManifestName(relative)) {
    throw new Error(`${label} conflicts with the canonical opencloud.json`);
  }
}

async function assertNoSymlinkComponents(
  root: string,
  target: string,
  label: string,
): Promise<void> {
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(
        `${label} cannot traverse a symlink: ${bundleRelativePath(root, current)}`,
      );
    }
  }
}

async function assertDirectory(target: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} does not exist`);
    }
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`${label} cannot be a symlink`);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory`);
}

async function assertFile(target: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} does not exist`);
    }
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`${label} cannot be a symlink`);
  if (!info.isFile()) throw new Error(`${label} is not a regular file`);
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
