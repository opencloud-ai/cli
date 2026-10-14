import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSourceTree, SOURCE_FILE_MAX_BYTES, sourceTreeDigest } from "./source-tree.js";

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
