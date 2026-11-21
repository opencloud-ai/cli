import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBundle,
  OPEN_CLOUD_E2E_TEST_MAX_BYTES,
  OPEN_CLOUD_E2E_TEST_PATH,
} from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("route assets", () => {
  async function fixture(asset = "icons/app.png") {
    const directory = await e2eFixture();
    await writeFile(path.join(directory, "opencloud.yaml"), `schemaVersion: 3
appId: 11111111-1111-4111-8111-111111111111
frontend:
  directory: frontend
runtime:
  sdk:
    version: 2.3.0
routes:
  - id: favicon
    path: /favicon.png
    asset: ${asset}
    access: public
  - id: apple-icon
    path: /apple-icon.png
    asset: ${asset}
    access: public
`);
    await mkdir(path.join(directory, "frontend/icons"));
    return directory;
  }

  it("bundles one regular file for two aliases without copying alias files", async () => {
    const directory = await fixture();
    await writeFile(path.join(directory, "frontend/icons/app.png"), "image bytes");
    const bundle = await buildBundle(directory);
    expect(bundle.files.filter((file) => file.endsWith(".png"))).toEqual(["frontend/icons/app.png"]);
    expect((await readArchivedManifest(bundle.archive)).routes).toHaveLength(2);
  });

  it("rejects a missing route target", async () => {
    await expect(buildBundle(await fixture())).rejects.toThrow(/asset.*does not exist/);
  });

  it("rejects directories and symbolic link targets", async () => {
    const directory = await fixture("icons");
    await expect(buildBundle(directory)).rejects.toThrow(/not a regular file/);
    const linked = await fixture();
    await symlink(path.join(linked, "frontend/index.html"), path.join(linked, "frontend/icons/app.png"));
    await expect(buildBundle(linked)).rejects.toThrow(/symlink/);
  });

  it.each(["../secret.png", "/secret.png", "icons/../../secret.png"])("rejects escaping target %s", async (asset) => {
    await expect(buildBundle(await fixture(asset))).rejects.toThrow();
  });
});

describe("executable task files", () => {
  it("bundles the declared Function file and its imports, and requires that file to exist", async () => {
    const directory = await e2eFixture();
    await writeFile(path.join(directory, "opencloud.yaml"), JSON.stringify({
      schemaVersion: 3, appId: "11111111-1111-4111-8111-111111111111", frontend: { directory: "frontend" },
      runtime: { sdk: { version: "2.5.0" } },
      functions: [{ name: "prepare", entrypoint: "functions/prepare/index.ts", access: "system" }],
      agentTasks: [{ name: "summary", title: "Summary", entrypoint: "functions/prepare/index.ts", resultFunction: "prepare",
        inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    }));
    await expect(buildBundle(directory)).rejects.toThrow();
    await mkdir(path.join(directory, "functions/prepare"), { recursive: true });
    await writeFile(path.join(directory, "functions/prepare/context.ts"), 'export const instructions = "Summarize the data";');
    await writeFile(path.join(directory, "functions/prepare/index.ts"), 'import { defineFunction, schema } from "@opencloud/server"; import { instructions } from "./context.ts"; export default defineFunction({ input: schema.object({}), handler: async () => ({ instructions }) });');
    const bundle = await buildBundle(directory);
    expect(bundle.files).toContain("functions/prepare/index.ts");
    expect(bundle.files).toContain("functions/prepare/context.ts");
    expect(await readArchivedManifest(bundle.archive)).toMatchObject({ agentTasks: [{ entrypoint: "functions/prepare/index.ts" }] });
  });
});

describe("platform-built frontends", () => {
  async function fixture() {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencloud-platform-build-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "opencloud.yaml"), `schemaVersion: 3
appId: 11111111-1111-4111-8111-111111111111
frontend:
  directory: frontend/dist
  build:
    script: build
runtime:
  sdk:
    version: 2.3.0
`);
    await mkdir(path.join(directory, "frontend/src"), { recursive: true });
    await writeFile(path.join(directory, "frontend/src/main.ts"), "render()");
    return directory;
  }

  it("keeps the build declaration in the canonical manifest", async () => {
    const directory = await fixture();
    await mkdir(path.join(directory, "frontend/dist"));
    await writeFile(path.join(directory, "frontend/dist/index.html"), "<built>");
    const bundle = await buildBundle(directory);
    expect(bundle.files).toContain("frontend/dist/index.html");
    expect((await readArchivedManifest(bundle.archive)).frontend).toMatchObject({ build: { script: "build" } });
  });

  it("checks the rest locally without the output OpenCloud will build", async () => {
    const directory = await fixture();
    await expect(buildBundle(directory)).rejects.toThrow(/frontend\/dist/i);
    const bundle = await buildBundle(directory, { platformFrontend: true });
    expect(bundle.files).toEqual(["opencloud.json"]);
    expect(bundle.warnings).toEqual([expect.objectContaining({ code: "FRONTEND_BUILT_BY_PLATFORM", path: "frontend/dist" })]);
  });

  it("ignores the option for a manifest without a build", async () => {
    const directory = await e2eFixture();
    const bundle = await buildBundle(directory, { platformFrontend: true });
    expect(bundle.files.some((file) => file.startsWith("frontend/"))).toBe(true);
  });
});

describe("Function source contracts", () => {
  it("rejects guessed platform backend access with an actionable error", async () => {
    const directory = await functionFixture(`Deno.serve(async (request) => {
  const base = Deno.env.get("SUPABASE_URL") ?? new URL(request.url).origin;
  return fetch(new URL("/rest/v1/items", base));
});
`);

    await expect(buildBundle(directory)).rejects.toThrow(
      /uses unsupported direct platform backend access.*defineFunction/s,
    );
  });

  it("rejects the removed legacy Function boundary", async () => {
    const directory = await functionFixture(
      'Deno.serve(() => new Response("ok"));\n',
    );

    await expect(buildBundle(directory)).rejects.toThrow(
      /removed legacy Function boundary.*defineFunction/s,
    );
  });

  const boundary = (imports: string) => `${imports}
import { defineFunction, schema } from "@opencloud/server";

export default defineFunction({ input: schema.object({}), handler: async () => ({}) });
`;

  it("rejects an import from outside the Function's own directory", async () => {
    const directory = await functionFixture(
      boundary('import { desk } from "../shared/desk.ts";'),
      { "functions/shared/desk.ts": "export const desk = 1;\n" },
    );

    await expect(buildBundle(directory)).rejects.toThrow(
      /Function example imports \.\.\/shared\/desk\.ts .*outside its directory functions\/example\/.*keep helper modules inside it/s,
    );
  });

  it("rejects an import of a file that does not exist", async () => {
    const directory = await functionFixture(boundary('import { desk } from "./desk";'));

    await expect(buildBundle(directory)).rejects.toThrow(
      /imports \.\/desk .*functions\/example\/desk does not exist.*including its extension/s,
    );
  });

  it("bundles helper modules inside the Function's directory", async () => {
    const directory = await functionFixture(
      boundary(`// import { old } from "../old.ts";
import { desk } from "./lib/desk.ts";
const later = () => import("./lib/later.ts");`),
      {
        "functions/example/lib/desk.ts": 'export { shared } from "./shared.ts";\nexport const desk = 1;\n',
        "functions/example/lib/shared.ts": "export const shared = 1;\n",
        "functions/example/lib/later.ts": "export const later = 1;\n",
      },
    );

    const bundle = await buildBundle(directory);

    expect(bundle.files).toEqual(expect.arrayContaining([
      "functions/example/lib/desk.ts",
      "functions/example/lib/later.ts",
      "functions/example/lib/shared.ts",
    ]));
  });

  it("accepts the first-party defineFunction boundary without a warning", async () => {
    const directory =
      await functionFixture(`import { defineFunction, schema } from "@opencloud/server";

export default defineFunction({
  input: schema.object({}),
  handler: async ({ data }) => ({ items: await data.table("items").list() }),
});
`);

    const bundle = await buildBundle(directory);

    expect(bundle.warnings.map((warning) => warning.code)).toEqual([
      "FRONTEND_SDK_NOT_REFERENCED",
    ]);
  });
});

describe("frontend SDK path contracts", () => {
  it.each([
    ["REST", 'await client.rest.request("/rest/v1/items?select=*")'],
    ["Storage", 'await client.storage.request("storage/v1/object/files/a")'],
  ])("rejects a repeated %s namespace", async (_label, expression) => {
    const directory = await e2eFixture();
    await writeFile(
      path.join(directory, "frontend/app.js"),
      `const runtime = await (await fetch("/_opencloud/config")).json();
const { createOpenCloudClient } = await import(runtime.javascriptSdk.module);
const client = createOpenCloudClient();
${expression};
`,
    );

    await expect(buildBundle(directory)).rejects.toThrow(
      /uses a removed or raw OpenCloud interface/,
    );
  });
});

describe("canonical manifest compatibility", () => {
  it("omits empty directories so file-only draft reconstruction is byte-identical", async () => {
    const directory = await e2eFixture();
    const emptyDirectory = path.join(directory, "frontend/evidence");
    await mkdir(emptyDirectory);

    const withEmptyDirectory = await buildBundle(directory);
    await rm(emptyDirectory, { recursive: true });
    const reconstructedFromFiles = await buildBundle(directory);

    expect(withEmptyDirectory.files).toEqual(reconstructedFromFiles.files);
    expect(withEmptyDirectory.sha256).toBe(reconstructedFromFiles.sha256);
    expect(withEmptyDirectory.archive).toEqual(reconstructedFromFiles.archive);
  });

  it("builds schema-3 artifacts without embedding a release version", async () => {
    const directory = await e2eFixture();
    const manifestFile = path.join(directory, "opencloud.yaml");
    const source = await readFile(manifestFile, "utf8");
    await writeFile(
      manifestFile,
      source.replace("schemaVersion: 2\n", "schemaVersion: 3\n").replace(
        "version: 1.0.0\n",
        "",
      ),
    );

    const bundle = await buildBundle(directory);
    const archived = await readArchivedManifest(bundle.archive);

    expect(bundle.manifest.schemaVersion).toBe(3);
    expect(bundle.manifest).not.toHaveProperty("version");
    expect(archived).not.toHaveProperty("version");
  });

  it("rejects author and override versions for schema-3 artifacts", async () => {
    const directory = await e2eFixture();
    const manifestFile = path.join(directory, "opencloud.yaml");
    const source = await readFile(manifestFile, "utf8");
    await writeFile(
      manifestFile,
      source.replace("schemaVersion: 2", "schemaVersion: 3"),
    );

    await expect(buildBundle(directory)).rejects.toThrow(
      /schema 3 removes the top-level version/,
    );
    await writeFile(
      manifestFile,
      source.replace("schemaVersion: 2\n", "schemaVersion: 3\n").replace(
        "version: 1.0.0\n",
        "",
      ),
    );
    await expect(buildBundle(directory, { version: "legacy" })).rejects.toThrow(
      /only for legacy schema-2 manifests/,
    );
  });

  it("keeps the CLI v3.1.0 archive shape when integrations are absent", async () => {
    const directory = await e2eFixture();

    const bundle = await buildBundle(directory);
    const archived = await readArchivedManifest(bundle.archive);

    expect(bundle.manifest.integrations).toEqual({});
    expect(bundle.manifest.queues).toEqual([]);
    expect(archived).not.toHaveProperty("integrations");
    expect(archived).not.toHaveProperty("queues");
  });

  it("retains declared background queues in the canonical archive", async () => {
    const directory = await functionFixture(`import { defineFunction, schema } from "@opencloud/server";

export default defineFunction({
  input: schema.object({}),
  handler: async ({ job }) => ({ job }),
});
`);
    const manifestFile = path.join(directory, "opencloud.yaml");
    const sourceManifest = await readFile(manifestFile, "utf8");
    await writeFile(
      manifestFile,
      `${sourceManifest.replace(
        "    entrypoint: functions/example/index.ts\n",
        "    entrypoint: functions/example/index.ts\n    access: system\n",
      )}queues:\n  - name: work\n    function: example\n`,
    );

    const bundle = await buildBundle(directory);
    const archived = await readArchivedManifest(bundle.archive);

    expect(archived.queues).toEqual(bundle.manifest.queues);
  });

  it("retains declared integrations in the canonical archive", async () => {
    const directory = await e2eFixture();
    const manifestFile = path.join(directory, "opencloud.yaml");
    await writeFile(
      manifestFile,
      `${await readFile(manifestFile, "utf8")}integrations:\n  calendar:\n    provider: google-calendar\n    account: calling_user\n    capabilities:\n      - calendar.events.read\n`,
    );

    const bundle = await buildBundle(directory);
    const archived = await readArchivedManifest(bundle.archive);

    expect(archived.integrations).toEqual(bundle.manifest.integrations);
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
      await writeFile(
        path.join(directory, "opencloud.yaml"),
        `schemaVersion: 2
appId: 11111111-1111-4111-8111-111111111111
version: 1.0.0
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

  it("accepts regular expressions whose text names a network API", async () => {
    const source = `import { test, expect } from "@opencloud/test";

const ticks = /WebSocket tick \\d+/;
test("shows live ticks", async ({ ownerPage }) => {
  await expect(ownerPage.getByText(/WebSocket tick \\d+/)).toBeVisible();
  await expect(ownerPage.getByRole("status").filter({ hasText: /it's an EventSource [/] XMLHttpRequest/i })).toBeVisible();
  const ready = true;
  if (ready) /WebSocket/.test("WebSocket");
  const rows = [/EventSource/, ticks].length / 2;
  expect(rows).toBe(1);
});
`;
    const directory = await e2eFixture(source);

    await expect(buildBundle(directory)).resolves.toMatchObject({
      e2eTest: { source },
    });
  });

  it.each([
    ["a new WebSocket", 'const socket = new WebSocket("wss://example.test");', "WebSocket"],
    ["a new EventSource", 'const events = new EventSource("/events");', "EventSource"],
    ["an alias", "const Socket = WebSocket;", "WebSocket"],
    ["use inside a template", 'const label = `${new EventSource("/events")}`;', "EventSource"],
    ["use after a regular expression", 'const live = /tick/.test("tick") && new WebSocket("wss://example.test");', "WebSocket"],
    ["use between divisions", 'const half = 4 / 2; new XMLHttpRequest(); const third = 9 / 3;', "XMLHttpRequest"],
    ["use after a U+2028 line-comment terminator", '// ok\u2028new WebSocket("wss://evil");', "WebSocket"],
    ["use after a U+2029 line-comment terminator", '// ok\u2029new WebSocket("wss://evil");', "WebSocket"],
    ["use after a CR line-comment terminator", '// ok\rnew WebSocket("wss://evil");', "WebSocket"],
    ["use after an if-header regex containing a quote", `if (1) /'/; new WebSocket("wss://evil");`, "WebSocket"],
    ["use after a block-closing brace regex containing a quote", `{ const ok = 1; } /'/; new WebSocket("wss://evil");`, "WebSocket"],
    ["use after an await regex containing a quote", `await /'/; new WebSocket("wss://evil");`, "WebSocket"],
    ["use inside a template after an if-header regex containing a closing brace", 'const s = `${(() => { if (1) /}/ })() || new WebSocket("wss://evil")}`;', "WebSocket"],
    ["use between an object-literal division and another division", 'const a = { n: 1 } / 2; new WebSocket("wss://evil"); const b = 4 / 2;', "WebSocket"],
  ])("refuses %s, naming the network API", async (_label, statement, name) => {
    const directory = await e2eFixture(
      `import { test, expect } from "@opencloud/test";\ntest("flow", async ({ ownerPage }) => { ${statement} expect(ownerPage); });\n`,
    );

    await expect(buildBundle(directory)).rejects.toThrow(
      `OpenCloud E2E test cannot use ${name}, a direct network API`,
    );
  });
});

async function functionFixture(
  source: string,
  extraFiles: Record<string, string> = {},
): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "opencloud-bundler-function-"),
  );
  temporaryDirectories.push(directory);
  await Promise.all([
    mkdir(path.join(directory, "frontend"), { recursive: true }),
    mkdir(path.join(directory, "functions/example"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(directory, "opencloud.yaml"),
      `schemaVersion: 2
appId: 11111111-1111-4111-8111-111111111111
version: 1.0.0
frontend:
  directory: frontend
  spa: true
runtime:
  sdk:
    version: 2.0.0
functions:
  - name: example
    entrypoint: functions/example/index.ts
`,
    ),
    writeFile(
      path.join(directory, "frontend/index.html"),
      "<!doctype html><title>Test</title>",
    ),
    writeFile(path.join(directory, "functions/example/index.ts"), source),
    ...Object.entries(extraFiles).map(async ([name, content]) => {
      await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
      await writeFile(path.join(directory, name), content);
    }),
  ]);
  return directory;
}

async function e2eFixture(source?: string): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "opencloud-bundler-e2e-"),
  );
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, "frontend"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(directory, "opencloud.yaml"),
      `schemaVersion: 2
appId: 11111111-1111-4111-8111-111111111111
version: 1.0.0
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

async function readArchivedManifest(
  archive: Buffer,
): Promise<Record<string, unknown>> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "opencloud-bundler-archive-"),
  );
  temporaryDirectories.push(directory);
  const archiveFile = path.join(directory, "bundle.tgz");
  const extracted = path.join(directory, "extracted");
  await mkdir(extracted);
  await writeFile(archiveFile, archive);
  await tar.extract({ cwd: extracted, file: archiveFile });
  return JSON.parse(
    await readFile(path.join(extracted, "opencloud.json"), "utf8"),
  ) as Record<string, unknown>;
}
