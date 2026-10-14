import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The release a working copy is based on. Deploys send it so OpenCloud can
 * refuse to replace a newer release, and `pull` uses its file hashes to tell
 * an untouched copy from one with local edits.
 */
export interface ReleaseBase {
  schemaVersion: 1;
  apiUrl: string;
  appId: string;
  deploymentId: string;
  version: string;
  artifactSha256: string;
  sourceSha256: string | null;
  /** Path to sha256 of every file the release holds for this copy. */
  files: Record<string, string>;
  recordedAt: string;
}

export function releaseBasePath(sourceRoot: string): string {
  return path.join(sourceRoot, ".opencloud", "base.json");
}

export async function readReleaseBase(
  sourceRoot: string,
): Promise<ReleaseBase | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(releaseBasePath(sourceRoot), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const value = parsed as Partial<ReleaseBase>;
  const sha256 = /^[a-f0-9]{64}$/;
  if (
    value?.schemaVersion !== 1 ||
    typeof value.apiUrl !== "string" ||
    typeof value.appId !== "string" ||
    typeof value.deploymentId !== "string" ||
    typeof value.version !== "string" ||
    typeof value.artifactSha256 !== "string" ||
    !sha256.test(value.artifactSha256) ||
    (value.sourceSha256 !== null &&
      (typeof value.sourceSha256 !== "string" || !sha256.test(value.sourceSha256))) ||
    !value.files ||
    typeof value.files !== "object" ||
    Object.values(value.files).some((digest) => typeof digest !== "string" || !sha256.test(digest)) ||
    typeof value.recordedAt !== "string"
  ) {
    // An unreadable base is treated as absent: deploys then skip the
    // precondition rather than trust a damaged record.
    return null;
  }
  return value as ReleaseBase;
}

export async function writeReleaseBase(
  sourceRoot: string,
  base: ReleaseBase,
): Promise<void> {
  const directory = path.dirname(releaseBasePath(sourceRoot));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, ".gitignore"), "*\n!.gitignore\n", {
    mode: 0o600,
    flag: "wx",
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const temporary = path.join(directory, `.base-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(base, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, releaseBasePath(sourceRoot));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Paths whose content differs from the base, including added and removed files. */
export function changedSinceBase(
  base: Pick<ReleaseBase, "files">,
  current: ReadonlyArray<{ path: string; sha256: string }>,
): string[] {
  const changed = new Set<string>();
  const present = new Map(current.map((file) => [file.path, file.sha256]));
  for (const [file, digest] of present) {
    if (base.files[file] !== digest) changed.add(file);
  }
  for (const file of Object.keys(base.files)) {
    if (!present.has(file)) changed.add(file);
  }
  return [...changed].sort();
}
