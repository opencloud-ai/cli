import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { planPull, PullConflictError, readReleaseArchive, type ReleaseFile } from "./pull.js";
import { sha256Hex } from "./source-tree.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function file(filePath: string, content: string): ReleaseFile {
  const bytes = Buffer.from(content);
  return { path: filePath, content: bytes, sha256: sha256Hex(bytes) };
}
const digest = (content: string) => sha256Hex(Buffer.from(content));

async function archive(entries: Record<string, string>, link?: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-archive-"));
  roots.push(root);
  const source = path.join(root, "source");
  for (const [entry, content] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(source, entry)), { recursive: true });
    await writeFile(path.join(source, entry), content);
  }
  const names = Object.keys(entries);
  if (link) {
    await symlink("/etc/passwd", path.join(source, link));
    names.push(link);
  }
  const target = path.join(root, "release.tgz");
  await tar.create({ file: target, cwd: source, gzip: true, portable: true }, names);
  return target;
}

describe("release archives", () => {
  it("reads regular files in byte order", async () => {
    const files = await readReleaseArchive(await archive({ "src/b.ts": "b", "opencloud.yaml": "m" }));
    expect(files.map((value) => [value.path, value.content.toString()])).toEqual([
      ["opencloud.yaml", "m"],
      ["src/b.ts", "b"],
    ]);
  });

  it("refuses links", async () => {
    await expect(readReleaseArchive(await archive({ "a.txt": "a" }, "evil"))).rejects.toThrow(/unsupported entry/);
  });
});

describe("pull planning", () => {
  const release = [file("opencloud.yaml", "m2"), file("src/a.ts", "a2"), file("src/new.ts", "n")];

  it("writes everything into an empty directory", () => {
    const plan = planPull({ release, kind: "source", base: null, disk: new Map(), force: false });
    expect(plan.write.map((value) => value.path)).toEqual(["opencloud.yaml", "src/a.ts", "src/new.ts"]);
    expect(plan.remove).toEqual([]);
  });

  it("fast-forwards an untouched copy and removes files the release dropped", () => {
    const base = { files: { "opencloud.yaml": digest("m1"), "src/a.ts": digest("a1"), "src/old.ts": digest("o") } };
    const disk = new Map(Object.entries(base.files));
    const plan = planPull({ release, kind: "source", base, disk, force: false });
    expect(plan.write.map((value) => value.path)).toEqual(["opencloud.yaml", "src/a.ts", "src/new.ts"]);
    expect(plan.remove).toEqual(["src/old.ts"]);
  });

  it("refuses to overwrite a local edit unless forced", () => {
    const base = { files: { "opencloud.yaml": digest("m1"), "src/a.ts": digest("a1") } };
    const disk = new Map([["opencloud.yaml", digest("m1")], ["src/a.ts", digest("local edit")]]);
    expect(() => planPull({ release, kind: "source", base, disk, force: false })).toThrow(PullConflictError);
    const forced = planPull({ release, kind: "source", base, disk, force: true });
    expect(forced.write.map((value) => value.path)).toContain("src/a.ts");
  });

  it("keeps a local edit the release did not touch", () => {
    const base = { files: { "opencloud.yaml": digest("m2"), "src/a.ts": digest("a1") } };
    const disk = new Map([["opencloud.yaml", digest("my manifest edit")], ["src/a.ts", digest("a1")]]);
    const plan = planPull({ release, kind: "source", base, disk, force: false });
    expect(plan.write.map((value) => value.path)).toEqual(["src/a.ts", "src/new.ts"]);
  });

  it("refuses to overwrite an untracked file with different content", () => {
    const disk = new Map([["src/new.ts", digest("mine")]]);
    expect(() => planPull({ release, kind: "source", base: null, disk, force: false }))
      .toThrow(/src\/new.ts/);
  });

  it("never removes files when only the artifact is available", () => {
    const base = { files: { "src/a.ts": digest("a2"), "src/only-in-source.ts": digest("s") } };
    const disk = new Map(Object.entries(base.files));
    const plan = planPull({ release, kind: "artifact", base, disk, force: false });
    expect(plan.remove).toEqual([]);
  });
});
