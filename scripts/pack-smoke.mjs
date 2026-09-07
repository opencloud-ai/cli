import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "opencloud-cli-package-test-"),
);
const packageDirectory = path.join(temporary, "package");
const consumer = path.join(temporary, "consumer");
await mkdir(packageDirectory);
await mkdir(consumer);

function run(file, arguments_, options = {}) {
  const result = spawnSync(file, arguments_, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    input: options.input,
  });
  assert.equal(
    result.status,
    options.status ?? 0,
    `${file} ${arguments_.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

try {
  const packed = run(
    "npm",
    ["pack", "--json", "--pack-destination", packageDirectory],
    { cwd: root },
  );
  const packResult = JSON.parse(packed.stdout);
  assert.equal(packResult.length, 1);
  const archive = path.join(packageDirectory, packResult[0].filename);
  const entries = [];
  await tar.list({
    file: archive,
    onentry: (entry) => entries.push(entry.path),
  });
  for (const expected of [
    "package/package.json",
    "package/dist/index.cjs",
    "package/README.md",
    "package/CHANGELOG.md",
  ]) {
    assert.ok(entries.includes(expected), `Packed CLI lacks ${expected}`);
  }
  assert.equal(
    entries.some((entry) =>
      /package\/(?:src|vendor|scripts|node_modules)\//.test(entry),
    ),
    false,
    "Packed CLI leaked source, snapshots, scripts, or dependencies",
  );

  await writeFile(
    path.join(consumer, "package.json"),
    `${JSON.stringify({ name: "opencloud-cli-smoke", private: true })}\n`,
  );
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive],
    { cwd: consumer },
  );
  const binary = path.join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "opencloud.cmd" : "opencloud",
  );
  const childEnvironment = { ...process.env };
  delete childEnvironment.INIT_CWD;
  const version = run(binary, ["--cli-version"], {
    cwd: consumer,
    env: childEnvironment,
  });
  assert.equal(version.stdout.trim(), "3.9.0");
  const help = run(binary, ["draft", "--help"], {
    cwd: consumer,
    env: childEnvironment,
  });
  assert.match(help.stdout, /deploy \[options\] <app-id> <draft-id>/);

  const invalid = run(
    binary,
    [
      "app",
      "credential-create",
      "00000000-0000-0000-0000-000000000001",
      "--name",
      "smoke",
      "--idempotency-key",
      "smoke-key-0001",
    ],
    { cwd: consumer, env: childEnvironment, status: 1 },
  );
  const diagnostic = JSON.parse(invalid.stderr);
  assert.equal(diagnostic.ok, false);
  assert.equal(typeof diagnostic.error.code, "string");

  run(
    binary,
    ["init", "sample-app", "--app-id", "00000000-0000-0000-0000-000000000001"],
    { cwd: consumer, env: childEnvironment },
  );
  const manifest = YAML.parse(
    await readFile(path.join(consumer, "sample-app", "opencloud.yaml"), "utf8"),
  );
  assert.equal(manifest.schemaVersion, 3);
  assert.equal("version" in manifest, false);

  process.stdout.write(
    "Packed OpenCloud CLI 3.9.0 installs, starts, emits structured failures, and initializes schema 3.\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
