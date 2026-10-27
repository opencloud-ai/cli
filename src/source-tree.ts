import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

/** OpenCloud draft limits; larger files are left out of the release source. */
export const SOURCE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const SOURCE_TREE_MAX_BYTES = 50 * 1024 * 1024;
const SOURCE_PATH_MAX_LENGTH = 512;

/** Never part of a release's source, whatever .gitignore says. */
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".opencloud"]);

export interface SourceTreeFile {
  path: string;
  content: Buffer;
  sha256: string;
}

export interface SkippedSourceFile {
  path: string;
  reason: "symlink" | "not_regular" | "too_large" | "unsupported_path";
}

export interface SourceTree {
  files: SourceTreeFile[];
  skipped: SkippedSourceFile[];
}

/**
 * Collects an app's working tree as release source: every regular file that
 * .gitignore files (root and nested) do not ignore, never `.git`,
 * `node_modules`, `.opencloud` or `.env*`. Paths use `/` and sort by byte
 * order so the same tree always yields the same list.
 */
export async function collectSourceTree(root: string): Promise<SourceTree> {
  const files: SourceTreeFile[] = [];
  const skipped: SkippedSourceFile[] = [];
  const visit = async (
    directory: string,
    relative: string,
    rules: Array<{ base: string; ignore: Ignore }>,
  ): Promise<void> => {
    const local = await readGitignore(directory);
    const active = local ? [...rules, { base: relative, ignore: local }] : rules;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareBytes(left.name, right.name));
    for (const entry of entries) {
      const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        if (isIgnored(active, entryPath, true)) continue;
        await visit(absolute, entryPath, active);
        continue;
      }
      if (entry.name.startsWith(".env")) continue;
      if (isIgnored(active, entryPath, false)) continue;
      if (metadata.isSymbolicLink()) {
        skipped.push({ path: entryPath, reason: "symlink" });
        continue;
      }
      if (!metadata.isFile()) {
        skipped.push({ path: entryPath, reason: "not_regular" });
        continue;
      }
      if (entryPath.length > SOURCE_PATH_MAX_LENGTH || entryPath.includes("\\")) {
        skipped.push({ path: entryPath, reason: "unsupported_path" });
        continue;
      }
      if (metadata.size > SOURCE_FILE_MAX_BYTES) {
        skipped.push({ path: entryPath, reason: "too_large" });
        continue;
      }
      const content = await readFile(absolute);
      files.push({ path: entryPath, content, sha256: sha256Hex(content) });
    }
  };
  await visit(path.resolve(root), "", []);
  files.sort((left, right) => compareBytes(left.path, right.path));
  return { files, skipped };
}

/** How many source-only files the note names, and JSON results list. */
export const SOURCE_ONLY_NOTE_LIMIT = 10;
export const SOURCE_ONLY_RESULT_LIMIT = 100;

/**
 * Uploaded source files the app's bundle does not contain, such as notes or
 * data files that travel only with the release source. Files at the top of
 * the folder come first, as stray files usually sit there, then byte order.
 */
export function sourceOnlyFiles(
  uploaded: Iterable<string>,
  bundled: Iterable<string>,
): string[] {
  const app = new Set(bundled);
  const depth = (file: string) => file.split("/").length;
  return [...uploaded]
    .filter((file) => !app.has(file))
    .sort((left, right) => depth(left) - depth(right) || compareBytes(left, right));
}

/**
 * Names the files the release source keeps beyond the app, since the app's
 * admins can download that source; null when there are none.
 */
export function sourceOnlyNote(
  files: readonly string[],
  platformBuilt: boolean,
): string | null {
  if (!files.length) return null;
  const more = files.length - SOURCE_ONLY_NOTE_LIMIT;
  return (
    "Also kept with the app's source, which its admins can download " +
    (platformBuilt
      ? "(not part of the app unless its frontend build uses them)"
      : "(not part of the app)") +
    `: ${files.slice(0, SOURCE_ONLY_NOTE_LIMIT).join(", ")}` +
    `${more > 0 ? ` and ${more} more` : ""}. Add files you want to keep private to .gitignore.`
  );
}

/** The same files for a JSON result: the first SOURCE_ONLY_RESULT_LIMIT and the count. */
export function sourceOnlyResult(files: readonly string[]): {
  sourceOnlyFiles: string[];
  sourceOnlyFileCount: number;
} {
  return {
    sourceOnlyFiles: files.slice(0, SOURCE_ONLY_RESULT_LIMIT),
    sourceOnlyFileCount: files.length,
  };
}

/** One digest for a whole file set, independent of collection order. */
export function sourceTreeDigest(
  files: ReadonlyArray<{ path: string; sha256: string }>,
): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => compareBytes(left.path, right.path))) {
    hash.update(file.path).update("\0").update(file.sha256).update("\n");
  }
  return hash.digest("hex");
}

export function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

async function readGitignore(directory: string): Promise<Ignore | null> {
  let text: string;
  try {
    text = await readFile(path.join(directory, ".gitignore"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return ignore().add(text);
}

/**
 * Git semantics: rules apply relative to the directory of their .gitignore,
 * and a deeper rule (including a negation) overrides a shallower one.
 */
function isIgnored(
  rules: ReadonlyArray<{ base: string; ignore: Ignore }>,
  entryPath: string,
  directory: boolean,
): boolean {
  let ignored = false;
  for (const rule of rules) {
    const relative = rule.base ? entryPath.slice(rule.base.length + 1) : entryPath;
    const result = rule.ignore.test(directory ? `${relative}/` : relative);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}
