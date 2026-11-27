import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-client.js";
import {
  clearSavedWorkspace,
  fetchAccessibleWorkspaces,
  filterAppsByWorkspace,
  parseWorkspaceId,
  readWorkspacePreferences,
  resolvePinnedWorkspace,
  savedWorkspaceForApi,
  setSavedWorkspace,
  summarizeWorkspaces,
  WORKSPACE_PREFERENCES_FILE,
} from "./workspace-preference.js";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const WS_C = "33333333-3333-4333-8333-333333333333";
const API_PROD = "https://api.opencloud.ai";
const API_PREVIEW = "https://api.preview.ocd.dev";

const tempDirs: string[] = [];
function tempSettingsFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "oc-ws-pref-"));
  tempDirs.push(dir);
  return path.join(dir, WORKSPACE_PREFERENCES_FILE);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("workspace preferences and pin resolution", () => {
  it("validates RFC UUIDs and normalizes case", () => {
    expect(parseWorkspaceId(WS_A.toUpperCase())).toBe(WS_A);
    expect(() => parseWorkspaceId("not-a-uuid", "--workspace")).toThrow(
      /--workspace must be a workspace UUID/,
    );
    // Reject non-RFC UUID version/variant bits so Zod request schemas never fail later
    expect(() =>
      parseWorkspaceId("11111111-1111-0111-0111-111111111111", "--workspace"),
    ).toThrow(/--workspace must be a workspace UUID/);
  });

  it("persists per-apiUrl defaults with 0600 permissions and clears cleanly", () => {
    const file = tempSettingsFile();
    expect(savedWorkspaceForApi(file, API_PROD)).toBeNull();

    setSavedWorkspace(file, `${API_PROD}/`, WS_A.toUpperCase());
    setSavedWorkspace(file, API_PREVIEW, WS_B);
    expect(savedWorkspaceForApi(file, API_PROD)).toBe(WS_A);
    expect(savedWorkspaceForApi(file, API_PREVIEW)).toBe(WS_B);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }

    const cleared = clearSavedWorkspace(file, API_PROD);
    expect(cleared).toEqual({ cleared: true, previousWorkspaceId: WS_A });
    expect(savedWorkspaceForApi(file, API_PROD)).toBeNull();
    expect(savedWorkspaceForApi(file, API_PREVIEW)).toBe(WS_B);
    expect(clearSavedWorkspace(file, API_PROD)).toEqual({
      cleared: false,
      previousWorkspaceId: null,
    });
    expect(readWorkspacePreferences(file).defaults).toEqual({
      [API_PREVIEW]: WS_B,
    });
  });

  it("resolves precedence strictly: --workspace flag > OPENCLOUD_WORKSPACE > saved default", () => {
    const file = tempSettingsFile();
    setSavedWorkspace(file, API_PROD, WS_A);

    expect(
      resolvePinnedWorkspace({
        settingsFile: file,
        apiUrl: API_PROD,
        env: {},
      }),
    ).toEqual({ workspaceId: WS_A, source: "config" });

    expect(
      resolvePinnedWorkspace({
        settingsFile: file,
        apiUrl: API_PROD,
        env: { OPENCLOUD_WORKSPACE: WS_B.toUpperCase() },
      }),
    ).toEqual({ workspaceId: WS_B, source: "env:OPENCLOUD_WORKSPACE" });

    expect(
      resolvePinnedWorkspace({
        flagValue: WS_C,
        settingsFile: file,
        apiUrl: API_PROD,
        env: { OPENCLOUD_WORKSPACE: WS_B },
      }),
    ).toEqual({ workspaceId: WS_C, source: "flag" });

    // Blank env var falls through to saved default
    expect(
      resolvePinnedWorkspace({
        settingsFile: file,
        apiUrl: API_PROD,
        env: { OPENCLOUD_WORKSPACE: "   " },
      }),
    ).toEqual({ workspaceId: WS_A, source: "config" });

    // Malformed env var fails closed
    expect(() =>
      resolvePinnedWorkspace({
        settingsFile: file,
        apiUrl: API_PROD,
        env: { OPENCLOUD_WORKSPACE: "bad-value" },
      }),
    ).toThrow(/OPENCLOUD_WORKSPACE must be a workspace UUID/);
  });

  it("fetches /v1/workspaces and falls back to /v1/organisations on 404", async () => {
    const view = {
      organisation: {
        id: WS_A,
        name: "Core Team",
        status: "active",
        policyVersion: "1",
        plan: "core",
      },
      membership: {
        organisationId: WS_A,
        workspaceId: WS_A,
        userId: WS_C,
        role: "admin",
      },
      capabilities: {
        manageOrganisation: true,
        inviteMembers: true,
        manageLimits: true,
        leaveOrganisation: false,
      },
    };
    const get = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(404, "Cannot GET /v1/workspaces"))
      .mockResolvedValueOnce([view]);

    const list = await fetchAccessibleWorkspaces({ get });
    expect(get).toHaveBeenNthCalledWith(1, "/v1/workspaces");
    expect(get).toHaveBeenNthCalledWith(2, "/v1/organisations");
    expect(summarizeWorkspaces(list, WS_A)).toEqual([
      {
        id: WS_A,
        workspaceId: WS_A,
        organisationId: WS_A,
        name: "Core Team",
        status: "active",
        plan: "core",
        role: "admin",
        pinned: true,
        capabilities: view.capabilities,
      },
    ]);
  });

  it("filters apps by workspaceId or organisationId without shadowing", () => {
    const apps = [
      { id: "a", organisationId: WS_A },
      { id: "b", workspaceId: WS_B.toUpperCase(), organisationId: WS_B.toUpperCase() },
      { id: "legacy-dual", workspaceId: WS_C, organisationId: WS_A },
      { id: "empty-ws", workspaceId: "", organisationId: WS_A },
      { id: "c" },
    ];
    expect(filterAppsByWorkspace(apps, WS_A).map((a) => a.id)).toEqual([
      "a",
      "legacy-dual",
      "empty-ws",
    ]);
    expect(filterAppsByWorkspace(apps, WS_B).map((a) => a.id)).toEqual(["b"]);
  });
});
