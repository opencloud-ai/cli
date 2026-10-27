import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectSourceTree,
  SOURCE_FILE_MAX_BYTES,
  SOURCE_ONLY_RESULT_LIMIT,
  sourceOnlyFiles,
  sourceOnlyNote,
  sourceOnlyResult,
  sourceTreeDigest,
} from "./source-tree.js";

const roots: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-tree-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("release source tree", () => {
  it("keeps the working tree that .gitignore files and fixed exclusions allow", async () => {
    const root = await tree({
      ".gitignore": "frontend/dist/\n*.log\n",
      "opencloud.yaml": "appId: x\n",
      "frontend/src/main.tsx": "render()",
      "frontend/dist/index.html": "<built>",
      "debug.log": "noise",
      ".env": "SECRET=1",
      ".env.local": "SECRET=2",
      "node_modules/react/index.js": "dep",
      "nested/node_modules/x.js": "dep",
      ".git/HEAD": "ref",
      ".opencloud/app.json": "{}",
      "functions/api/.gitignore": "generated.ts\n!keep.log\n",
      "functions/api/index.ts": "export {}",
      "functions/api/generated.ts": "// generated",
      "functions/api/keep.log": "kept by a nested negation",
    });
    const { files, skipped } = await collectSourceTree(root);
    expect(files.map((file) => file.path)).toEqual([
      ".gitignore",
      "frontend/src/main.tsx",
      "functions/api/.gitignore",
      "functions/api/index.ts",
      "functions/api/keep.log",
      "opencloud.yaml",
    ]);
    expect(skipped).toEqual([]);
  });

  it("skips links and oversized files and reports them", async () => {
    const root = await tree({ "a.txt": "a" });
    await symlink(path.join(root, "a.txt"), path.join(root, "link.txt"));
    await writeFile(path.join(root, "huge.bin"), Buffer.alloc(SOURCE_FILE_MAX_BYTES + 1));
    const { files, skipped } = await collectSourceTree(root);
    expect(files.map((file) => file.path)).toEqual(["a.txt"]);
    expect(skipped).toEqual([
      { path: "huge.bin", reason: "too_large" },
      { path: "link.txt", reason: "symlink" },
    ]);
  });

  it("digests a file set independently of order", () => {
    const a = { path: "a", sha256: "1".repeat(64) };
    const b = { path: "b", sha256: "2".repeat(64) };
    expect(sourceTreeDigest([a, b])).toBe(sourceTreeDigest([b, a]));
    expect(sourceTreeDigest([a, b])).not.toBe(sourceTreeDigest([a]));
  });
});

describe("source files outside the app bundle", () => {
  const uploaded = [
    ".gitignore",
    "frontend/index.html",
    "frontend/src/main.tsx",
    "frontend/dist/index.html",
    "notes/clients.txt",
    "opencloud.yaml",
    "package.json",
    "sales-2026.csv",
  ];
  const bundled = ["opencloud.json", "frontend/dist/index.html", "opencloud.yaml"];

  it("lists uploaded files the bundle lacks, those at the top of the folder first", () => {
    expect(sourceOnlyFiles(uploaded, bundled)).toEqual([
      ".gitignore",
      "package.json",
      "sales-2026.csv",
      "frontend/index.html",
      "notes/clients.txt",
      "frontend/src/main.tsx",
    ]);
    expect(sourceOnlyFiles(["opencloud.yaml", "index.html"], ["opencloud.json", "index.html", "opencloud.yaml"])).toEqual([]);
  });

  it("names them in one bounded note that says how to keep files private", () => {
    expect(sourceOnlyNote(["sales-2026.csv"], false)).toBe(
      "Also kept with the app's source, which its admins can download (not part of the app): sales-2026.csv. Add files you want to keep private to .gitignore.",
    );
    const many = Array.from({ length: 13 }, (_, index) => `file-${String(index).padStart(2, "0")}.txt`);
    expect(sourceOnlyNote(many, false)).toBe(
      `Also kept with the app's source, which its admins can download (not part of the app): ${many.slice(0, 10).join(", ")} and 3 more. Add files you want to keep private to .gitignore.`,
    );
    // A frontend OpenCloud builds can read any uploaded file.
    expect(sourceOnlyNote(["package.json"], true)).toBe(
      "Also kept with the app's source, which its admins can download (not part of the app unless its frontend build uses them): package.json. Add files you want to keep private to .gitignore.",
    );
    expect(sourceOnlyNote([], false)).toBeNull();
  });

  it("bounds the JSON list and keeps the full count", () => {
    expect(sourceOnlyResult(["sales-2026.csv"])).toEqual({ sourceOnlyFiles: ["sales-2026.csv"], sourceOnlyFileCount: 1 });
    const many = Array.from({ length: SOURCE_ONLY_RESULT_LIMIT + 5 }, (_, index) => `f${index}`);
    expect(sourceOnlyResult(many)).toEqual({
      sourceOnlyFiles: many.slice(0, SOURCE_ONLY_RESULT_LIMIT),
      sourceOnlyFileCount: SOURCE_ONLY_RESULT_LIMIT + 5,
    });
  });
});
