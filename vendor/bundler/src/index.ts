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
  type OpenCloudManifest,
} from "@opencloud/contracts";
import { OPEN_CLOUD_JS_VERSION } from "@opencloud/js";
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
    javascriptSdk?: {
      version?: string;
    };
  };
  storage?: unknown;
  migrations?: Array<{
    id?: string;
    file?: string;
    sha256?: string;
  }>;
  functions?: unknown[];
  cron?: unknown[];
  health?: unknown;
  requiredSecrets?: unknown[];
}

export interface BuiltBundle {
  manifest: OpenCloudManifest;
  archive: Buffer;
  sha256: string;
  files: string[];
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
  const source = await readFile(manifestFile, "utf8");
  const raw = (manifestFile.endsWith(".json")
    ? JSON.parse(source)
    : YAML.parse(source)) as AuthorManifest;
  if (options.version) raw.version = options.version;
  raw.schemaVersion ??= 1;
  raw.runtime ??= {};
  raw.runtime.javascriptSdk ??= {};
  raw.runtime.javascriptSdk.version ??= OPEN_CLOUD_JS_VERSION;
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
    migration.sha256 = await sha256File(migrationFile);
  }
  const manifest = parseManifest(raw);
  const selection = await selectBundleFiles(root, manifest, manifestFile);

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
    const archiveEntries = [
      ...selection.directories,
      ...files,
    ].sort(comparePaths);
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
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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
    const absoluteDirectory = resolveBundlePath(
      root,
      relativeDirectory,
      label,
    );
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
  ) return;
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
  if (
    path.posix.dirname(relative) === "." &&
    isManifestName(relative)
  ) {
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
