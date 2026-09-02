import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const self = fileURLToPath(import.meta.url);

async function waitFor(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function worker(root, role, bundledModule) {
  const { withDevWorkflowLock } = await import(pathToFileURL(bundledModule));
  const state = path.join(root, "state.txt");
  const entered = path.join(root, `${role}.entered`);
  const release = path.join(root, `${role}.release`);
  await withDevWorkflowLock(root, async () => {
    await appendFile(path.join(root, "events.txt"), `${role}:entered\n`);
    await writeFile(entered, "entered\n");
    if (role === "sync") {
      const captured = await readFile(state, "utf8");
      await waitFor(release);
      await writeFile(state, `synced:${captured.trim()}\n`);
    } else if (role === "stop") {
      assert.equal((await readFile(state, "utf8")).trim(), "synced:old");
      await writeFile(state, "absent\n");
    } else if (role === "start") {
      await waitFor(release);
      await writeFile(state, "new-session\n");
    } else if (role === "promote") {
      assert.equal((await readFile(state, "utf8")).trim(), "new-session");
      await writeFile(state, "promoted\n");
    }
  });
}

function spawnWorker(root, role, bundledModule) {
  const child = spawn(
    process.execPath,
    [self, "worker", root, role, bundledModule],
    {
    stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => {
      if (status === 0) resolve();
      else reject(new Error(`${role} worker failed (${status}): ${stderr}`));
    });
  });
}

if (process.argv[2] === "worker") {
  await worker(process.argv[3], process.argv[4], process.argv[5]);
} else {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "opencloud-dev-workflow-lock-contract-"),
  );
  try {
    const bundledModule = path.join(temporary, "dev-workflow-lock.cjs");
    await build({
      entryPoints: [
        path.resolve(import.meta.dirname, "..", "src", "dev-workflow-lock.ts"),
      ],
      outfile: bundledModule,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
    });
    await writeFile(path.join(temporary, "state.txt"), "old\n");
    const sync = spawnWorker(temporary, "sync", bundledModule);
    await waitFor(path.join(temporary, "sync.entered"));
    const stop = spawnWorker(temporary, "stop", bundledModule);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(access(path.join(temporary, "stop.entered")));
    await writeFile(path.join(temporary, "sync.release"), "release\n");
    await Promise.all([sync, stop]);
    assert.equal(
      (await readFile(path.join(temporary, "state.txt"), "utf8")).trim(),
      "absent",
      "a stopped dev session must not be resurrected by a late sync write",
    );

    for (const name of [
      "sync.entered",
      "sync.release",
      "stop.entered",
      "events.txt",
    ]) {
      await rm(path.join(temporary, name), { force: true });
    }
    const start = spawnWorker(temporary, "start", bundledModule);
    await waitFor(path.join(temporary, "start.entered"));
    const promote = spawnWorker(temporary, "promote", bundledModule);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(access(path.join(temporary, "promote.entered")));
    await writeFile(path.join(temporary, "start.release"), "release\n");
    await Promise.all([start, promote]);
    assert.equal(
      (await readFile(path.join(temporary, "state.txt"), "utf8")).trim(),
      "promoted",
    );

    const lock = path.join(
      temporary,
      ".opencloud",
      ".dev-workflow.lock",
    );
    await mkdir(lock, { recursive: true });
    const stale = new Date(Date.now() - 120_000);
    await utimes(lock, stale, stale);
    const startedAt = Date.now();
    await spawnWorker(temporary, "noop", bundledModule);
    assert.ok(
      Date.now() - startedAt < 5_000,
      "stale workflow-lock recovery exceeded its bounded retry window",
    );

    process.stdout.write(
      "Cross-process dev workflow serialization and stale-lock recovery contract passed.\n",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
