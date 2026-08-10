import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.join(root, "dist");
const output = path.join(outputDirectory, "index.cjs");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [path.join(root, "src", "index.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  external: ["@napi-rs/keyring"],
  alias: {
    "@opencloud/contracts": path.join(
      root,
      "vendor",
      "contracts",
      "src",
      "index.ts",
    ),
    "@opencloud/js": path.join(
      root,
      "vendor",
      "browser-client",
      "src",
      "index.ts",
    ),
    "@opencloud/bundler": path.join(
      root,
      "vendor",
      "bundler",
      "src",
      "index.ts",
    ),
    "@opencloud/control-plane-client": path.join(
      root,
      "vendor",
      "control-plane-client",
      "src",
      "index.ts",
    ),
  },
});

const source = await readFile(output, "utf8");
if (!source.startsWith("#!/usr/bin/env node")) {
  throw new Error("Bundled CLI lost its executable hashbang");
}
await chmod(output, 0o755);
