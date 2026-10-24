import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveFileDigests,
  compareValidatedArtifact,
  describeArtifactMismatch,
} from "./artifact-identity.js";
import { buildBundle } from "./bundle.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const temporaryDirectories: string[] = [];
const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// A long nested path makes the archive use a ustar prefix or a pax header.
const LONG = `frontend/${"assets/".repeat(14)}logo.svg`;
const FILES: Record<string, string> = {
  "frontend/index.html": "<!doctype html><title>Counter</title>\n",
  [LONG]: "<svg xmlns='http://www.w3.org/2000/svg'/>\n",
  "migrations/0001_create_counters.sql":
    "create table public.counters (id uuid primary key default gen_random_uuid());\n",
};

async function bundle() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencloud-artifact-identity-"));
  temporaryDirectories.push(root);
  await writeFile(
    path.join(root, "opencloud.yaml"),
    [
      "schemaVersion: 3",
      `appId: ${APP_ID}`,
      "frontend:",
      "  directory: frontend",
      "runtime:",
      "  sdk:",
      "    version: 2.3.0",
      "migrations:",
      '  - id: "0001_create_counters"',
      "    file: migrations/0001_create_counters.sql",
      "",
    ].join("\n"),
  );
  for (const [file, content] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return buildBundle(root);
}

function draftDigests(): Map<string, string> {
  return new Map(Object.entries(FILES).map(([file, content]) => [file, sha256(content)]));
}

describe("artifact identity", () => {
  it("reads every file digest from a bundle archive, long paths included", async () => {
    const built = await bundle();
    const digests = archiveFileDigests(built.archive);
    for (const [file, content] of Object.entries(FILES)) {
      expect(digests.get(file)).toBe(sha256(content));
    }
    expect([...digests.keys()].sort()).toEqual([...built.files].sort());
  });

  it("recognizes the same content compressed by a different zlib", async () => {
    const built = await bundle();
    const recompressed = gzipSync(gunzipSync(built.archive), { level: 9 });
    expect(sha256(recompressed)).not.toBe(built.sha256);
    expect(archiveFileDigests(recompressed)).toEqual(archiveFileDigests(built.archive));

    const comparison = compareValidatedArtifact({
      localManifest: built.manifest,
      localFiles: built.files,
      localDigests: archiveFileDigests(built.archive),
      remoteDigests: draftDigests(),
      validation: {
        manifest: JSON.parse(JSON.stringify(built.manifest)),
        artifactFiles: [...built.files],
      },
    });
    expect(comparison).toEqual({
      sameContent: true,
      manifestKeys: [],
      localOnlyFiles: [],
      serverOnlyFiles: [],
      changedFiles: [],
    });
  });

  it("names the manifest keys and files that really differ", async () => {
    const built = await bundle();
    const remoteDigests = draftDigests();
    remoteDigests.set("frontend/index.html", sha256("changed"));
    const comparison = compareValidatedArtifact({
      localManifest: built.manifest,
      localFiles: built.files,
      localDigests: archiveFileDigests(built.archive),
      remoteDigests,
      validation: {
        manifest: {
          ...JSON.parse(JSON.stringify(built.manifest)),
          runtime: { sdk: { version: "2.7.0" } },
        },
        artifactFiles: [...built.files.filter((file) => file !== LONG), "frontend/extra.js"],
      },
    });
    expect(comparison).toEqual({
      sameContent: false,
      manifestKeys: ["runtime"],
      localOnlyFiles: [LONG],
      serverOnlyFiles: ["frontend/extra.js"],
      changedFiles: ["frontend/index.html"],
    });
    expect(describeArtifactMismatch(comparison, "a".repeat(64), "b".repeat(64))).toBe(
      `Local bundle ${"a".repeat(64)} does not match OpenCloud's validated artifact ${"b".repeat(64)}. ` +
        "OpenCloud resolved these manifest keys differently: runtime. " +
        "These files differ between the local bundle and the uploaded draft: frontend/index.html. " +
        `Only the local bundle has: ${LONG}. ` +
        "Only OpenCloud's artifact has: frontend/extra.js.",
    );
  });

  it("ignores key order but not missing keys in resolved manifests", async () => {
    const built = await bundle();
    const reordered = Object.fromEntries(
      Object.entries(JSON.parse(JSON.stringify(built.manifest)) as Record<string, unknown>).reverse(),
    );
    const base = {
      localManifest: built.manifest,
      localFiles: built.files,
      localDigests: archiveFileDigests(built.archive),
      remoteDigests: draftDigests(),
    };
    expect(
      compareValidatedArtifact({
        ...base,
        validation: { manifest: reordered, artifactFiles: [...built.files] },
      }).sameContent,
    ).toBe(true);
    const { queues: _queues, ...withoutQueues } = reordered;
    expect(
      compareValidatedArtifact({
        ...base,
        validation: { manifest: withoutQueues, artifactFiles: [...built.files] },
      }).manifestKeys,
    ).toEqual(["queues"]);
  });
});
