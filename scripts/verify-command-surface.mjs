import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const binary = path.join(root, "dist", "index.cjs");
const contract = JSON.parse(
  await readFile(
    path.join(import.meta.dirname, "public-cli-3.7.0-command-surface.json"),
    "utf8",
  ),
);

const version = spawnSync(process.execPath, [binary, "--cli-version"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout.trim(), contract.version);

function commandHelp(parts) {
  const result = spawnSync(process.execPath, [binary, ...parts, "--help"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `Help failed for opencloud ${parts.join(" ")}: ${result.stderr}`,
  );
  return result.stdout;
}

function childNames(help) {
  const marker = "\nCommands:\n";
  const offset = help.indexOf(marker);
  if (offset < 0) return [];
  const section = help.slice(offset + marker.length);
  const names = [];
  for (const line of section.split("\n")) {
    const match = /^  ([a-z][a-z0-9-]*)(?:\s|$)/.exec(line);
    if (match?.[1] && match[1] !== "help") names.push(match[1]);
  }
  return [...new Set(names)];
}

const groups = [];
const commands = [];
const visit = (parts) => {
  const help = commandHelp(parts);
  const usage = /^Usage: (.+)$/m.exec(help)?.[1];
  assert.ok(usage, `Usage is absent for opencloud ${parts.join(" ")}`);
  const commandPath = ["opencloud", ...parts].join(" ");
  const entry = `${commandPath}|${usage}`;
  const children = childNames(help);
  if (parts.length && !children.length) {
    commands.push(entry);
    return;
  }
  if (parts.length) groups.push(entry);
  else assert.equal(usage, contract.provenance.rootUsage);
  for (const child of children) visit([...parts, child]);
};
visit([]);

const sorted = (values) =>
  [...values].sort((left, right) => left.localeCompare(right));
assert.deepEqual(sorted(groups), sorted(contract.groups));
assert.deepEqual(sorted(commands), sorted(contract.commands));
assert.equal(groups.length, contract.provenance.groupCount);
assert.equal(commands.length, contract.provenance.leafCount);
assert.equal(
  createHash("sha256").update(await readFile(binary)).digest("hex"),
  contract.provenance.entrypointSha256,
);

process.stdout.write(
  `OpenCloud CLI ${contract.version} exposes ${groups.length} groups and ${commands.length} leaf commands.\n`,
);
