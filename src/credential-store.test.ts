import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialStore,
  type AccountCredential,
  type WorkspaceCredential,
} from "./credential-store.js";

const directories: string[] = [];
const noKeyring = async () => null;

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function account(): AccountCredential {
  return {
    schemaVersion: 1,
    kind: "account",
    apiUrl: "https://api.opencloud.ai",
    issuer: "https://auth.opencloud.ai",
    tokenEndpoint: "https://auth.opencloud.ai/oauth/token",
    revocationEndpoint: "https://auth.opencloud.ai/oauth/revoke",
    accessToken: "oc_cli_private-access",
    accessExpiresAt: "2026-08-08T12:15:00.000Z",
    refreshToken: "oc_refresh_private-refresh",
    refreshExpiresAt: "2026-09-07T12:00:00.000Z",
  };
}

describe("CredentialStore protected-file fallback", () => {
  it("uses a per-user mode-0600 file when no OS keyring is available", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencloud-auth-"));
    directories.push(directory);
    const store = new CredentialStore(directory, noKeyring);

    const saved = await store.saveAccount(account());

    expect(saved.backend).toBe("protected-file");
    expect(saved.location.startsWith(directory)).toBe(true);
    expect((await stat(saved.location)).mode & 0o777).toBe(0o600);
    expect(await store.loadAccount(account().apiUrl)).toEqual(saved);
    expect(await readFile(saved.location, "utf8")).toContain(
      "oc_refresh_private-refresh",
    );

    await store.deleteAccount(account().apiUrl);
    await expect(stat(saved.location)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stores workspace credentials under a different derived key per app", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencloud-auth-"));
    directories.push(directory);
    const store = new CredentialStore(directory, noKeyring);
    const first: WorkspaceCredential = {
      schemaVersion: 1,
      kind: "workspace",
      apiUrl: "https://api.opencloud.ai",
      appId: "248c0b0d-4a85-46de-af54-e3afb145dc2b",
      token: "oc_agent_first",
      expiresAt: "2026-08-09T00:00:00.000Z",
    };
    const second = {
      ...first,
      appId: "9fcde397-8d0a-4b6c-9f69-3a4ca1abb635",
      token: "oc_agent_second",
    };

    const firstSaved = await store.saveWorkspace(first);
    const secondSaved = await store.saveWorkspace(second);

    expect(firstSaved.location).not.toBe(secondSaved.location);
    expect((await store.loadWorkspace(first.apiUrl, first.appId))?.credential)
      .toEqual(first);
    expect((await store.loadWorkspace(second.apiUrl, second.appId))?.credential)
      .toEqual(second);
  });

  it("refuses to read a fallback credential with broad Unix permissions", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencloud-auth-"));
    directories.push(directory);
    const store = new CredentialStore(directory, noKeyring);
    const saved = await store.saveAccount(account());
    await chmod(saved.location, 0o644);

    await expect(store.loadAccount(account().apiUrl)).rejects.toThrow(
      "permissions are too broad",
    );
  });
});
