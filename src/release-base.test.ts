import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedSinceBase,
  readReleaseBase,
  releaseBasePath,
  writeReleaseBase,
  type ReleaseBase,
} from "./release-base.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const base: ReleaseBase = {
  schemaVersion: 1,
  apiUrl: "https://api.example.test",
  appId: "60f07c58-ffa8-4442-acfa-1ec738466c45",
  deploymentId: "40c70b32-b672-43b3-b33e-b66d611bc357",
  version: "planner-20261014-2",
  artifactSha256: "a".repeat(64),
  sourceSha256: "b".repeat(64),
  files: { "opencloud.yaml": "c".repeat(64), "src/main.ts": "d".repeat(64) },
  recordedAt: "2026-10-14T12:00:00.000Z",
};

describe("release base", () => {
  it("round-trips privately inside an ignored .opencloud directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "release-base-"));
    roots.push(root);
    await writeReleaseBase(root, base);
    expect(await readReleaseBase(root)).toEqual(base);
    expect((await stat(releaseBasePath(root))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(root, ".opencloud", ".gitignore"), "utf8")).toBe("*\n!.gitignore\n");
  });

  it("treats a missing or damaged base as absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "release-base-"));
    roots.push(root);
    expect(await readReleaseBase(root)).toBeNull();
    await writeReleaseBase(root, base);
    await writeFile(releaseBasePath(root), JSON.stringify({ ...base, artifactSha256: "nope" }));
    expect(await readReleaseBase(root)).toBeNull();
    await writeFile(releaseBasePath(root), "{not json");
    expect(await readReleaseBase(root)).toBeNull();
  });

  it("lists changed, added, and removed files", () => {
    expect(changedSinceBase(base, [
      { path: "opencloud.yaml", sha256: "c".repeat(64) },
      { path: "src/new.ts", sha256: "e".repeat(64) },
    ])).toEqual(["src/main.ts", "src/new.ts"]);
  });
});
