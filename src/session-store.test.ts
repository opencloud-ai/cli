import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSession,
  resolveSessionFile,
  saveSession,
  type ReadyAgentSession,
} from "./session-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("OpenCloud CLI session store", () => {
  it("stores app credentials in an ignored mode-0600 file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencloud-cli-"));
    directories.push(directory);
    const file = path.join(directory, ".opencloud", "session.json");
    const session: ReadyAgentSession = {
      schemaVersion: 1,
      state: "ready",
      apiUrl: "https://api.opencloud.ai",
      appId: "248c0b0d-4a85-46de-af54-e3afb145dc2b",
      appUrl: "https://family-tasks-a1b2c3.opencloud.ai",
      token: "oc_agent_secret",
      credentialExpiresAt: "2026-07-30T12:00:00.000Z",
    };

    await saveSession(file, session);

    expect(loadSession(file)).toEqual(session);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(
      await readFile(path.join(directory, ".opencloud", ".gitignore"), "utf8"),
    ).toBe("*\n!.gitignore\n");
  });

  it("persists the retry key before onboarding can return a credential", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencloud-cli-"));
    directories.push(directory);
    const file = path.join(directory, ".opencloud", "session.json");

    await saveSession(file, {
      schemaVersion: 1,
      state: "starting",
      apiUrl: "https://api.opencloud.ai",
      idempotencyKey: "b7e0066f-33cb-4f4a-9909-401e9c702f3e",
      email: "person@example.test",
      projectName: "Family tasks",
      visibility: "private",
    });

    expect(loadSession(file)).toMatchObject({
      state: "starting",
      idempotencyKey: "b7e0066f-33cb-4f4a-9909-401e9c702f3e",
    });
  });

  it("discovers the nearest session file from a nested app directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencloud-cli-"));
    directories.push(directory);
    const nested = path.join(directory, "apps", "frontend");
    await mkdir(nested, { recursive: true });
    const file = path.join(directory, ".opencloud", "session.json");
    await saveSession(file, {
      schemaVersion: 1,
      state: "ready",
      apiUrl: "https://api.opencloud.ai",
      appId: "248c0b0d-4a85-46de-af54-e3afb145dc2b",
      appUrl: "https://family-tasks-a1b2c3.opencloud.ai",
      token: "oc_agent_secret",
      credentialExpiresAt: "2026-07-30T12:00:00.000Z",
    });

    expect(resolveSessionFile(undefined, nested)).toBe(file);
  });
});
