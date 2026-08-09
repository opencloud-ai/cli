import { OpenCloudClient } from "./api-client.js";
import {
  freshAccountCredential,
  normalizeApiUrl,
} from "./account-auth.js";
import {
  CredentialStore,
  type StoredCredential,
  type WorkspaceCredential,
} from "./credential-store.js";
import {
  loadWorkspaceBinding,
  saveWorkspaceBinding,
  type WorkspaceBinding,
} from "./workspace-store.js";

export interface ConnectedWorkspace {
  binding: WorkspaceBinding;
  stored: StoredCredential<WorkspaceCredential>;
}

export async function connectWorkspace(
  input: {
    store: CredentialStore;
    bindingFile: string;
    apiUrl: string;
    accessToken: string;
    appId: string;
  },
  request: typeof fetch = fetch,
): Promise<ConnectedWorkspace> {
  const apiUrl = normalizeApiUrl(input.apiUrl);
  const previous = loadWorkspaceBinding(input.bindingFile);
  const response = await new OpenCloudClient({
    apiUrl,
    token: input.accessToken,
    fetch: request,
  }).call("connectCliWorkspace", { appId: input.appId });
  if (
    !response.app.id ||
    !response.app.name ||
    !response.app.appUrl ||
    !response.credential.token ||
    !response.credential.expiresAt
  ) {
    throw new Error("OpenCloud returned an invalid workspace connection");
  }
  const credential: WorkspaceCredential = {
    schemaVersion: 1,
    kind: "workspace",
    apiUrl,
    appId: response.app.id,
    token: response.credential.token,
    expiresAt: response.credential.expiresAt,
  };
  const stored = await input.store.saveWorkspace(credential);
  const binding: WorkspaceBinding = {
    schemaVersion: 1,
    apiUrl,
    appId: response.app.id,
    appName: response.app.name,
    appUrl: response.app.appUrl,
    connectedAt: new Date().toISOString(),
    credentialExpiresAt: response.credential.expiresAt,
  };
  try {
    await saveWorkspaceBinding(input.bindingFile, binding);
  } catch (error) {
    await input.store.deleteWorkspace(apiUrl, response.app.id);
    throw error;
  }
  if (
    previous &&
    (previous.apiUrl !== binding.apiUrl || previous.appId !== binding.appId)
  ) {
    await input.store.deleteWorkspace(previous.apiUrl, previous.appId);
  }
  return { binding, stored };
}

export async function freshWorkspaceCredential(
  input: {
    store: CredentialStore;
    bindingFile: string;
  },
  request: typeof fetch = fetch,
): Promise<StoredCredential<WorkspaceCredential>> {
  const binding = loadWorkspaceBinding(input.bindingFile);
  if (!binding) {
    throw new Error(
      "This directory is not connected to an OpenCloud app. Run opencloud app connect <app-id>.",
    );
  }
  const stored = await input.store.loadWorkspace(binding.apiUrl, binding.appId);
  if (stored && Date.parse(stored.credential.expiresAt) > Date.now() + 60_000) {
    return stored;
  }
  const account = await freshAccountCredential(
    input.store,
    binding.apiUrl,
    request,
  );
  const connected = await connectWorkspace(
    {
      store: input.store,
      bindingFile: input.bindingFile,
      apiUrl: binding.apiUrl,
      accessToken: account.credential.accessToken,
      appId: binding.appId,
    },
    request,
  );
  return connected.stored;
}
