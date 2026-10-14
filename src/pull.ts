import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { ReleaseBase } from "./release-base.js";
import { compareBytes, sha256Hex } from "./source-tree.js";

export interface ReleaseFile {
  path: string;
  content: Buffer;
  sha256: string;
}

/** Where a release's files came from: its draft source, or only its artifact. */
export type ReleaseKind = "source" | "artifact";

const RELEASE_FILE_MAX_BYTES = 100 * 1024 * 1024;

/** Reads a release archive, accepting only regular files at safe relative paths. */
export async function readReleaseArchive(archivePath: string): Promise<ReleaseFile[]> {
  const files: ReleaseFile[] = [];
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opencloud-pull-"));
  try {
    const paths: string[] = [];
    // An error thrown inside tar's filter escapes the extraction promise, so
    // record the first problem, skip the entry, and fail afterwards.
    let problem: string | null = null;
    await tar.x({
      file: archivePath,
      cwd: temporary,
      strict: true,
      filter: (entryPath, entry) => {
        const type = "type" in entry ? entry.type : "";
        if (type === "Directory") return true;
        if (type !== "File" && type !== "OldFile") {
          problem ??= `Release archive contains an unsupported entry: ${entryPath}`;
          return false;
        }
        let normalized: string;
        try {
          normalized = safeReleasePath(entryPath);
        } catch (error) {
          problem ??= error instanceof Error ? error.message : String(error);
          return false;
        }
        const size = "size" in entry && typeof entry.size === "number" ? entry.size : 0;
        if (size > RELEASE_FILE_MAX_BYTES) {
          problem ??= `Release archive file is too large: ${normalized}`;
          return false;
        }
        paths.push(normalized);
        return true;
      },
    });
    if (problem) throw new Error(problem);
    for (const file of paths) {
      const content = await readFile(path.join(temporary, ...file.split("/")));
      files.push({ path: file, content, sha256: sha256Hex(content) });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return files.sort((left, right) => compareBytes(left.path, right.path));
}

function safeReleasePath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/^\.\//, ""));
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.isAbsolute(normalized) ||
    normalized.includes("\\") ||
    normalized.split("/")[0] === ".opencloud"
  ) {
    throw new Error(`Release archive contains an unsafe path: ${value}`);
  }
  return normalized;
}

export interface PullPlan {
  write: ReleaseFile[];
  remove: string[];
  unchanged: number;
}

export class PullConflictError extends Error {
  readonly code = "LOCAL_CHANGES";
  constructor(readonly paths: string[]) {
    super(
      `This directory has changes the release would overwrite: ${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ` and ${paths.length - 10} more` : ""}. Deploy or set them aside first, or pass --force to overwrite them.`,
    );
  }
}

/**
 * How a release replaces a directory. Files the base tracked but changed
 * locally, and untracked files the release would overwrite, are conflicts
 * unless forced. Files the release dropped are removed only when pulling real
 * source over an untouched (or forced) base copy; an artifact-only release
 * never removes anything, because it lacks the source files.
 */
export function planPull(input: {
  release: ReleaseFile[];
  kind: ReleaseKind;
  base: Pick<ReleaseBase, "files"> | null;
  /** sha256 of each relevant path currently on disk; absent when missing. */
  disk: ReadonlyMap<string, string>;
  force: boolean;
}): PullPlan {
  const conflicts = new Set<string>();
  const tracked = input.base?.files ?? {};
  for (const [file, digest] of Object.entries(tracked)) {
    const current = input.disk.get(file);
    if (current !== digest) conflicts.add(file);
  }
  const release = new Map(input.release.map((file) => [file.path, file]));
  for (const [file, value] of release) {
    if (file in tracked) continue;
    const current = input.disk.get(file);
    if (current !== undefined && current !== value.sha256) conflicts.add(file);
  }
  // A changed file the release leaves exactly as the base had it is not overwritten.
  for (const file of [...conflicts]) {
    if (file in tracked && release.get(file)?.sha256 === tracked[file]) {
      conflicts.delete(file);
    }
  }
  if (conflicts.size && !input.force) {
    throw new PullConflictError([...conflicts].sort(compareBytes));
  }
  const write: ReleaseFile[] = [];
  let unchanged = 0;
  for (const value of release.values()) {
    const current = input.disk.get(value.path);
    if (current === value.sha256) {
      unchanged += 1;
      continue;
    }
    if (
      !input.force &&
      value.path in tracked &&
      current !== tracked[value.path] &&
      value.sha256 === tracked[value.path]
    ) {
      continue;
    }
    write.push(value);
  }
  const remove =
    input.kind === "source"
      ? Object.keys(tracked)
          .filter((file) => !release.has(file) && input.disk.has(file))
          .filter((file) => input.force || input.disk.get(file) === tracked[file])
          .sort(compareBytes)
      : [];
  return { write, remove, unchanged };
}
