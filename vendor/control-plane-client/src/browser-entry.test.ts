import { builtinModules } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(packageRoot, "src");
const importPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
const builtins = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

function browserModuleGraph(entry: string): Map<string, string> {
  const pending = [entry];
  const files = new Map<string, string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    const source = readFileSync(file, "utf8");
    files.set(file, source);
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]!;
      expect(builtins.has(specifier), `${file} imports ${specifier}`).toBe(
        false,
      );
      if (!specifier.startsWith(".")) continue;
      pending.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }
  return files;
}

describe("browser package boundary", () => {
  it("publishes explicit root, Node, browser, and neutral transport exports", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };

    expect(Object.keys(manifest.exports)).toEqual(
      expect.arrayContaining([".", "./node", "./browser", "./transport"]),
    );
  });

  it("keeps Node built-ins and common polyfill triggers out of the browser graph", () => {
    const graph = browserModuleGraph(resolve(sourceRoot, "browser.ts"));

    expect(
      [...graph.keys()].map((file) => file.slice(sourceRoot.length + 1)),
    ).toEqual(["browser.ts", "transport.ts", "errors.ts"]);
    for (const [file, source] of graph) {
      expect(source, file).not.toMatch(/\bBuffer\b|\bprocess\.|\brequire\s*\(/);
    }
  });

  it("bundles the browser entry without Node shims or polyfills", async () => {
    const result = await build({
      absWorkingDir: packageRoot,
      entryPoints: ["src/browser.ts"],
      bundle: true,
      format: "esm",
      logLevel: "silent",
      metafile: true,
      platform: "browser",
      write: false,
    });
    const output = result.outputFiles?.[0]?.text;

    expect(output).toBeDefined();
    expect(output).not.toMatch(
      /node:|\bBuffer\b|\bprocess\.|\brequire\s*\(|__commonJS/,
    );
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    expect(inputs).toEqual(
      expect.arrayContaining([
        "src/browser.ts",
        "src/transport.ts",
        "src/errors.ts",
      ]),
    );
    for (const input of inputs) {
      expect(input).not.toMatch(
        /^\(disabled\):|cron-parser|luxon|contracts\/dist\/manifest/,
      );
    }
  });
});
