import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_OWNER_MUTATION_JOURNAL_DIRECTORY,
  MUTATION_JOURNAL_ENV,
  MutationJournal,
  MutationJournalError,
  assertAppOwnerMutationJournalDirectory,
  linuxMountInfoContains,
  resolveMutationJournalDirectory,
} from "./mutation-journal.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_APP_ID = "22222222-2222-4222-8222-222222222222";
const API_URL = "https://api.example.test";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "opencloud-mutation-journal-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe("mutation journal", () => {
  it("accepts only the canonical app-owner runtime journal path", () => {
    expect(
      assertAppOwnerMutationJournalDirectory(
        APP_OWNER_MUTATION_JOURNAL_DIRECTORY,
      ),
    ).toBe("/workspace/.opencloud/agent-mutations");
    for (const configuredDirectory of [
      undefined,
      "/home/agent/runtime-mutations",
      "/workspace/.opencloud/agent-mutations/",
      "/workspace/.opencloud/other/../agent-mutations",
    ]) {
      expect(() =>
        assertAppOwnerMutationJournalDirectory(configuredDirectory),
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_APP_OWNER_MUTATION_JOURNAL_DIRECTORY",
        }),
      );
    }
  });

  it("recognizes only an exact escaped Linux mountpoint", () => {
    const mountInfo = [
      "31 23 0:27 / /workspace rw,relatime - ext4 /dev/test rw",
      "32 31 0:28 / /workspace/.opencloud/agent-mutations rw,relatime - ext4 /dev/test rw",
      "33 31 0:29 / /workspace/name\\040with\\040spaces rw,relatime - ext4 /dev/test rw",
    ].join("\n");
    expect(
      linuxMountInfoContains(
        mountInfo,
        "/workspace/.opencloud/agent-mutations",
      ),
    ).toBe(true);
    expect(
      linuxMountInfoContains(mountInfo, "/workspace/.opencloud"),
    ).toBe(false);
    expect(
      linuxMountInfoContains(mountInfo, "/workspace/name with spaces"),
    ).toBe(true);
  });

  it("uses an absolute environment override independent of cwd", async () => {
    const root = await temporaryDirectory();
    const configured = path.join(root, "runtime-journal");
    expect(
      resolveMutationJournalDirectory({
        configuredDirectory: configured,
        workspaceFile: path.join(root, "one", ".opencloud", "app.json"),
        configDirectory: path.join(root, "config"),
        apiUrl: API_URL,
        appId: APP_ID,
      }),
    ).toBe(configured);
    expect(() =>
      resolveMutationJournalDirectory({
        configuredDirectory: "relative/journal",
        configDirectory: root,
        apiUrl: API_URL,
        appId: APP_ID,
      }),
    ).toThrow(`${MUTATION_JOURNAL_ENV} must be a non-empty absolute path`);
  });

  it("uses the nearest workspace mutation directory or a protected config fallback", async () => {
    const root = await temporaryDirectory();
    const workspaceFile = path.join(root, "project", ".opencloud", "app.json");
    const fromWorkspace = resolveMutationJournalDirectory({
      workspaceFile,
      configDirectory: path.join(root, "config"),
      apiUrl: API_URL,
      appId: APP_ID,
    });
    expect(path.dirname(fromWorkspace)).toBe(
      path.join(root, "project", ".opencloud", "agent-mutations"),
    );
    expect(path.basename(fromWorkspace)).toMatch(/^[a-f0-9]{64}$/);

    const fromConfig = resolveMutationJournalDirectory({
      configDirectory: path.join(root, "config"),
      apiUrl: API_URL,
      appId: APP_ID,
    });
    expect(path.dirname(fromConfig)).toBe(
      path.join(root, "config", "mutation-journals"),
    );
  });

  it("binds a configured directory to exactly one API and app before callbacks run", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    await MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID });
    const callback = vi.fn();
    await expect(
      MutationJournal.open({
        directory,
        apiUrl: API_URL,
        appId: OTHER_APP_ID,
      }),
    ).rejects.toMatchObject({ code: "MUTATION_JOURNAL_BINDING_MISMATCH" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("rejects a journal root replaced after open before touching the replacement", async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, "journal");
    const original = path.join(root, "journal-original");
    const journal = await MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
    });
    await rename(directory, original);
    await mkdir(directory, { mode: 0o700 });
    const callback = vi.fn();

    await expect(
      journal.run(
        {
          commandId: "opencloud app restart",
          safeScope: { appId: APP_ID },
          safeRequest: { action: "restart" },
        },
        callback,
      ),
    ).rejects.toMatchObject({ code: "MUTATION_JOURNAL_ROOT_CHANGED" });
    expect(callback).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
    expect(await readdir(path.join(original, "entries"))).toEqual([]);
    await expect(
      MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID }),
    ).rejects.toMatchObject({ code: "MUTATION_JOURNAL_ROOT_CHANGED" });
  });

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "completes through the retained root descriptor and blocks a cold duplicate after a swap",
    async () => {
      const root = await temporaryDirectory();
      const directory = path.join(root, "journal");
      const original = path.join(root, "journal-original");
      const journal = await MutationJournal.open({
        directory,
        apiUrl: API_URL,
        appId: APP_ID,
      });
      const spec = {
        commandId: "opencloud app restart" as const,
        safeScope: { appId: APP_ID },
        safeRequest: { action: "restart" },
      };
      let effects = 0;
      await journal.run(spec, async (run) => {
        await run.markAttempted();
        await rename(directory, original);
        await mkdir(directory, { mode: 0o700 });
        effects += 1;
        await run.complete();
      });
      expect(effects).toBe(1);
      const [entry] = await readdir(path.join(original, "entries"));
      expect(
        JSON.parse(
          await readFile(
            path.join(original, "entries", String(entry)),
            "utf8",
          ),
        ),
      ).toMatchObject({ state: "completed", attemptCount: 1 });

      const coldCallback = vi.fn();
      await expect(
        MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID }),
      ).rejects.toMatchObject({ code: "MUTATION_JOURNAL_ROOT_CHANGED" });
      expect(coldCallback).not.toHaveBeenCalled();
      expect(effects).toBe(1);
    },
  );

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "anchors entry I/O and rejects a replaced internal directory on cold open",
    async () => {
      const directory = path.join(await temporaryDirectory(), "journal");
      const originalEntries = path.join(
        path.dirname(directory),
        "entries-original",
      );
      const journal = await MutationJournal.open({
        directory,
        apiUrl: API_URL,
        appId: APP_ID,
      });
      await journal.run(
        {
          commandId: "opencloud app restart",
          safeScope: { appId: APP_ID },
          safeRequest: { action: "restart" },
        },
        async (run) => {
          await run.markAttempted();
          await rename(path.join(directory, "entries"), originalEntries);
          await mkdir(path.join(directory, "entries"), { mode: 0o700 });
          await run.complete();
        },
      );
      const [entry] = await readdir(originalEntries);
      expect(
        JSON.parse(
          await readFile(path.join(originalEntries, String(entry)), "utf8"),
        ),
      ).toMatchObject({ state: "completed" });
      expect(await readdir(path.join(directory, "entries"))).toEqual([]);
      await expect(
        MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID }),
      ).rejects.toMatchObject({ code: "MUTATION_JOURNAL_ROOT_CHANGED" });
    },
  );

  it("rejects a replaced lock directory from its cold identity witness", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    await MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID });
    await rename(
      path.join(directory, "locks"),
      path.join(path.dirname(directory), "locks-old"),
    );
    await mkdir(path.join(directory, "locks"), { mode: 0o700 });
    await expect(
      MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID }),
    ).rejects.toMatchObject({ code: "MUTATION_JOURNAL_ROOT_CHANGED" });
  });

  it("revalidates the immutable binding before every run", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const journal = await MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
    });
    const bindingFile = path.join(directory, "binding.json");
    const binding = JSON.parse(await readFile(bindingFile, "utf8"));
    await writeFile(
      bindingFile,
      `${JSON.stringify({
        ...binding,
        apiBaseSha256: "a".repeat(64),
        appId: OTHER_APP_ID,
      })}\n`,
      { mode: 0o600 },
    );
    const callback = vi.fn();
    await expect(
      journal.run(
        {
          commandId: "opencloud app restart",
          safeScope: { appId: APP_ID },
          safeRequest: { action: "restart" },
        },
        callback,
      ),
    ).rejects.toMatchObject({ code: "MUTATION_JOURNAL_BINDING_MISMATCH" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not recreate a missing binding behind an existing witness", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    await MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID });
    await rm(path.join(directory, "binding.json"));

    await expect(
      MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID }),
    ).rejects.toMatchObject({ code: "MUTATION_JOURNAL_BINDING_MISMATCH" });
  });

  it.runIf(process.platform === "linux")(
    "rejects a strict runtime journal that is not a dedicated mountpoint",
    async () => {
      const directory = path.join(await temporaryDirectory(), "journal");
      await mkdir(directory, { mode: 0o700 });
      await expect(
        MutationJournal.open({
          directory,
          apiUrl: API_URL,
          appId: APP_ID,
          rejectParentSymlinks: true,
          requireMountPoint: true,
        }),
      ).rejects.toMatchObject({ code: "UNSAFE_MUTATION_JOURNAL_PATH" });
    },
  );

  it("rejects filesystem roots and populated non-journal directories without chmod", async () => {
    const filesystemRoot = path.parse(path.resolve(await temporaryDirectory())).root;
    const rootMode = (await stat(filesystemRoot)).mode;
    await expect(
      MutationJournal.open({
        directory: filesystemRoot,
        apiUrl: API_URL,
        appId: APP_ID,
        rejectParentSymlinks: true,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_MUTATION_JOURNAL_PATH" });
    expect((await stat(filesystemRoot)).mode).toBe(rootMode);

    const broad = path.join(await temporaryDirectory(), "existing-workspace");
    await mkdir(broad, { mode: 0o700 });
    await writeFile(path.join(broad, "user-source.txt"), "preserve me", {
      mode: 0o600,
    });
    await expect(
      MutationJournal.open({ directory: broad, apiUrl: API_URL, appId: APP_ID }),
    ).rejects.toMatchObject({ code: "UNSAFE_MUTATION_JOURNAL_PATH" });
    expect(await readFile(path.join(broad, "user-source.txt"), "utf8")).toBe(
      "preserve me",
    );
    if (process.platform !== "win32") {
      expect((await stat(broad)).mode & 0o777).toBe(0o700);
    }
  });

  it("cleans a validated orphan binding temp during cold resume", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    await mkdir(directory, { mode: 0o700 });
    const orphan = path.join(
      directory,
      ".binding.json.1234.33333333-3333-4333-8333-333333333333.tmp",
    );
    await writeFile(orphan, "partial binding", { mode: 0o600 });

    await expect(
      MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID }),
    ).resolves.toBeInstanceOf(MutationJournal);
    await expect(readFile(orphan, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      JSON.parse(await readFile(path.join(directory, "binding.json"), "utf8")),
    ).toMatchObject({ appId: APP_ID });
  });

  it("cleans a validated orphan identity temp during cold resume", async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, "journal");
    await MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID });
    const orphan = path.join(
      root,
      "..journal.mutation-journal-identity.json.1234.33333333-3333-4333-8333-333333333333.tmp",
    );
    await writeFile(orphan, "partial witness", { mode: 0o600 });

    await expect(
      MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID }),
    ).resolves.toBeInstanceOf(MutationJournal);
    await expect(readFile(orphan, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects unsafe existing journal file modes without repairing them",
    async () => {
      const directory = path.join(await temporaryDirectory(), "journal");
      await MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID });
      const binding = path.join(directory, "binding.json");
      await chmod(binding, 0o644);
      await expect(
        MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID }),
      ).rejects.toMatchObject({ code: "UNSAFE_MUTATION_JOURNAL_PATH" });
      expect((await stat(binding)).mode & 0o777).toBe(0o644);
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses a symlink substituted for an existing journal file",
    async () => {
      const root = await temporaryDirectory();
      const directory = path.join(root, "journal");
      await MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID });
      const binding = path.join(directory, "binding.json");
      const target = path.join(root, "foreign.json");
      await writeFile(target, "{}\n", { mode: 0o600 });
      await rm(binding);
      await symlink(target, binding);
      await expect(
        MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID }),
      ).rejects.toMatchObject({ code: "UNSAFE_MUTATION_JOURNAL_PATH" });
      expect(await readFile(target, "utf8")).toBe("{}\n");
    },
  );

  it("distinguishes API base paths that share an origin", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    await MutationJournal.open({
      directory,
      apiUrl: `${API_URL}/control-a`,
      appId: APP_ID,
    });
    await expect(
      MutationJournal.open({
        directory,
        apiUrl: `${API_URL}/control-b`,
        appId: APP_ID,
      }),
    ).rejects.toMatchObject({ code: "MUTATION_JOURNAL_BINDING_MISMATCH" });
  });

  it("reuses the stable key and checkpoint after an interrupted operation", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const journal = await MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
    });
    let firstKey = "";
    await expect(
      journal.run(
        {
          commandId: "opencloud app restart",
          safeScope: { appId: APP_ID },
          safeRequest: { action: "restart" },
        },
        async (run) => {
          firstKey = run.idempotencyKey;
          await run.markAttempted();
          await run.checkpointOperation(
            "33333333-3333-4333-8333-333333333333",
          );
          throw new Error("simulated process loss");
        },
      ),
    ).rejects.toThrow("simulated process loss");

    await journal.run(
      {
        commandId: "opencloud app restart",
        safeScope: { appId: APP_ID },
        safeRequest: { action: "restart" },
      },
      async (run) => {
        expect(run.recovered).toBe(true);
        expect(run.idempotencyKey).toBe(firstKey);
        expect(run.operationId).toBe(
          "33333333-3333-4333-8333-333333333333",
        );
        await run.complete();
      },
    );
  });

  it("atomically retains primary and secondary operation coordinates", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const journal = await MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
    });
    await expect(
      journal.run(
        {
          commandId: "opencloud app verify",
          safeScope: { appId: APP_ID },
          safeRequest: { action: "verify" },
        },
        async (run) => {
          await run.markAttempted();
          await run.checkpointStage({
            stage: "verification",
            operationId: "55555555-5555-4555-8555-555555555555",
            verificationId: "66666666-6666-4666-8666-666666666666",
          });
          throw new Error("fault after atomic checkpoint");
        },
      ),
    ).rejects.toThrow("fault after atomic checkpoint");
    await journal.run(
      {
        commandId: "opencloud app verify",
        safeScope: { appId: APP_ID },
        safeRequest: { action: "verify" },
      },
      async (run) => {
        expect(run.operationId).toBe(
          "55555555-5555-4555-8555-555555555555",
        );
        expect(run.checkpoint?.verificationId).toBe(
          "66666666-6666-4666-8666-666666666666",
        );
      },
    );
  });

  it("lets a stopped promotion retire before a changed generated intent proceeds", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const journal = await MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
    });
    const first = {
      commandId: "opencloud app dev promote" as const,
      safeScope: { appId: APP_ID },
      safeRequest: { artifactSha256: "a".repeat(64) },
      retireDevStoppedWorkflow: true,
    };
    await expect(
      journal.run(first, async (run) => {
        await run.checkpointStage({
          stage: "dev_stopped",
          artifactSha256: "a".repeat(64),
          sessionId: "77777777-7777-4777-8777-777777777777",
          devStopped: true,
        });
        throw new Error("lost after remote cleanup");
      }),
    ).rejects.toThrow("lost after remote cleanup");

    const changed = {
      ...first,
      safeRequest: { artifactSha256: "b".repeat(64) },
    };
    await expect(
      journal.run(changed, async (run) => {
        expect(run.checkpoint?.devStopped).toBe(true);
        await run.complete();
        return "retired";
      }),
    ).resolves.toBe("retired");
    await expect(
      journal.run(changed, async (run) => {
        expect(run.checkpoint).toBeNull();
        return "new intent";
      }),
    ).resolves.toBe("new intent");
  });

  it("serializes concurrent subprocess scopes and exposes the completed result", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const journal = await MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
    });
    const spec = {
      commandId: "opencloud secret set" as const,
      safeScope: { appId: APP_ID, name: "DATABASE_KEY" },
      safeRequest: { action: "set" },
    };
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstKey = "";
    const first = journal.run(spec, async (run) => {
      firstKey = run.idempotencyKey;
      await run.markAttempted();
      await gate;
      await run.complete();
      return "first";
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = journal.run(spec, async (run) => {
      expect(run.completed).toBe(true);
      expect(run.idempotencyKey).toBe(firstKey);
      return "replayed";
    });
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "replayed",
    ]);
  });

  it("fails closed once an unrecoverable outcome is marked unknown", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const journal = await MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
    });
    const spec = {
      commandId: "opencloud secret rotate" as const,
      safeScope: { appId: APP_ID, name: "GENERATED" },
      safeRequest: { bytes: 32, encoding: "base64url" },
    };
    await expect(
      journal.run(spec, async (run) => {
        await run.markAttempted();
        return run.markUnknown();
      }),
    ).rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
    await expect(
      journal.run(spec, async (run) => run.failIfUnknown()),
    ).rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
  });

  it("does not reuse an explicit key for a changed completed descriptor", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const journal = await MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
    });
    const explicitIdempotencyKey = "explicit-stable-key-1";
    await journal.run(
      {
        commandId: "opencloud app configure",
        safeScope: { appId: APP_ID },
        safeRequest: { action: "configure" },
        explicitIdempotencyKey,
      },
      async (run) => {
        await run.markAttempted();
        await run.checkpointOperation(
          "44444444-4444-4444-8444-444444444444",
        );
        await run.complete();
      },
    );

    await expect(
      journal.run(
        {
          commandId: "opencloud app configure",
          safeScope: { appId: APP_ID, changed: true },
          safeRequest: { action: "configure-another-target" },
          explicitIdempotencyKey,
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "MUTATION_IN_PROGRESS" });
    const [entry] = await readdir(path.join(directory, "entries"));
    expect(
      JSON.parse(
        await readFile(path.join(directory, "entries", String(entry)), "utf8"),
      ),
    ).toMatchObject({
      idempotencyKey: explicitIdempotencyKey,
      operationId: "44444444-4444-4444-8444-444444444444",
      state: "completed",
    });
  });

  it("rejects a foreign runtime root before replaying an unresolved mutation", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const rootA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const rootB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const family = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const spec = {
      commandId: "opencloud app restart" as const,
      safeScope: { appId: APP_ID },
      safeRequest: { action: "restart" },
    };
    const first = await MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
      authority: { rootRunId: rootA, familyId: family },
    });
    await expect(
      first.run(spec, async (run) => {
        await run.markAttempted();
        throw new Error("simulated process loss");
      }),
    ).rejects.toThrow("simulated process loss");

    const foreignCallback = vi.fn();
    const foreign = await MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
      authority: { rootRunId: rootB, familyId: family },
    });
    await expect(foreign.run(spec, foreignCallback)).rejects.toMatchObject({
      code: "MUTATION_JOURNAL_AUTHORITY_MISMATCH",
    });
    expect(foreignCallback).not.toHaveBeenCalled();

    const rotatedCredential = await MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
      authority: { rootRunId: rootA, familyId: family },
    });
    await expect(
      rotatedCredential.run(spec, async (run) => {
        expect(run.recovered).toBe(true);
        await run.complete();
        return "recovered";
      }),
    ).resolves.toBe("recovered");
  });

  it("writes only protected regular files and no secret-derived data", async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, "journal");
    const absoluteSourcePath = path.join(root, "private", "source.json");
    const journal = await MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
    });
    const secret = "low-entropy-secret-canary";
    await journal.run(
      {
        commandId: "opencloud secret set",
        safeScope: { appId: APP_ID, name: "API_KEY" },
        // Deliberately constant: stdin bytes, their size, and their digest are excluded.
        safeRequest: { action: "set-from-stdin" },
      },
      async (run) => {
        await run.markAttempted();
        await run.complete();
      },
    );
    const files: string[] = [];
    const collect = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const resolved = path.join(current, entry.name);
        if (entry.isDirectory()) await collect(resolved);
        else if (entry.isFile()) files.push(resolved);
      }
    };
    await collect(directory);
    for (const entry of await readdir(root)) {
      if (entry.startsWith(".journal.mutation-journal-identity")) {
        files.push(path.join(root, entry));
      }
    }
    const retained = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(retained).not.toContain(secret);
    expect(retained).not.toContain("secret-canary");
    expect(retained).not.toContain(API_URL);
    expect(retained).not.toContain(absoluteSourcePath);
    expect(retained).not.toContain("Bearer ");
    expect(retained).not.toContain('"body"');
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const file of files) {
        expect((await stat(file)).mode & 0o777).toBe(0o600);
      }
    }
  });

  it("rejects corrupt entries and symlink journal paths", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "target");
    const linked = path.join(root, "linked");
    await mkdir(target);
    await symlink(target, linked, "dir");
    await expect(
      MutationJournal.open({
        directory: linked,
        apiUrl: API_URL,
        appId: APP_ID,
      }),
    ).rejects.toBeInstanceOf(MutationJournalError);

    const directory = path.join(root, "journal");
    const journal = await MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
    });
    await journal.run(
      {
        commandId: "opencloud app archive",
        safeScope: { appId: APP_ID },
        safeRequest: {},
      },
      async (run) => run.markAttempted(),
    );
    const [entry] = await readdir(path.join(directory, "entries"));
    await writeFile(path.join(directory, "entries", String(entry)), "not-json");
    await expect(
      journal.run(
        {
          commandId: "opencloud app archive",
          safeScope: { appId: APP_ID },
          safeRequest: {},
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "CORRUPT_MUTATION_JOURNAL" });
  });

  it("rejects a symlinked parent of an explicit runtime journal", async () => {
    const root = await temporaryDirectory();
    const redirected = path.join(root, "redirected");
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(redirected, "agent-mutations"), { recursive: true });
    await mkdir(workspace);
    await symlink(redirected, path.join(workspace, ".opencloud"), "dir");
    await expect(
      MutationJournal.open({
        directory: path.join(
          workspace,
          ".opencloud",
          "agent-mutations",
        ),
        apiUrl: API_URL,
        appId: APP_ID,
        rejectParentSymlinks: true,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_MUTATION_JOURNAL_PATH" });
  });
});
