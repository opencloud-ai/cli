import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialStore } from "./credential-store.js";
import {
  connectWorkspace,
  freshWorkspaceCredential,
} from "./workspace-auth.js";
import { loadWorkspaceBinding } from "./workspace-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("CLI workspace connection", () => {
  it("keeps app binding metadata in the workspace and its token outside it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencloud-workspace-"));
    directories.push(directory);
    const bindingFile = path.join(directory, "app", ".opencloud", "app.json");
    const store = new CredentialStore(
      path.join(directory, "user-config"),
      async () => null,
    );
    const request = vi.fn().mockResolvedValue(
      Response.json({
        app: {
          id: "248c0b0d-4a85-46de-af54-e3afb145dc2b",
          name: "Family tasks",
          appUrl: "https://family-tasks.opencloud.ai",
        },
        credential: {
          token: "oc_agent_private-workspace",
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
        },
      }),
    );

    const connected = await connectWorkspace(
      {
        store,
        bindingFile,
        apiUrl: "https://api.opencloud.ai",
        accessToken: "oc_cli_private-account",
        appId: "248c0b0d-4a85-46de-af54-e3afb145dc2b",
      },
      request as typeof fetch,
    );

    expect(loadWorkspaceBinding(bindingFile)).toEqual(connected.binding);
    expect(await readFile(bindingFile, "utf8")).not.toContain(
      "oc_agent_private-workspace",
    );
    expect(connected.stored.location.startsWith(directory)).toBe(true);
    expect((await stat(bindingFile)).mode & 0o777).toBe(0o600);
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization"))
      .toBe("Bearer oc_cli_private-account");

    const fresh = await freshWorkspaceCredential(
      { store, bindingFile },
      vi.fn() as unknown as typeof fetch,
    );
    expect(fresh.credential.token).toBe("oc_agent_private-workspace");
  });
});
