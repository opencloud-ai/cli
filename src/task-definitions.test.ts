import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentTaskDefinitionSchema, parseManifest } from "@opencloud/contracts";
import { buildBundle } from "@opencloud/bundler";

const task = { name: "summary", title: "Summary", entrypoint: "functions/prepare/index.ts", resultFunction: "save",
  inputSchema: { type: "object", properties: {}, additionalProperties: false } };
const preparation = { name: "prepare", entrypoint: task.entrypoint, access: "system" };
const save = { name: "save", entrypoint: "functions/save/index.ts", access: "system" };
const manifest = { schemaVersion: 3, appId: "11111111-1111-4111-8111-111111111111",
  frontend: { directory: "frontend" }, runtime: { sdk: { version: "2.5.0" } }, agentTasks: [task], functions: [preparation, save] };
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("executable task compatibility", () => {
  it("keeps static tasks and requires exactly one instruction source", () => {
    expect(agentTaskDefinitionSchema.parse(task).entrypoint).toBe(task.entrypoint);
    expect(agentTaskDefinitionSchema.parse({ ...task, entrypoint: undefined, instructions: "Summarize" }).instructions).toBe("Summarize");
    for (const input of [{ ...task, instructions: "ambiguous" }, { ...task, entrypoint: undefined }, { ...task, entrypoint: "../task.ts" }])
      expect(agentTaskDefinitionSchema.safeParse(input).success).toBe(false);
  });
  it("requires one system Function in the same manifest", () => {
    expect(parseManifest(parseManifest(manifest))).toEqual(parseManifest(manifest));
    for (const functions of [[save], [{ ...preparation, access: "public" }, save], [preparation, { ...preparation, name: "duplicate" }, save]])
      expect(() => parseManifest({ ...manifest, functions })).toThrow(/exactly one declared Function/);
  });
  it("includes executable code in the immutable bundle", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencloud-task-cli-")); temporary.push(directory);
    await mkdir(path.join(directory, "frontend"));
    await writeFile(path.join(directory, "frontend/index.html"), "<!doctype html><title>Tasks</title>");
    await writeFile(path.join(directory, "opencloud.yaml"), JSON.stringify(manifest));
    for (const fn of manifest.functions) {
      await mkdir(path.dirname(path.join(directory, fn.entrypoint)), { recursive: true });
      await writeFile(path.join(directory, fn.entrypoint), 'import { defineFunction, schema } from "@opencloud/server"; export default defineFunction({ input: schema.object({}), handler: async () => ({ instructions: "Summarize" }) });');
    }
    expect((await buildBundle(directory)).files).toContain(task.entrypoint);
  });
});
