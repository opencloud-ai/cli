import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as tar from "tar";
import {
  buildBundle,
  OPEN_CLOUD_E2E_TEST_MAX_BYTES,
  OPEN_CLOUD_E2E_TEST_PATH,
} from "./bundle.js";

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
        version: "2.0.0",
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

  it("accepts the explicit installed SDK pin", async () => {
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
    version: 2.0.0
`,
    );

    const bundle = await buildBundle(root);
    expect(bundle.manifest.runtime).toEqual({
      sdk: {
        version: "2.0.0",
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

describe("conventional OpenCloud E2E tests", () => {
  const validE2eSource = `import { expect, test } from "@opencloud/test";

test("creates a record through the UI", async ({ ownerPage }) => {
  await ownerPage.getByRole("button", { name: "Add item" }).click();
  await expect(ownerPage.getByRole("status")).toHaveText("Item added");
});
`;

  it("keeps legacy bundles unchanged when the conventional spec is absent", async () => {
    const directory = await e2eFixture();

    const bundle = await buildBundle(directory);

    expect(bundle.e2eTest).toBeUndefined();
    expect(bundle.files).not.toContain(OPEN_CLOUD_E2E_TEST_PATH);
    expect(bundle.sourceFiles).not.toContain(OPEN_CLOUD_E2E_TEST_PATH);
  });

  it("includes a valid conventional spec and exposes bounded immutable metadata", async () => {
    const directory = await e2eFixture(validE2eSource);

    const first = await buildBundle(directory);
    const second = await buildBundle(directory);

    expect(first.files).toContain(OPEN_CLOUD_E2E_TEST_PATH);
    expect(first.sourceFiles).toContain(OPEN_CLOUD_E2E_TEST_PATH);
    expect(first.e2eTest).toEqual({
      path: OPEN_CLOUD_E2E_TEST_PATH,
      source: validE2eSource,
      sha256: createHash("sha256").update(validE2eSource).digest("hex"),
    });
    expect(second.sha256).toBe(first.sha256);
    expect(second.archive).toEqual(first.archive);
    expect(second.e2eTest).toEqual(first.e2eTest);
  });

  it.each([".", "tests"])(
    "rejects an E2E spec inside public frontend directory %s",
    async (frontendDirectory) => {
      const directory = await e2eFixture(validE2eSource);
      await writeManifest(
        directory,
        `
frontend:
  directory: ${frontendDirectory}
  spa: true
runtime:
  sdk:
    version: 2.0.0
`,
      );

      await expect(buildBundle(directory)).rejects.toThrow(
        /must stay outside frontend\.directory/,
      );
    },
  );

  it("rejects a spec over the bounded source size", async () => {
    const oversized = `${validE2eSource}\n/*${"x".repeat(OPEN_CLOUD_E2E_TEST_MAX_BYTES)}*/`;
    const directory = await e2eFixture(oversized);

    await expect(buildBundle(directory)).rejects.toThrow(
      new RegExp(`exceeds ${OPEN_CLOUD_E2E_TEST_MAX_BYTES} bytes`),
    );
  });

  it.each([
    [
      "a package subpath",
      'import { test } from "@opencloud/test/fixtures";\ntest("flow", async () => {});\n',
    ],
    [
      "an unrelated package",
      'import { test } from "@playwright/test";\ntest("flow", async () => {});\n',
    ],
    [
      "a default import",
      'import test from "@opencloud/test";\ntest("flow", async () => {});\n',
    ],
    [
      "a second import",
      'import { test, expect } from "@opencloud/test";\nimport value from "./helper.js";\ntest("flow", async () => expect(value));\n',
    ],
  ])("rejects %s instead of the exact test import", async (_label, source) => {
    const directory = await e2eFixture(source);

    await expect(buildBundle(directory)).rejects.toThrow(
      /exactly one named import from "@opencloud\/test"/,
    );
  });

  it("requires the named test import", async () => {
    const directory = await e2eFixture(
      'import { expect } from "@opencloud/test";\nexpect(true).toBe(true);\n',
    );

    await expect(buildBundle(directory)).rejects.toThrow(
      /must import exactly test and expect from "@opencloud\/test"/,
    );
  });

  it("requires at least one test declaration", async () => {
    const directory = await e2eFixture(
      'import { test, expect } from "@opencloud/test";\ntest.describe("items", () => expect(items));\n',
    );

    await expect(buildBundle(directory)).rejects.toThrow(
      /must declare at least one test/,
    );
  });

  it.each([
    ["test.skip", "test.skip"],
    ["test.only", "test.only"],
    ["test.describe.skip", "test.describe.skip"],
    ["test.describe.only", "test.describe.only"],
  ])("rejects %s", async (_label, call) => {
    const directory = await e2eFixture(
      `import { test, expect } from "@opencloud/test";\n${call}("flow", async () => expect(true));\ntest("required", async () => expect(true));\n`,
    );

    await expect(buildBundle(directory)).rejects.toThrow(
      /cannot use skip or only/,
    );
  });

  it.each([
    ["fetch", "await fetch('/items')"],
    ["XMLHttpRequest", "new XMLHttpRequest()"],
    ["browser evaluation", "await ownerPage.evaluate(() => true)"],
    [
      "locator evaluation",
      "await ownerPage.locator('main').evaluateAll(() => [])",
    ],
    ["network routing", "await ownerPage.route('**/*', () => {})"],
    ["direct navigation", "await ownerPage.goto('https://example.test')"],
    ["request context", "await request.get('/items')"],
    ["backend route", 'const backend = "/rest/v1/items"'],
  ])("rejects direct %s access", async (_label, expression) => {
    const directory = await e2eFixture(
      `import { test, expect } from "@opencloud/test";\ntest("flow", async ({ ownerPage, request }) => { ${expression}; expect(ownerPage); });\n`,
    );

    await expect(buildBundle(directory)).rejects.toThrow(
      /cannot (?:use|access)/,
    );
  });
});

async function e2eFixture(source?: string): Promise<string> {
  const directory = await temporaryDirectory();
  await mkdir(path.join(directory, "frontend"), { recursive: true });
  await Promise.all([
    writeManifest(
      directory,
      `
frontend:
  directory: frontend
  spa: true
runtime:
  sdk:
    version: 2.0.0
`,
    ),
    writeFile(
      path.join(directory, "frontend/index.html"),
      "<!doctype html><title>Test</title>",
    ),
  ]);
  if (source !== undefined) {
    await mkdir(path.join(directory, "tests"), { recursive: true });
    await writeFile(path.join(directory, OPEN_CLOUD_E2E_TEST_PATH), source);
  }
  return directory;
}
