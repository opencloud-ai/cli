import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const version = packageJson.version;
assert.match(version, /^\d+\.\d+\.\d+$/);

const [source, changelog, readme] = await Promise.all([
  readFile(path.join(root, "src", "index.ts"), "utf8"),
  readFile(path.join(root, "CHANGELOG.md"), "utf8"),
  readFile(path.join(root, "README.md"), "utf8"),
]);

assert.ok(
  source.includes(`const CLI_VERSION = "${version}";`),
  `src/index.ts does not declare CLI_VERSION ${version}`,
);
assert.ok(
  changelog.includes(`## ${version}`),
  `CHANGELOG.md has no ${version} section`,
);
assert.ok(
  readme.includes(`v${version}`),
  `README.md does not reference v${version}`,
);

const expected = process.argv[2]?.replace(/^v/, "");
if (expected) {
  assert.equal(version, expected, `package version does not match tag v${expected}`);
}

process.stdout.write(`OpenCloud CLI version ${version} is aligned.\n`);
