import { closeSync, constants as fsConstants, openSync } from "node:fs";
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
  type SafeMutationCheckpoint,
  type SafeValidationCheckpoint,
  anchorsDirectoryDescriptors,
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

  it.runIf(anchorsDirectoryDescriptors())(
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

  it.runIf(anchorsDirectoryDescriptors())(
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

  it("anchors directory descriptors only on Linux", () => {
    expect(anchorsDirectoryDescriptors("linux")).toBe(true);
    for (const platform of ["darwin", "win32", "freebsd"] as const) {
      expect(anchorsDirectoryDescriptors(platform)).toBe(false);
    }
  });

  it.runIf(process.platform === "darwin")(
    "cannot reach a directory or its files through /dev/fd on macOS",
    async () => {
      const directory = await temporaryDirectory();
      await writeFile(path.join(directory, "entry"), "", { mode: 0o600 });
      const handle = openSync(
        directory,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
      );
      try {
        expect(() =>
          openSync(
            `/dev/fd/${handle}`,
            fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
          ),
        ).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
        // The file exists, but /dev/fd does not look inside the directory.
        closeSync(openSync(path.join(directory, "entry"), fsConstants.O_RDONLY));
        expect(() =>
          openSync(`/dev/fd/${handle}/entry`, fsConstants.O_RDONLY),
        ).toThrow(
          expect.objectContaining({
            code: expect.stringMatching(/^(?:ENOENT|ENOTDIR)$/),
          }),
        );
      } finally {
        closeSync(handle);
      }
    },
  );

  it("re-checks directories by path where descriptors cannot anchor them", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    try {
      const root = await temporaryDirectory();
      const directory = path.join(root, "journal");
      const journal = await MutationJournal.open({
        directory,
        apiUrl: API_URL,
        appId: APP_ID,
      });
      const restart = {
        commandId: "opencloud app restart" as const,
        safeScope: { appId: APP_ID },
        safeRequest: { action: "restart" },
      };
      await journal.run(restart, async (run) => {
        await run.markAttempted();
        await run.complete();
      });
      const [entry] = await readdir(path.join(directory, "entries"));
      expect(
        JSON.parse(
          await readFile(
            path.join(directory, "entries", String(entry)),
            "utf8",
          ),
        ),
      ).toMatchObject({ state: "completed", attemptCount: 1 });

      // With no descriptor to write through, a root swapped mid-run fails the
      // run instead of completing it, and a cold open refuses the replacement.
      let effects = 0;
      await expect(
        journal.run(
          { ...restart, safeRequest: { action: "restart-again" } },
          async (run) => {
            await run.markAttempted();
            await rename(directory, path.join(root, "journal-original"));
            await mkdir(directory, { mode: 0o700 });
            effects += 1;
            await run.complete();
          },
        ),
      ).rejects.toMatchObject({ code: "MUTATION_JOURNAL_ROOT_CHANGED" });
      expect(effects).toBe(1);
      await expect(
        MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID }),
      ).rejects.toMatchObject({ code: "MUTATION_JOURNAL_ROOT_CHANGED" });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

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

  it("treats a legacy schema-2 identity witness as already ready", async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, "journal");
    const witnessFile = path.join(
      root,
      ".journal.mutation-journal-identity.json",
    );
    await MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID });
    const legacyWitness = JSON.parse(await readFile(witnessFile, "utf8"));
    legacyWitness.schemaVersion = 2;
    delete legacyWitness.state;
    await writeFile(witnessFile, `${JSON.stringify(legacyWitness)}\n`, {
      mode: 0o600,
    });

    await expect(
      MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID }),
    ).resolves.toBeInstanceOf(MutationJournal);
    await rm(path.join(directory, "binding.json"));
    await expect(
      MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID }),
    ).rejects.toMatchObject({ code: "MUTATION_JOURNAL_BINDING_MISMATCH" });
  });

  it("cold-resumes one initializing identity across durable crash prefixes", async () => {
    for (const crashAt of [
      "identity_durable",
      "binding_durable",
      "ready_durable",
    ] as const) {
      const root = await temporaryDirectory();
      const directory = path.join(root, "journal");
      const witnessFile = path.join(
        root,
        ".journal.mutation-journal-identity.json",
      );
      await expect(
        MutationJournal.open({
          directory,
          apiUrl: API_URL,
          appId: APP_ID,
          onInitializationCheckpoint(checkpoint) {
            if (checkpoint === crashAt) {
              throw new Error(`fault after ${checkpoint}`);
            }
          },
        }),
      ).rejects.toThrow(`fault after ${crashAt}`);

      const initializingWitness = JSON.parse(
        await readFile(witnessFile, "utf8"),
      );
      expect(initializingWitness).toMatchObject({
        schemaVersion: 3,
        state: crashAt === "ready_durable" ? "ready" : "initializing",
        appId: APP_ID,
      });
      if (crashAt === "identity_durable") {
        await expect(
          readFile(path.join(directory, "binding.json"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(
          JSON.parse(
            await readFile(path.join(directory, "binding.json"), "utf8"),
          ),
        ).toMatchObject({ journalId: initializingWitness.journalId });
      }

      await expect(
        MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID }),
      ).resolves.toBeInstanceOf(MutationJournal);
      const readyWitness = JSON.parse(await readFile(witnessFile, "utf8"));
      const binding = JSON.parse(
        await readFile(path.join(directory, "binding.json"), "utf8"),
      );
      expect(readyWitness).toMatchObject({
        schemaVersion: 3,
        state: "ready",
        journalId: initializingWitness.journalId,
      });
      expect(binding).toMatchObject({
        journalId: initializingWitness.journalId,
        appId: APP_ID,
      });
      expect(await readdir(path.join(directory, "entries"))).toEqual([]);
    }
  });

  it("serializes concurrent first opens onto one durable identity", async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, "journal");
    let releaseIdentity!: () => void;
    const identityGate = new Promise<void>((resolve) => {
      releaseIdentity = resolve;
    });
    let identityDurable!: () => void;
    const identityObserved = new Promise<void>((resolve) => {
      identityDurable = resolve;
    });
    let identityWrites = 0;
    const first = MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
      async onInitializationCheckpoint(checkpoint) {
        if (checkpoint !== "identity_durable") return;
        identityWrites += 1;
        identityDurable();
        await identityGate;
      },
    });
    await identityObserved;
    const second = MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
      onInitializationCheckpoint(checkpoint) {
        if (checkpoint === "identity_durable") identityWrites += 1;
      },
    });
    releaseIdentity();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    const witness = JSON.parse(
      await readFile(
        path.join(root, ".journal.mutation-journal-identity.json"),
        "utf8",
      ),
    );
    const binding = JSON.parse(
      await readFile(path.join(directory, "binding.json"), "utf8"),
    );
    expect(identityWrites).toBe(1);
    expect(witness).toMatchObject({
      schemaVersion: 3,
      state: "ready",
      journalId: binding.journalId,
    });
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

  it("digests private request content with its own random key, kept beside its entries", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const binding = { directory, apiUrl: API_URL, appId: APP_ID };
    const first = await MutationJournal.open(binding);
    const input = { input: { card: "4111 1111 1111 1111" } };
    // Made once, even by two commands at the same moment.
    const [one, two] = await Promise.all([first.keyedDigest(input), (await MutationJournal.open(binding)).keyedDigest(input)]);
    expect(one).toBe(two);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(await (await MutationJournal.open(binding)).keyedDigest(input)).toBe(one);
    expect(await first.keyedDigest({ input: { card: "4111 1111 1111 1112" } })).not.toBe(one);
    // Not the plain digest a guess could be tested against, and not another journal's.
    const { createHash } = await import("node:crypto");
    expect(one).not.toBe(createHash("sha256").update(JSON.stringify(input)).digest("hex"));
    const other = await MutationJournal.open({ ...binding, directory: path.join(await temporaryDirectory(), "journal") });
    expect(await other.keyedDigest(input)).not.toBe(one);
    const keyFile = path.join(directory, "digest-key.json");
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(keyFile, "utf8")).key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects corrupt digest-key.json with CORRUPT_MUTATION_JOURNAL and cleans orphan digest-key temps", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const binding = { directory, apiUrl: API_URL, appId: APP_ID };
    const first = await MutationJournal.open(binding);
    await first.keyedDigest({ hello: "world" });

    // Orphan temp file left behind by a crashed writer is cleaned on open and load.
    const orphanOnOpen = path.join(directory, `.digest-key.json.99999.11111111-1111-4111-8111-111111111111.tmp`);
    await writeFile(orphanOnOpen, "partial", { mode: 0o600 });
    const reopened = await MutationJournal.open(binding);
    expect(await readdir(directory)).not.toContain(path.basename(orphanOnOpen));

    const orphanOnLoad = path.join(directory, `.digest-key.json.99998.22222222-2222-4222-8222-222222222222.tmp`);
    await writeFile(orphanOnLoad, "partial", { mode: 0o600 });
    await reopened.keyedDigest({ hello: "world" });
    expect(await readdir(directory)).not.toContain(path.basename(orphanOnLoad));

    const keyFile = path.join(directory, "digest-key.json");
    for (const corrupt of [
      "not-json",
      "null",
      "[]",
      JSON.stringify({ schemaVersion: 2, key: "a".repeat(64) }),
      JSON.stringify({ schemaVersion: 1, key: "a".repeat(64), extra: true }),
      JSON.stringify({ schemaVersion: 1, key: "not-hex" }),
    ]) {
      await writeFile(keyFile, corrupt, { mode: 0o600 });
      const fresh = await MutationJournal.open(binding);
      await expect(fresh.keyedDigest({ hello: "world" }), corrupt).rejects.toMatchObject({
        code: "CORRUPT_MUTATION_JOURNAL",
      });
    }
  });

  it("keeps a validation dispatch whose reply never came, and lets only the same request send it again", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const binding = { directory, apiUrl: API_URL, appId: APP_ID };
    const intent = { commandId: "opencloud draft validate" as const, safeScope: { appId: APP_ID }, safeRequest: { action: "validate" } };
    const dispatched: SafeValidationCheckpoint = { state: "dispatched", draftId: OTHER_APP_ID, revision: 2,
      requestSha256: "a".repeat(64), deadline: new Date(Date.now() + 60_000).toISOString() };
    const first = await MutationJournal.open(binding);
    await expect(first.run(intent, async run => {
      await run.checkpointValidation(dispatched);
      throw new Error("process interrupted before response");
    })).rejects.toThrow("process interrupted before response");
    const reopened = await MutationJournal.open(binding);
    await reopened.run(intent, async run => {
      expect(run.checkpoint?.validation).toEqual(dispatched);
      // Validating that pinned revision again joins OpenCloud's run for it.
      expect(() => run.failIfUnknown()).not.toThrow();
      await run.checkpointStage({ stage: "draft_ready" });
      expect(run.checkpoint?.validation).toEqual(dispatched);
      await run.markAttempted();
      for (const other of [{ revision: 3 }, { requestSha256: "b".repeat(64) }, { draftId: APP_ID }]) {
        await expect(run.checkpointValidation({ ...dispatched, ...other })).rejects.toMatchObject({ code: "MUTATION_REPLAY_MISMATCH" });
      }
      // The same request, in a fresh window.
      const again = { ...dispatched, deadline: new Date(Date.now() + 90_000).toISOString() };
      await run.checkpointValidation(again);
      await run.checkpointValidation({ ...again, state: "result", validationId: APP_ID, passed: true, artifactSha256: "c".repeat(64) });
      await run.complete();
    });
  });

  it("retains acknowledged validation progress and result through workflow checkpoint changes", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const binding = { directory, apiUrl: API_URL, appId: APP_ID };
    const intent = { commandId: "opencloud deploy" as const, safeScope: { appId: APP_ID }, safeRequest: { action: "deploy" } };
    const coordinates = { draftId: OTHER_APP_ID, revision: 2, requestSha256: "b".repeat(64), deadline: new Date(Date.now() + 60_000).toISOString() };
    const progress: SafeValidationCheckpoint = { ...coordinates, state: "progress", retryNotBefore: new Date(Date.now() + 60_000).toISOString() };
    await (await MutationJournal.open(binding)).run(intent, async run => {
      await run.checkpointValidation({ ...coordinates, state: "dispatched" });
      await expect(run.checkpointValidation({ ...progress, revision: 3 })).rejects.toMatchObject({ code: "INVALID_MUTATION_CHECKPOINT" });
      await run.checkpointValidation(progress);
      await run.checkpointStage({ stage: "draft_ready", draftId: OTHER_APP_ID, revision: 2 });
    });
    await (await MutationJournal.open(binding)).run(intent, async run => {
      expect(run.checkpoint?.validation).toEqual(progress);
      // Not before OpenCloud's own wait is over.
      await expect(run.checkpointValidation({ ...coordinates, state: "dispatched" })).rejects.toMatchObject({ code: "MUTATION_REPLAY_MISMATCH" });
    });
    vi.useFakeTimers({ now: Date.parse(progress.retryNotBefore) + 1, toFake: ["Date"] });
    try {
      await (await MutationJournal.open(binding)).run(intent, async run => {
        const fresh = { ...coordinates, deadline: new Date(Date.now() + 90_000).toISOString() };
        await expect(run.checkpointValidation({ ...fresh, revision: 3, state: "dispatched" })).rejects.toMatchObject({ code: "MUTATION_REPLAY_MISMATCH" });
        await run.checkpointValidation({ ...fresh, state: "dispatched" });
        const result: SafeValidationCheckpoint = { ...fresh, state: "result", validationId: APP_ID, passed: true, artifactSha256: "c".repeat(64) };
        // A response belongs to the dispatch it answers, deadline included.
        await expect(run.checkpointValidation({ ...result, deadline: coordinates.deadline })).rejects.toMatchObject({ code: "INVALID_MUTATION_CHECKPOINT" });
        await run.checkpointValidation(result);
        await run.checkpointStage({ stage: "validated", draftId: OTHER_APP_ID, revision: 2 });
        expect(run.checkpoint?.validation).toEqual(result);
        await expect(run.checkpointValidation({ ...fresh, state: "dispatched", source: "must not be retained" } as SafeValidationCheckpoint))
          .rejects.toMatchObject({ code: "INVALID_MUTATION_CHECKPOINT" });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a validation wait so it holds nothing back, while the same request rejoins it", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const binding = { directory, apiUrl: API_URL, appId: APP_ID };
    const intent = (artifact: string) => ({ commandId: "opencloud deploy" as const, safeScope: { appId: APP_ID }, safeRequest: { action: "deploy", artifact } });
    const coordinates = { draftId: OTHER_APP_ID, revision: 2, requestSha256: "d".repeat(64), deadline: new Date(Date.now() + 60_000).toISOString() };
    const progress: SafeValidationCheckpoint = { ...coordinates, state: "progress", retryNotBefore: new Date(Date.now() - 1_000).toISOString() };
    let key = "";
    await (await MutationJournal.open(binding)).run(intent("first"), async run => {
      key = run.idempotencyKey;
      await run.checkpointStage({ stage: "draft_ready", draftId: OTHER_APP_ID, revision: 2 });
      await run.checkpointValidation({ ...coordinates, state: "dispatched" });
      await run.checkpointValidation(progress);
      const pending = await run.settleValidation("waiting");
      expect(pending).toMatchObject({ command: "opencloud deploy", idempotencyKey: key, state: "completed", draftId: OTHER_APP_ID, revision: 2 });
    });
    // The very same request, without a key, rejoins it.
    await (await MutationJournal.open(binding)).run(intent("first"), async run => {
      expect(run.idempotencyKey).toBe(key);
      expect(run.checkpoint).toMatchObject({ stage: "validation_waiting", draftId: OTHER_APP_ID, validation: progress });
      await run.checkpointValidation({ ...coordinates, state: "dispatched", deadline: new Date(Date.now() + 90_000).toISOString() });
      await run.settleValidation("waiting");
    });
    // A changed request is not held back: it starts afresh.
    await (await MutationJournal.open(binding)).run(intent("changed"), async run => {
      expect(run.idempotencyKey).not.toBe(key);
      expect(run.checkpoint).toBeNull();
      await run.checkpointStage({ stage: "draft_ready", draftId: APP_ID, revision: 1 });
      await run.checkpointValidation({ ...coordinates, draftId: APP_ID, revision: 1, state: "dispatched" });
      await run.checkpointValidation({ ...coordinates, draftId: APP_ID, revision: 1, state: "refused" });
      await run.settleValidation("refused");
    });
    // OpenCloud answered that one: even the same request starts afresh.
    await (await MutationJournal.open(binding)).run(intent("changed"), async run => {
      expect(run.checkpoint).toBeNull();
      await run.complete();
    });
  });

  it("resumes a validation an earlier candidate marked unknown, instead of refusing it", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const binding = { directory, apiUrl: API_URL, appId: APP_ID };
    const intent = { commandId: "opencloud draft validate" as const, safeScope: { appId: APP_ID }, safeRequest: { action: "validate" } };
    await expect((await MutationJournal.open(binding)).run(intent, async run => {
      await run.markAttempted();
      return run.markUnknown("DRAFT_VALIDATION_OUTCOME_UNKNOWN");
    })).rejects.toMatchObject({ code: "DRAFT_VALIDATION_OUTCOME_UNKNOWN" });
    await (await MutationJournal.open(binding)).run(intent, async run => {
      expect(() => run.failIfUnknown()).not.toThrow();
      await run.markAttempted();
      await run.complete();
    });
    await expect((await MutationJournal.open(binding)).run(intent, async run => {
      await run.markAttempted();
      return run.markUnknown("MUTATION_OUTCOME_UNKNOWN");
    })).rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
    await (await MutationJournal.open(binding)).run(intent, async run => {
      expect(() => run.failIfUnknown()).toThrowError(expect.objectContaining({ code: "MUTATION_OUTCOME_UNKNOWN" }));
    });
  });

  it("lets a different keyless request replace a deploy whose outcome is unknown, and only that kind of unknown", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const binding = { directory, apiUrl: API_URL, appId: APP_ID };
    const deploy = (artifactSha256: string) => ({ commandId: "opencloud deploy" as const, safeScope: { appId: APP_ID },
      safeRequest: { action: "deploy", artifactSha256 } });
    await expect((await MutationJournal.open(binding)).run(deploy("a".repeat(64)), async run => {
      await run.markAttempted();
      return run.markUnknown("DEPLOY_OUTCOME_UNKNOWN");
    })).rejects.toMatchObject({ code: "DEPLOY_OUTCOME_UNKNOWN", retryable: false });
    // The same request still meets its unknown outcome; nothing is sent again.
    await (await MutationJournal.open(binding)).run(deploy("a".repeat(64)), async run => {
      expect(() => run.failIfUnknown()).toThrowError(expect.objectContaining({ code: "DEPLOY_OUTCOME_UNKNOWN" }));
    });
    // Changed source, without a key, is a new request in its place.
    await (await MutationJournal.open(binding)).run(deploy("b".repeat(64)), async run => {
      expect(run.recovered).toBe(false);
      expect(run.attempted).toBe(false);
      expect(() => run.failIfUnknown()).not.toThrow();
      await run.markAttempted();
      await run.complete();
    });
    // Any other unknown outcome still holds a different request back.
    await expect((await MutationJournal.open(binding)).run(deploy("c".repeat(64)), async run => {
      await run.markAttempted();
      return run.markUnknown("MUTATION_OUTCOME_UNKNOWN");
    })).rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
    await expect((await MutationJournal.open(binding)).run(deploy("d".repeat(64)), async () => "sent"))
      .rejects.toMatchObject({ code: "MUTATION_IN_PROGRESS" });
    // So does this one for a request that names a key of its own.
    const keyed = { ...deploy("e".repeat(64)), explicitIdempotencyKey: "deploy-unknown-k1" };
    await expect((await MutationJournal.open(binding)).run(keyed, async run => {
      await run.markAttempted();
      return run.markUnknown("DEPLOY_OUTCOME_UNKNOWN");
    })).rejects.toMatchObject({ code: "DEPLOY_OUTCOME_UNKNOWN" });
    await expect((await MutationJournal.open(binding)).run({ ...keyed, safeRequest: { action: "deploy", artifactSha256: "f".repeat(64) } }, async () => "sent"))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
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

  it("retains exact development apply coordinates and uncertainty across reopening", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const binding = { directory, apiUrl: API_URL, appId: APP_ID };
    const intent = { commandId: "opencloud app dev start" as const, safeScope: { appId: APP_ID }, safeRequest: { action: "start" } };
    const checkpoint = { stage: "dev_apply_dispatched", artifactSha256: "a".repeat(64), serverArtifactSha256: "b".repeat(64),
      draftId: OTHER_APP_ID, sessionId: "33333333-3333-4333-8333-333333333333", revision: 2,
      baseDeploymentId: null, devApplyDeadline: "2026-11-14T12:15:00.000Z" };
    const first = await MutationJournal.open(binding);
    await expect(first.run(intent, async run => {
      await run.checkpointStage(checkpoint);
      await run.markAttempted();
      return run.markUnknown("DEV_APPLY_OUTCOME_UNKNOWN");
    })).rejects.toMatchObject({ code: "DEV_APPLY_OUTCOME_UNKNOWN" });
    const reopened = await MutationJournal.open(binding);
    await reopened.run(intent, async run => {
      expect(run.recovered).toBe(true);
      expect(run.checkpoint).toEqual(checkpoint);
      expect(run.unknownCode).toBe("DEV_APPLY_OUTCOME_UNKNOWN");
      expect(() => run.failIfUnknown()).toThrowError(expect.objectContaining({ code: "DEV_APPLY_OUTCOME_UNKNOWN" }));
      for (const invalid of [
        { ...checkpoint, serverArtifactSha256: "secret" },
        { ...checkpoint, baseDeploymentId: "arbitrary-text" },
        { ...checkpoint, devApplyDeadline: "tomorrow" },
        { ...checkpoint, devApplyDeadline: 123 },
      ]) {
        await expect(run.checkpointStage(invalid as SafeMutationCheckpoint)).rejects.toMatchObject({ code: "INVALID_MUTATION_CHECKPOINT" });
      }
      expect(run.checkpoint).toEqual(checkpoint);
    });
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
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let firstKey = "";
    const first = journal.run(spec, async (run) => {
      firstKey = run.idempotencyKey;
      await run.markAttempted();
      firstEntered();
      await gate;
      await run.complete();
      return "first";
    });
    await entered;
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

  it("names the unresolved request that holds a target, with its key, state and coordinates", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const journal = await MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID });
    const intent = { commandId: "opencloud app dev start" as const, safeScope: { appId: APP_ID }, safeRequest: { artifactSha256: "a".repeat(64) } };
    const sessionId = "33333333-3333-4333-8333-333333333333";
    let pendingKey = "";
    await expect(journal.run(intent, async (run) => {
      pendingKey = run.idempotencyKey;
      await run.checkpointStage({ stage: "dev_session_created", draftId: OTHER_APP_ID, sessionId, revision: 3 });
      await run.markAttempted();
      throw new Error("interrupted");
    })).rejects.toThrow("interrupted");
    expect(pendingKey).toMatch(/^ocj1:/);
    const edited = { ...intent, safeRequest: { artifactSha256: "b".repeat(64) } };
    const conflict = await journal.run(edited, async () => undefined).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(MutationJournalError);
    expect(conflict).toMatchObject({
      code: "MUTATION_IN_PROGRESS",
      retryable: true,
      message: `An earlier \`opencloud app dev start\` request with idempotency key ${pendingKey} has not finished (state attempted), and this request differs from it. No request was started.`,
      pending: {
        command: "opencloud app dev start", idempotencyKey: pendingKey, generatedKey: true, state: "attempted",
        appId: APP_ID, draftId: OTHER_APP_ID, revision: 3, sessionId,
      },
    });
    // Its own key, given back, resumes that entry instead of starting another.
    await journal.run({ ...intent, explicitIdempotencyKey: pendingKey }, async (run) => {
      expect(run.recovered).toBe(true);
      expect(run.idempotencyKey).toBe(pendingKey);
      expect(run.checkpoint).toMatchObject({ stage: "dev_session_created", sessionId });
      await run.complete();
    });
    expect(await readdir(path.join(directory, "entries"))).toHaveLength(1);
    // A different request under that key is still refused, naming the entry.
    await journal.run(intent, async (run) => {
      await run.markAttempted();
      pendingKey = run.idempotencyKey;
      return run.markUnknown("DEV_APPLY_OUTCOME_UNKNOWN");
    }).catch((error: unknown) => expect(error).toMatchObject({
      code: "DEV_APPLY_OUTCOME_UNKNOWN", pending: { idempotencyKey: pendingKey, state: "unknown", unknownCode: "DEV_APPLY_OUTCOME_UNKNOWN" },
    }));
    // Given explicitly, that key names a request that differs from this one: a
    // reused key, which waiting never clears.
    await expect(journal.run({ ...edited, explicitIdempotencyKey: pendingKey }, async () => undefined)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      retryable: false,
      message: `Idempotency key ${pendingKey} belongs to an earlier \`opencloud app dev start\` request that may have taken effect (DEV_APPLY_OUTCOME_UNKNOWN). No request was started.`,
      pending: { state: "unknown" },
    });
    // Without a key, the same request waits for the unresolved one instead.
    await expect(journal.run(edited, async () => undefined)).rejects.toMatchObject({
      code: "MUTATION_IN_PROGRESS",
      retryable: true,
      message: `An earlier \`opencloud app dev start\` request with idempotency key ${pendingKey} may have taken effect (DEV_APPLY_OUTCOME_UNKNOWN), and this request differs from it. No request was started.`,
    });
    expect(await readdir(path.join(directory, "entries"))).toHaveLength(1);
  });

  it("refuses an explicit key whose unfinished request differs, as a reused key", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const journal = await MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID });
    const explicitIdempotencyKey = "summary-request-1";
    const intent = { commandId: "opencloud containers run" as const, safeScope: { appId: APP_ID, name: "summarise" },
      safeRequest: { requestSha256: "a".repeat(64) }, explicitIdempotencyKey };
    await expect(journal.run(intent, async (run) => {
      await run.markAttempted();
      throw new Error("reply lost");
    })).rejects.toThrow("reply lost");
    for (const changed of [
      { ...intent, safeRequest: { requestSha256: "b".repeat(64) } },
      { ...intent, commandId: "opencloud containers cancel" as const },
    ]) {
      await expect(journal.run(changed, async () => undefined)).rejects.toMatchObject({
        code: "IDEMPOTENCY_KEY_REUSED",
        retryable: false,
        message: "Idempotency key summary-request-1 belongs to an earlier `opencloud containers run` request that has not finished (state attempted). No request was started.",
        pending: { command: "opencloud containers run", idempotencyKey: explicitIdempotencyKey, generatedKey: false, state: "attempted" },
      });
    }
    // The same request with that key still resumes it.
    await journal.run(intent, async (run) => {
      expect(run.recovered).toBe(true);
      await run.complete();
    });
  });

  it("keeps an explicit key that is not the pending entry's own on its own entry", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const journal = await MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID });
    const intent = { commandId: "opencloud app dev start" as const, safeScope: { appId: APP_ID }, safeRequest: { action: "start" } };
    await expect(journal.run(intent, async (run) => {
      await run.markAttempted();
      throw new Error("interrupted");
    })).rejects.toThrow("interrupted");
    const unrelated = "ocj1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await journal.run({ ...intent, explicitIdempotencyKey: unrelated }, async (run) => {
      expect(run.recovered).toBe(false);
      expect(run.idempotencyKey).toBe(unrelated);
    });
    expect(await readdir(path.join(directory, "entries"))).toHaveLength(2);
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
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      retryable: false,
      message: "Idempotency key explicit-stable-key-1 was already used for a different `opencloud app configure` request, which finished. No request was started.",
      pending: { idempotencyKey: explicitIdempotencyKey, generatedKey: false, state: "completed", operationId: "44444444-4444-4444-8444-444444444444" },
    });
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

  it("takes ordinary keys that only contain a credential prefix's letters, and says why it refuses one that looks like a credential", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const journal = await MutationJournal.open({ directory, apiUrl: API_URL, appId: APP_ID });
    const intent = (explicitIdempotencyKey: string) => ({
      commandId: "opencloud app configure" as const,
      safeScope: { appId: APP_ID },
      safeRequest: { action: "configure", key: explicitIdempotencyKey },
      explicitIdempotencyKey,
    });
    // S5: "desk-deploy-001" and "task-abcdefghij" hold "sk-" and ten more
    // characters, which is not an API key's shape.
    for (const key of [
      "s5-otherdesk-deploy-001",
      "s5-task-abcdefghij",
      "OC_FOO-deploy-0001",
      "OC_APP_TOKEN_0123456789abcdef",
      "OC_OAUTH_ACCESS_TOKEN_0123456789",
      "release-sk-2026-11-20-final",
    ]) {
      await expect(journal.run(intent(key), async () => "sent"), key).resolves.toBe("sent");
    }
    // Built from parts, so no complete synthetic secret sits in the source.
    const synthetic = "Synthetic0123456789".repeat(3);
    const openCloudAccessKind =
      "an OpenCloud access token (oc_app_…, oc_agent_…, oc_oauth_…, oc_provisional_…, oc_cli_…, oc_platform_cli_…, or oc_run_…)";
    const openCloudSignInKind = "an OpenCloud refresh token or device code (oc_refresh_… or oc_device_…)";
    for (const [key, kind] of [
      [`s${"k-"}proj-${synthetic}`, "an API secret key (sk-…)"],
      [`deploy:s${"k-"}${synthetic}`, "an API secret key (sk-…)"],
      [`oc_${"owner_"}synthetic-key`, "an OpenCloud app-owner credential (oc_owner_…)"],
      [`oc_${"app_"}${synthetic}`, openCloudAccessKind],
      [`oc_${"agent_"}${synthetic}`, openCloudAccessKind],
      [`oc_${"oauth_"}${synthetic}`, openCloudAccessKind],
      [`oc_${"provisional_"}${synthetic}`, openCloudAccessKind],
      [`oc_${"cli_"}${synthetic}`, openCloudAccessKind],
      [`retry:oc_${"cli_"}${synthetic}`, openCloudAccessKind],
      [`oc_${"platform_cli_"}${synthetic}`, openCloudAccessKind],
      [`oc_${"run_"}${synthetic}`, openCloudAccessKind],
      [`oc_${"refresh_"}${synthetic}`, openCloudSignInKind],
      [`oc_${"device_"}${synthetic}`, openCloudSignInKind],
      [`s${"k_"}live_${synthetic}`, "a Stripe secret key"],
      [`gh${"p_"}${"A1".repeat(18)}`, "a GitHub token"],
      [`ey${"J"}hbGciOiJub25lIn0.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJl`, "a JSON Web Token"],
    ] as const) {
      const refused = journal.run(intent(key), async () => "sent");
      await expect(refused, key).rejects.toMatchObject({
        code: "INVALID_IDEMPOTENCY_KEY",
        message: `This idempotency key looks like ${kind}; don't put credentials in idempotency keys. Choose a key that names the change, such as deploy-2026-11-20-1.`,
      });
      expect(String((await refused.catch((error: unknown) => error) as Error).message)).not.toContain(key);
    }
    await expect(journal.run(intent("short"), async () => "sent")).rejects.toMatchObject({
      code: "INVALID_IDEMPOTENCY_KEY",
      message: "Idempotency keys must be 8 through 200 letters, numbers, dots, colons, underscores, or dashes",
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
      explicitIdempotencyKey: "restart-after-runtime-loss",
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

  it("requires an explicit idempotency key before an app-owner Agent mutation", async () => {
    const directory = path.join(await temporaryDirectory(), "journal");
    const callback = vi.fn();
    const journal = await MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
      authority: {
        rootRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        familyId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    });

    await expect(
      journal.run(
        {
          commandId: "opencloud app restart",
          safeScope: { appId: APP_ID },
          safeRequest: { action: "restart" },
        },
        callback,
      ),
    ).rejects.toMatchObject({
      code: "APP_OWNER_IDEMPOTENCY_KEY_REQUIRED",
      retryable: true,
    });
    expect(callback).not.toHaveBeenCalled();
    expect(await readdir(path.join(directory, "entries"))).toEqual([]);
    expect(await readdir(path.join(directory, "locks"))).toEqual([]);
  });

  it.each([
    "opencloud app dev integration mode",
    "opencloud app dev integration test-connection",
    "opencloud app dev integration inject",
  ] as const)(
    "requires and then reuses an explicit Agent key for %s",
    async (commandId) => {
      const directory = path.join(await temporaryDirectory(), "journal");
      const journal = await MutationJournal.open({
        directory,
        apiUrl: API_URL,
        appId: APP_ID,
        authority: {
          rootRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          familyId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        },
      });
      const spec = {
        commandId,
        safeScope: {
          appId: APP_ID,
          sessionId: "33333333-3333-4333-8333-333333333333",
          integrationName: "crm",
        },
        safeRequest: { action: commandId },
      };
      const callback = vi.fn();
      await expect(journal.run(spec, callback)).rejects.toMatchObject({
        code: "APP_OWNER_IDEMPOTENCY_KEY_REQUIRED",
      });
      expect(callback).not.toHaveBeenCalled();

      const keys: string[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await journal.run(
          { ...spec, explicitIdempotencyKey: "agent-integration-key" },
          async (run) => {
            keys.push(run.idempotencyKey);
            await run.markAttempted();
            await run.complete();
          },
        );
      }
      expect(keys).toEqual(["agent-integration-key", "agent-integration-key"]);
    },
  );

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

  it("flags baseDeploymentChanged when an unfinished deploy or app dev start key conflicts only on expectedActiveDeploymentId", async () => {
    const directory = path.join(await temporaryDirectory(), "base-changed");
    const journal = await MutationJournal.open({
      directory,
      apiUrl: API_URL,
      appId: APP_ID,
    });
    const base1 = "11111111-1111-4111-8111-1111111111a1";
    const base2 = "11111111-1111-4111-8111-1111111111a2";
    const artifactSha256 = "a".repeat(64);
    const otherArtifactSha256 = "b".repeat(64);

    // 1. Base moved from base1 -> base2 after an interrupted deploy with checkpoint updates.
    await expect(
      journal.run(
        {
          commandId: "opencloud deploy",
          safeScope: { appId: APP_ID },
          safeRequest: { action: "deploy", artifactSha256, expectedActiveDeploymentId: base1 },
          explicitIdempotencyKey: "deploy-base-move-1",
        },
        async (run) => {
          await run.checkpointStage({ stage: "draft_ready", artifactSha256, draftId: OTHER_APP_ID });
          throw new Error("simulated crash");
        },
      ),
    ).rejects.toThrow("simulated crash");

    await expect(
      journal.run(
        {
          commandId: "opencloud deploy",
          safeScope: { appId: APP_ID },
          safeRequest: { action: "deploy", artifactSha256, expectedActiveDeploymentId: base2 },
          explicitIdempotencyKey: "deploy-base-move-1",
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      pending: expect.objectContaining({
        command: "opencloud deploy",
        idempotencyKey: "deploy-base-move-1",
        baseDeploymentChanged: true,
      }),
    });

    // If the artifact ALSO changed, it is not solely a base-release change.
    await expect(
      journal.run(
        {
          commandId: "opencloud deploy",
          safeScope: { appId: APP_ID },
          safeRequest: { action: "deploy", artifactSha256: otherArtifactSha256, expectedActiveDeploymentId: base2 },
          explicitIdempotencyKey: "deploy-base-move-1",
        },
        async () => undefined,
      ),
    ).rejects.toSatisfy((error: MutationJournalError) =>
      error.code === "IDEMPOTENCY_KEY_REUSED" && error.pending?.baseDeploymentChanged !== true,
    );

    // 2. Base moved from absent (no .opencloud/base.json) -> base2 on app dev start.
    await expect(
      journal.run(
        {
          commandId: "opencloud app dev start",
          safeScope: { appId: APP_ID },
          safeRequest: { action: "dev-start", artifactSha256 },
          explicitIdempotencyKey: "dev-start-base-move-1",
        },
        async (run) => {
          await run.markAttempted();
          throw new Error("simulated crash");
        },
      ),
    ).rejects.toThrow("simulated crash");

    await expect(
      journal.run(
        {
          commandId: "opencloud app dev start",
          safeScope: { appId: APP_ID },
          safeRequest: { action: "dev-start", artifactSha256, expectedActiveDeploymentId: base2 },
          explicitIdempotencyKey: "dev-start-base-move-1",
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      pending: expect.objectContaining({
        command: "opencloud app dev start",
        idempotencyKey: "dev-start-base-move-1",
        baseDeploymentChanged: true,
      }),
    });

    // 3. A completed deploy does NOT set baseDeploymentChanged when re-run after advancing base.json.
    await journal.run(
      {
        commandId: "opencloud deploy",
        safeScope: { appId: APP_ID },
        safeRequest: { action: "deploy", artifactSha256, expectedActiveDeploymentId: base1 },
        explicitIdempotencyKey: "deploy-base-done-1",
      },
      async (run) => run.complete(),
    );
    await expect(
      journal.run(
        {
          commandId: "opencloud deploy",
          safeScope: { appId: APP_ID },
          safeRequest: { action: "deploy", artifactSha256, expectedActiveDeploymentId: base2 },
          explicitIdempotencyKey: "deploy-base-done-1",
        },
        async () => undefined,
      ),
    ).rejects.toSatisfy((error: MutationJournalError) =>
      error.code === "IDEMPOTENCY_KEY_REUSED" &&
      error.pending?.state === "completed" &&
      error.pending?.baseDeploymentChanged !== true,
    );
  });
});
