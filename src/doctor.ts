export interface DoctorDiagnosticsInput {
  apiUrl: string | null;
  token: string | null;
  cliVersion: string;
  currentDirectory: string;
  sessionFile: string;
  identitySource:
    | "environment-or-flag"
    | "workspace-credential"
    | "account-login"
    | "session-file"
    | "none";
  sessionState: string | null;
  appId: string | null;
  credentialExpiresAt: string | null;
  workspaceBindingFile?: string | null;
  accountLogin?: {
    backend: string;
    storedIn: string;
    accessExpiresAt: string;
    refreshExpiresAt: string;
  } | null;
}

export async function doctorDiagnostics(
  input: DoctorDiagnosticsInput,
  request: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  let platform: unknown = null;
  let reachable = false;
  if (input.apiUrl) {
    try {
      const response = await request(
        `${input.apiUrl.replace(/\/+$/, "")}/version`,
        {
          ...(input.token
            ? { headers: { authorization: `Bearer ${input.token}` } }
            : {}),
          signal: AbortSignal.timeout(10_000),
        },
      );
      reachable = response.ok;
      platform = response.ok
        ? await response.json()
        : { status: response.status };
    } catch (error) {
      platform = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    passed: Boolean(input.apiUrl && reachable && input.token),
    cliVersion: input.cliVersion,
    currentDirectory: input.currentDirectory,
    api: { url: input.apiUrl, reachable, platform },
    identity: {
      source: input.identitySource,
      sessionFile: input.sessionFile,
      workspaceBindingFile: input.workspaceBindingFile ?? null,
      state: input.sessionState,
      appId: input.appId,
      credentialExpiresAt: input.credentialExpiresAt,
      tokenPresent: Boolean(input.token),
      accountLogin: input.accountLogin ?? null,
    },
  };
}
