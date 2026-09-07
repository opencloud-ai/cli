import { normalizeApiUrl } from "./account-auth.js";
import type { OpenCloudSession, RuntimeAppOwnerReadyAgentSession } from "./session-store.js";

// The launcher atomically replaces this session when its short-lived credential
// rotates. A long-running CLI must reload it without accepting a new authority.
export function runtimeSessionTokenProvider(
  initial: RuntimeAppOwnerReadyAgentSession,
  load: () => OpenCloudSession | null,
): () => Promise<string> {
  return async () => {
    const current = load();
    if (
      current?.state !== "ready" || current.schemaVersion !== 2 ||
      current.authorityMode !== "app_owner_v1" ||
      current.appId !== initial.appId || current.rootRunId !== initial.rootRunId ||
      current.familyId !== initial.familyId ||
      normalizeApiUrl(current.apiUrl) !== normalizeApiUrl(initial.apiUrl)
    ) {
      throw new Error("Runtime session authority changed; no request was sent");
    }
    return current.token;
  };
}
