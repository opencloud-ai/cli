import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as tar from "tar";
import { buildBundle } from "./bundle.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencloud-cli-test-"));
  temporary.push(root);
  return root;
}

async function writeManifest(root: string, body: string): Promise<void> {
  await writeFile(
    path.join(root, "opencloud.yaml"),
    `
schemaVersion: 2
appId: aeea1c71-72a3-4b1d-a32e-213900735091
version: test-1
${body.trim()}
`,
  );
}

describe("bundle builder", () => {
  it("archives only manifest-reachable files in deterministic order", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, "frontend", "assets"), { recursive: true });
    await mkdir(path.join(root, "migrations"));
    await mkdir(path.join(root, "functions", "process"), { recursive: true });
    await mkdir(path.join(root, "functions", "process", "lib"), {
      recursive: true,
    });
    await writeFile(path.join(root, "frontend", "index.html"), "hello");
    await writeFile(
      path.join(root, "frontend", "assets", "app.js"),
      'import { opencloud } from "/_opencloud/sdk.js"; void opencloud.app.info();',
    );
    await writeFile(
      path.join(root, "migrations", "0001_notes.sql"),
      "create table notes(id uuid primary key);",
    );
    await writeFile(
      path.join(root, "functions", "process", "index.ts"),
      "import './shared.ts';",
    );
    await writeFile(
      path.join(root, "functions", "process", "shared.ts"),
      "export const value = 1;",
    );
    await writeFile(
      path.join(root, "functions", "process", "lib", "index.ts"),
      "export const helper = true;",
    );
    await writeFile(path.join(root, "BRIEF.md"), "author instructions");
    await writeFile(path.join(root, "AGENT_REPORT.md"), "first report");
    await writeFile(
      path.join(root, "smoke.mjs"),
      "throw new Error('test only')",
    );
    await writeFile(path.join(root, "unreachable.txt"), "not runtime input");
    await writeManifest(
      root,
      `
frontend:
  directory: frontend
  spa: true
migrations:
  - id: 0001_notes
    file: migrations/0001_notes.sql
functions:
  - name: process
    entrypoint: functions/process/index.ts
`,
    );

    const first = await buildBundle(root);
    expect(first.manifest.migrations[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifest.runtime).toEqual({
      sdk: {
        version: "1.0.0",
      },
    });
    expect(first.files).toEqual([
      "frontend/assets/app.js",
      "frontend/index.html",
      "functions/process/index.ts",
      "functions/process/lib/index.ts",
      "functions/process/shared.ts",
      "migrations/0001_notes.sql",
      "opencloud.json",
    ]);
    expect(first.sourceManifest).toBe("opencloud.yaml");
    expect(first.sourceFiles).toEqual([
      "frontend/assets/app.js",
      "frontend/index.html",
      "functions/process/index.ts",
      "functions/process/lib/index.ts",
      "functions/process/shared.ts",
      "migrations/0001_notes.sql",
      "opencloud.yaml",
    ]);
    expect(first.sourceFiles).not.toContain("opencloud.json");
    expect(first.warnings).toEqual([]);

    await writeFile(path.join(root, "AGENT_REPORT.md"), "updated report");
    const second = await buildBundle(root);
    expect(second.files).toEqual(first.files);
    expect(second.sha256).toBe(first.sha256);

    const archiveFile = path.join(root, "archive.tgz");
    await writeFile(archiveFile, first.archive);
    const archivedFiles: string[] = [];
    await tar.list({
      file: archiveFile,
      onentry: (entry) => {
        if (entry.type === "File") archivedFiles.push(entry.path);
      },
    });
    expect(archivedFiles.sort()).toEqual(first.files);
  });

  it("never archives local .opencloud development metadata", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, ".opencloud"));
    await writeFile(path.join(root, "index.html"), "hello");
    await writeFile(
      path.join(root, ".opencloud", "dev.json"),
      JSON.stringify({ sessionId: "bearer-capability" }),
    );
    await writeManifest(
      root,
      `
frontend:
  directory: .
`,
    );

    const bundle = await buildBundle(root);
    expect(bundle.files).toContain("index.html");
    expect(bundle.files.some((file) => file.startsWith(".opencloud/"))).toBe(
      false,
    );
  });

  it("warns about conventional migrations and Functions omitted from the manifest", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, "frontend"));
    await mkdir(path.join(root, "migrations"));
    await mkdir(path.join(root, "functions", "forgotten"), {
      recursive: true,
    });
    await writeFile(path.join(root, "frontend", "index.html"), "hello");
    await writeFile(
      path.join(root, "migrations", "0002_forgotten.sql"),
      "select 1;",
    );
    await writeFile(
      path.join(root, "functions", "forgotten", "index.ts"),
      "export {};",
    );
    await writeManifest(
      root,
      `
frontend:
  directory: frontend
migrations: []
functions: []
`,
    );

    const bundle = await buildBundle(root);
    expect(bundle.warnings).toEqual([
      expect.objectContaining({
        code: "FRONTEND_SDK_NOT_REFERENCED",
        path: "frontend",
      }),
      expect.objectContaining({
        code: "UNDECLARED_FUNCTION_ENTRYPOINT",
        path: "functions/forgotten/index.ts",
      }),
      expect.objectContaining({
        code: "UNDECLARED_MIGRATION_FILE",
        path: "migrations/0002_forgotten.sql",
      }),
    ]);
    expect(bundle.files).not.toContain("migrations/0002_forgotten.sql");
    expect(bundle.files).not.toContain("functions/forgotten/index.ts");
  });

  it("preserves an explicit SDK pin instead of replacing it with current", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, "frontend"));
    await writeFile(path.join(root, "frontend", "index.html"), "hello");
    await writeManifest(
      root,
      `
frontend:
  directory: frontend
runtime:
  sdk:
    version: 9.8.7
`,
    );

    const bundle = await buildBundle(root);
    expect(bundle.manifest.runtime).toEqual({
      sdk: {
        version: "9.8.7",
      },
    });
  });

  it("can stamp a release-specific system-app version without editing source", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, "frontend"));
    await writeFile(path.join(root, "frontend", "index.html"), "hello");
    await writeManifest(
      root,
      `
frontend:
  directory: frontend
`,
    );

    const bundle = await buildBundle(root, {
      version: "platform-1.2.3-docs.1",
    });

    expect(bundle.manifest.version).toBe("platform-1.2.3-docs.1");
  });

  it("rejects paths that escape the app before reading them", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, "frontend"));
    await writeFile(path.join(root, "frontend", "index.html"), "hello");
    await writeManifest(
      root,
      `
frontend:
  directory: frontend
migrations:
  - id: 0001_escape
    file: ../outside.sql
`,
    );

    await expect(buildBundle(root)).rejects.toThrow(
      "Migration file cannot escape the app bundle",
    );
  });

  it("reserves the canonical manifest path from declared runtime inputs", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, "frontend"));
    await writeFile(path.join(root, "frontend", "index.html"), "hello");
    await writeManifest(
      root,
      `
frontend:
  directory: frontend
migrations:
  - id: 0001_manifest
    file: opencloud.yaml
`,
    );

    await expect(buildBundle(root)).rejects.toThrow(
      "conflicts with the canonical opencloud.json",
    );
  });

  it("rejects symlinks in selected trees and declared path components", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(path.join(outside, "index.html"), "outside");
    await mkdir(path.join(root, "frontend"));
    await symlink(
      path.join(outside, "index.html"),
      path.join(root, "frontend", "index.html"),
    );
    await writeManifest(
      root,
      `
frontend:
  directory: frontend
`,
    );

    await expect(buildBundle(root)).rejects.toThrow(
      "App bundles cannot contain symlinks: frontend/index.html",
    );

    await rm(path.join(root, "frontend"), { recursive: true });
    await symlink(outside, path.join(root, "frontend"), "dir");
    await expect(buildBundle(root)).rejects.toThrow(
      "Frontend directory frontend cannot traverse a symlink",
    );
  });

  it("fails when a declared input is missing", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, "frontend"));
    await writeFile(path.join(root, "frontend", "index.html"), "hello");
    await mkdir(path.join(root, "functions", "missing"), { recursive: true });
    await writeManifest(
      root,
      `
frontend:
  directory: frontend
functions:
  - name: missing
    entrypoint: functions/missing/index.ts
`,
    );

    await expect(buildBundle(root)).rejects.toThrow(
      "Function entrypoint functions/missing/index.ts does not exist",
    );
  });
});
