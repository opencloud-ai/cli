import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  organisationDirectoryViewSchema,
  type OrganisationDirectoryView,
} from "@opencloud/contracts";
import { normalizeApiUrl } from "./account-auth.js";
import { ApiError, type OpenCloudClient } from "./api-client.js";
import { callerFailure } from "./caller-failure.js";
import { CliContractError } from "./cli-contract-error.js";

export const WORKSPACE_PREFERENCES_FILE = "workspaces.json";
export const WORKSPACE_ENV_VAR = "OPENCLOUD_WORKSPACE";

const workspaceUuidSchema = z.uuid();

export type WorkspacePinSource =
  | "flag"
  | "env:OPENCLOUD_WORKSPACE"
  | "config";

export interface ResolvedWorkspacePin {
  workspaceId: string;
  source: WorkspacePinSource;
}

export interface WorkspacePreferences {
  schemaVersion: 1;
  /** Normalized API URL -> pinned workspace UUID. */
  defaults: Record<string, string>;
}

export interface CliWorkspaceSummary {
  id: string;
  workspaceId: string;
  organisationId: string;
  name: string;
  status: OrganisationDirectoryView["organisation"]["status"];
  plan: OrganisationDirectoryView["organisation"]["plan"];
  role: OrganisationDirectoryView["membership"]["role"];
  pinned: boolean;
  capabilities: OrganisationDirectoryView["capabilities"];
  planFeatures?: OrganisationDirectoryView["planFeatures"] | undefined;
}

export function isWorkspaceUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    workspaceUuidSchema.safeParse(value.trim()).success
  );
}

export function parseWorkspaceId(
  value: unknown,
  optionLabel = "--workspace",
): string {
  if (
    typeof value !== "string" ||
    !workspaceUuidSchema.safeParse(value.trim()).success
  ) {
    throw callerFailure(
      new CliContractError(
        "INVALID_OPTION",
        `${optionLabel} must be a workspace UUID. Run opencloud workspace list to see available workspaces.`,
      ),
    );
  }
  return value.trim().toLowerCase();
}

export function readWorkspacePreferences(file: string): WorkspacePreferences {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { schemaVersion: 1, defaults: {} };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { schemaVersion: 1, defaults: {} };
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) {
    return { schemaVersion: 1, defaults: {} };
  }
  const defaults: Record<string, string> = {};
  if (
    candidate.defaults &&
    typeof candidate.defaults === "object" &&
    !Array.isArray(candidate.defaults)
  ) {
    for (const [rawApiUrl, rawWorkspaceId] of Object.entries(
      candidate.defaults as Record<string, unknown>,
    )) {
      if (!isWorkspaceUuid(rawWorkspaceId)) continue;
      try {
        defaults[normalizeApiUrl(rawApiUrl)] = rawWorkspaceId.trim().toLowerCase();
      } catch {
        // Ignore malformed API URL entries.
      }
    }
  }
  return { schemaVersion: 1, defaults };
}

export function writeWorkspacePreferences(
  file: string,
  preferences: WorkspacePreferences,
): void {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  const temporary = path.join(
    directory,
    `.workspaces-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function savedWorkspaceForApi(
  file: string,
  apiUrl: string,
): string | null {
  const normalized = normalizeApiUrl(apiUrl);
  return readWorkspacePreferences(file).defaults[normalized] ?? null;
}

export function setSavedWorkspace(
  file: string,
  apiUrl: string,
  workspaceId: string,
): WorkspacePreferences {
  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  const normalizedId = parseWorkspaceId(workspaceId, "workspace-id");
  const current = readWorkspacePreferences(file);
  const next: WorkspacePreferences = {
    schemaVersion: 1,
    defaults: {
      ...current.defaults,
      [normalizedApiUrl]: normalizedId,
    },
  };
  writeWorkspacePreferences(file, next);
  return next;
}

export function clearSavedWorkspace(
  file: string,
  apiUrl: string,
): { cleared: boolean; previousWorkspaceId: string | null } {
  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  const current = readWorkspacePreferences(file);
  const previousWorkspaceId = current.defaults[normalizedApiUrl] ?? null;
  if (!previousWorkspaceId) {
    return { cleared: false, previousWorkspaceId: null };
  }
  const nextDefaults = { ...current.defaults };
  delete nextDefaults[normalizedApiUrl];
  writeWorkspacePreferences(file, {
    schemaVersion: 1,
    defaults: nextDefaults,
  });
  return { cleared: true, previousWorkspaceId };
}

export function resolveEnvWorkspace(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWorkspacePin | null {
  const raw = env[WORKSPACE_ENV_VAR]?.trim();
  if (!raw) return null;
  return {
    workspaceId: parseWorkspaceId(raw, WORKSPACE_ENV_VAR),
    source: "env:OPENCLOUD_WORKSPACE",
  };
}

export function resolvePinnedWorkspace(input: {
  flagValue?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  settingsFile: string;
  apiUrl: string;
}): ResolvedWorkspacePin | null {
  if (input.flagValue !== undefined) {
    return {
      workspaceId: parseWorkspaceId(input.flagValue, "--workspace"),
      source: "flag",
    };
  }
  const fromEnv = resolveEnvWorkspace(input.env ?? process.env);
  if (fromEnv) return fromEnv;
  const fromConfig = savedWorkspaceForApi(input.settingsFile, input.apiUrl);
  if (fromConfig) {
    return { workspaceId: fromConfig, source: "config" };
  }
  return null;
}

const workspaceListSchema = z.array(organisationDirectoryViewSchema);

/**
 * Lists the active workspaces the authenticated account belongs to.
 * Calls canonical `GET /v1/workspaces` and falls back to `GET /v1/organisations`
 * on 404 for installations released before the `/v1/workspaces` rename.
 */
export async function fetchAccessibleWorkspaces(
  control: Pick<OpenCloudClient, "get">,
): Promise<OrganisationDirectoryView[]> {
  let raw: unknown;
  try {
    raw = await control.get("/v1/workspaces");
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    raw = await control.get("/v1/organisations");
  }
  const parsed = workspaceListSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliContractError(
      "API_CONTRACT_MISMATCH",
      "OpenCloud returned an unrecognized workspace list. This CLI and the OpenCloud API may be different versions.",
    );
  }
  return parsed.data;
}

export function summarizeWorkspaces(
  views: readonly OrganisationDirectoryView[],
  pinnedWorkspaceId: string | null,
): CliWorkspaceSummary[] {
  const normalizedPin = pinnedWorkspaceId?.toLowerCase() ?? null;
  return views.map((view) => {
    const id = view.organisation.id;
    return {
      id,
      workspaceId: id,
      organisationId: id,
      name: view.organisation.name,
      status: view.organisation.status,
      plan: view.organisation.plan,
      role: view.membership.role,
      pinned: normalizedPin !== null && id.toLowerCase() === normalizedPin,
      capabilities: view.capabilities,
      ...(view.planFeatures ? { planFeatures: view.planFeatures } : {}),
    };
  });
}

export function filterAppsByWorkspace<
  T extends { workspaceId?: string | undefined; organisationId?: string | undefined },
>(apps: readonly T[], workspaceId: string): T[] {
  const target = workspaceId.toLowerCase();
  return apps.filter(
    (app) =>
      (typeof app.workspaceId === "string" &&
        app.workspaceId.toLowerCase() === target) ||
      (typeof app.organisationId === "string" &&
        app.organisationId.toLowerCase() === target),
  );
}
