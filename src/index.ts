#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Argument, Command, Option } from "commander";
import YAML from "yaml";
import { OPEN_CLOUD_SDK_VERSION } from "@opencloud/js";
import {
  OPEN_CLOUD_FAVICON_DATA_URI,
  OPEN_CLOUD_LOGO_DATA_URI,
  type AgentOnboardingResponse,
} from "@opencloud/contracts";
import { OpenCloudClient } from "./api-client.js";
import { requestApp } from "./app-edge.js";
import {
  beginDeviceAuthorization,
  completeDeviceAuthorization,
  DEFAULT_API_URL,
  freshAccountCredential,
  normalizeApiUrl,
  openBrowser,
  revokeAccountCredential,
} from "./account-auth.js";
import { buildBundle } from "./bundle.js";
import { CredentialStore } from "./credential-store.js";
import { doctorDiagnostics } from "./doctor.js";
import { devDataRequest, type DevDataAction } from "./dev-data.js";
import {
  deleteSession,
  loadSession,
  resolveSessionFile,
  saveSession,
  type OpenCloudSession,
} from "./session-store.js";
import {
  connectWorkspace,
  freshWorkspaceCredential,
} from "./workspace-auth.js";
import {
  loadWorkspaceBinding,
  resolveWorkspaceFile,
} from "./workspace-store.js";

const CLI_VERSION = "3.0.0";

const program = new Command()
  .name("opencloud")
  .description("Agent- and human-facing client for the OpenCloud control plane")
  .version(CLI_VERSION, "-V, --cli-version", "print the CLI version")
  .addOption(
    new Option("--api-url <url>", "Control-plane API URL").env(
      "OPENCLOUD_API_URL",
    ),
  )
  .addOption(
    new Option("--token <token>", "API or app-scoped agent token").env(
      "OPENCLOUD_TOKEN",
    ),
  )
  .addOption(
    new Option(
      "--session-file <path>",
      "Secure CLI session file created by onboarding",
    ).env("OPENCLOUD_SESSION_FILE"),
  )
  .addOption(
    new Option(
      "--workspace-file <path>",
      "Non-secret app binding file (defaults to .opencloud/app.json)",
    ).env("OPENCLOUD_WORKSPACE_FILE"),
  );

const credentialStore = new CredentialStore();

function sessionFile(): string {
  return resolveSessionFile(
    program.opts<{ sessionFile?: string }>().sessionFile,
  );
}

function workspaceFile(): string {
  return resolveWorkspaceFile(
    program.opts<{ workspaceFile?: string }>().workspaceFile,
  );
}

function availableSession(): OpenCloudSession | null {
  return loadSession(sessionFile());
}

function availableWorkspace() {
  return loadWorkspaceBinding(workspaceFile());
}

function targetApiUrl(): string {
  return (
    program.opts<{ apiUrl?: string }>().apiUrl ??
    availableWorkspace()?.apiUrl ??
    availableSession()?.apiUrl ??
    DEFAULT_API_URL
  );
}

function client(): OpenCloudClient {
  const options = program.opts<{ apiUrl?: string; token?: string }>();
  const binding = availableWorkspace();
  const legacy = availableSession();
  const apiUrl = options.apiUrl ?? binding?.apiUrl ?? legacy?.apiUrl;
  if (options.token) {
    if (!apiUrl) {
      throw new Error("Pass --api-url with --token outside a connected workspace.");
    }
    return new OpenCloudClient({ apiUrl, token: options.token });
  }
  if (binding) {
    if (
      options.apiUrl &&
      normalizeApiUrl(options.apiUrl) !== normalizeApiUrl(binding.apiUrl)
    ) {
      throw new Error(
        `This workspace is connected to ${binding.apiUrl}; remove --api-url or reconnect it.`,
      );
    }
    let tokenPromise: Promise<string> | null = null;
    return new OpenCloudClient({
      apiUrl: binding.apiUrl,
      tokenProvider: () => {
        tokenPromise ??= freshWorkspaceCredential({
          store: credentialStore,
          bindingFile: workspaceFile(),
        }).then((stored) => stored.credential.token);
        return tokenPromise;
      },
    });
  }
  if (legacy?.state === "ready") {
    if (
      options.apiUrl &&
      normalizeApiUrl(options.apiUrl) !== normalizeApiUrl(legacy.apiUrl)
    ) {
      throw new Error("The legacy session belongs to a different API URL.");
    }
    return new OpenCloudClient({ apiUrl: legacy.apiUrl, token: legacy.token });
  }
  throw new Error(
    legacy?.state === "awaiting_email_verification"
      ? "Email verification is still pending. Run opencloud onboard-complete after confirming the email."
      : legacy?.state === "starting"
        ? "Onboarding has not completed. Re-run the same opencloud onboard command."
        : "Run opencloud login, then opencloud app connect <app-id> in this directory.",
  );
}

async function managementClient(): Promise<OpenCloudClient> {
  const options = program.opts<{ token?: string }>();
  if (options.token) return client();
  const apiUrl = normalizeApiUrl(targetApiUrl());
  const account = await credentialStore.loadAccount(apiUrl);
  if (account) {
    const fresh = await freshAccountCredential(credentialStore, apiUrl);
    return new OpenCloudClient({
      apiUrl,
      token: fresh.credential.accessToken,
    });
  }
  if (availableWorkspace()) return client();
  const legacy = availableSession();
  if (legacy?.state === "ready") {
    return new OpenCloudClient({ apiUrl: legacy.apiUrl, token: legacy.token });
  }
  throw new Error("No OpenCloud account login was found. Run opencloud login.");
}

function requiredAccountCredential() {
  return freshAccountCredential(
    credentialStore,
    normalizeApiUrl(targetApiUrl()),
  );
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function callerPath(value: string): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

function printBundleFiles(files: string[]): void {
  process.stderr.write(
    `Bundle files (${files.length}):\n${files
      .map((file) => `  ${file}`)
      .join("\n")}\n`,
  );
}

function printBundleWarnings(
  warnings: Array<{ code: string; path: string; message: string }>,
): void {
  if (!warnings.length) return;
  process.stderr.write(
    `Bundle warnings (${warnings.length}):\n${warnings
      .map((warning) => `  [${warning.code}] ${warning.message}`)
      .join("\n")}\n`,
  );
}

interface LocalDevState {
  schemaVersion: 1;
  appId: string;
  draftId: string;
  sessionId: string;
  artifactSha256: string;
  updatedAt: string;
}

interface DevSessionWire {
  id: string;
  appId: string;
  draftId: string;
  status: string;
  previewUrl: string;
  activeRevision: {
    id: string;
    draftRevision: number;
    artifactSha256: string;
  } | null;
  verification: { receiptId: string; revisionId: string } | null;
}

function devStatePath(sourceRoot: string): string {
  return path.join(sourceRoot, ".opencloud", "dev.json");
}

async function readDevState(sourceRoot: string): Promise<LocalDevState | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(devStatePath(sourceRoot), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = parsed as Partial<LocalDevState>;
  if (
    value.schemaVersion !== 1 ||
    !value.appId ||
    !value.draftId ||
    !value.sessionId ||
    !value.artifactSha256 ||
    !value.updatedAt
  ) {
    throw new Error(
      ".opencloud/dev.json is invalid; stop the session or repair the file",
    );
  }
  return value as LocalDevState;
}

async function requireDevState(sourceRoot: string): Promise<LocalDevState> {
  const state = await readDevState(sourceRoot);
  if (!state) {
    throw new Error(
      "No local development session was found. Run opencloud app dev start <directory> first.",
    );
  }
  return state;
}

async function saveDevState(
  sourceRoot: string,
  state: LocalDevState,
): Promise<void> {
  const directory = path.dirname(devStatePath(sourceRoot));
  const temporary = path.join(
    directory,
    `.dev-${process.pid}-${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, devStatePath(sourceRoot));
}

async function synchronizeValidatedDraft(
  control: OpenCloudClient,
  sourceRoot: string,
  existingDraftId?: string,
): Promise<{
  appId: string;
  draftId: string;
  artifactSha256: string;
  validation: unknown;
}> {
  const bundle = await buildBundle(sourceRoot);
  printBundleFiles(bundle.files);
  printBundleWarnings(bundle.warnings);
  let draft: { id: string; revision: number };
  if (existingDraftId) {
    const existing = await control.call("getDraft", {
      appId: bundle.manifest.appId,
      draftId: existingDraftId,
    });
    if (["deploying", "deployed", "discarded"].includes(existing.status)) {
      throw new Error(
        `The local dev draft is ${existing.status}; start a new dev session for the next change.`,
      );
    }
    draft = { id: existing.id, revision: existing.revision };
  } else {
    const created = await control.call("createDraft", {
      appId: bundle.manifest.appId,
      body: {
        name: `Dev ${bundle.manifest.version}`,
        cloneActive: false,
      },
    });
    draft = { id: created.id, revision: created.revision };
  }

  const remoteFiles = await control.call("listDraftFiles", {
    appId: bundle.manifest.appId,
    draftId: draft.id,
  });
  const remote = new Map(
    remoteFiles
      .filter((file) => !file.deleted)
      .map((file) => [file.path, file]),
  );
  const local = new Map<string, { content: Buffer; sha256: string }>();
  for (const file of bundle.files) {
    const content =
      file === "opencloud.json"
        ? Buffer.from(`${JSON.stringify(bundle.manifest, null, 2)}\n`)
        : await readFile(path.join(sourceRoot, ...file.split("/")));
    local.set(file, {
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }

  const changes: Array<{
    path: string;
    baseSha256?: string | null;
    contentBase64?: string;
    delete?: boolean;
  }> = [];
  for (const [file, value] of local) {
    const existing = remote.get(file);
    if (existing?.sha256 === value.sha256) continue;
    changes.push({
      path: file,
      ...(existing ? { baseSha256: existing.sha256 } : {}),
      contentBase64: value.content.toString("base64"),
    });
  }
  for (const [file, existing] of remote) {
    if (!local.has(file)) {
      changes.push({ path: file, baseSha256: existing.sha256, delete: true });
    }
  }
  changes.sort((left, right) => left.path.localeCompare(right.path));

  let revision = draft.revision;
  for (let offset = 0; offset < changes.length; offset += 200) {
    const applied = await control.call("applyDraftChanges", {
      appId: bundle.manifest.appId,
      draftId: draft.id,
      body: {
        expectedRevision: revision,
        changes: changes.slice(offset, offset + 200),
      },
    });
    revision = applied.draft.revision;
  }
  const validation = await control.call("validateDraft", {
    appId: bundle.manifest.appId,
    draftId: draft.id,
    body: {},
  });
  if (!validation.passed) {
    output({ draft, validation });
    throw new Error("Authoritative server validation failed");
  }
  if (validation.artifactSha256 !== bundle.sha256) {
    throw new Error("Local and server canonical bundle digests do not match");
  }
  return {
    appId: bundle.manifest.appId,
    draftId: draft.id,
    artifactSha256: bundle.sha256,
    validation,
  };
}

async function storeDevSession(
  sourceRoot: string,
  artifactSha256: string,
  session: DevSessionWire,
): Promise<void> {
  await saveDevState(sourceRoot, {
    schemaVersion: 1,
    appId: session.appId,
    draftId: session.draftId,
    sessionId: session.id,
    artifactSha256,
    updatedAt: new Date().toISOString(),
  });
}

async function followDurableOperation(
  control: OpenCloudClient,
  operationId: string,
  intervalMs = 2_000,
): Promise<{ id?: string; state?: string }> {
  let operation: { id?: string; state?: string } = {
    id: operationId,
    state: "queued",
  };
  while (
    !["succeeded", "failed", "cancelled"].includes(operation.state ?? "")
  ) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    operation = (await control.call("getOperation", {
      operationId,
    })) as { id?: string; state?: string };
    output({ operation });
  }
  return operation;
}

function onboardingApiUrl(): string {
  return (
    program.opts<{ apiUrl?: string }>().apiUrl ??
    availableSession()?.apiUrl ??
    "https://api.opencloud.ai"
  );
}

function parseOnboardingResponse(value: unknown): AgentOnboardingResponse {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { onboardingId?: unknown }).onboardingId !== "string" ||
    typeof (value as { launchUrl?: unknown }).launchUrl !== "string" ||
    typeof (value as { state?: unknown }).state !== "string"
  ) {
    throw new Error("OpenCloud returned an invalid onboarding response");
  }
  return value as AgentOnboardingResponse;
}

async function persistOnboardingResponse(
  response: AgentOnboardingResponse,
  apiUrl: string,
  file: string,
): Promise<Record<string, unknown>> {
  const { completionToken, credential, ...safe } = response;
  if (credential?.token && response.app) {
    await saveSession(file, {
      schemaVersion: 1,
      state: "ready",
      apiUrl,
      appId: response.app.id,
      appUrl: response.app.appUrl,
      token: credential.token,
      credentialExpiresAt: credential.expiresAt,
    });
    return {
      ...safe,
      credential: {
        expiresAt: credential.expiresAt,
        storedIn: file,
      },
      next: "The app-scoped credential is stored locally. Continue building, give the owner launchUrl as their primary link while confirmation is pending, and do not print the session file.",
    };
  }
  if (completionToken) {
    await saveSession(file, {
      schemaVersion: 1,
      state: "awaiting_email_verification",
      apiUrl,
      onboardingId: response.onboardingId,
      completionToken,
      verificationExpiresAt: response.verification.expiresAt,
    });
    return {
      ...safe,
      credential: null,
      sessionFile: file,
      next: "Give the user launchUrl, ask them to confirm the project email, then run opencloud onboard-complete. Do not print the session file.",
    };
  }
  return {
    ...safe,
    credential: null,
    sessionFile: file,
    next: "Give the owner launchUrl. Email verification is still pending; run opencloud onboard-complete after they confirm.",
  };
}

program
  .command("login")
  .description("Sign in to an existing OpenCloud account in your browser")
  .option("--force", "replace and revoke the currently stored account login")
  .option("--no-browser", "print the approval URL without opening a browser")
  .action(async (options) => {
    const apiUrl = normalizeApiUrl(targetApiUrl());
    const existing = await credentialStore.loadAccount(apiUrl);
    if (existing && !options.force) {
      try {
        const fresh = await freshAccountCredential(credentialStore, apiUrl);
        output({
          state: "authenticated",
          apiUrl,
          credential: {
            backend: fresh.backend,
            storedIn: fresh.location,
            accessExpiresAt: fresh.credential.accessExpiresAt,
            refreshExpiresAt: fresh.credential.refreshExpiresAt,
          },
          next: "Run opencloud app list, then opencloud app connect <app-id> in the app directory.",
        });
        return;
      } catch {
        throw new Error(
          "The stored login could not be refreshed. Run opencloud login --force to replace it.",
        );
      }
    }
    if (existing) {
      await revokeAccountCredential(existing.credential);
      await credentialStore.deleteAccount(apiUrl);
      const binding = availableWorkspace();
      if (binding) {
        await credentialStore.deleteWorkspace(binding.apiUrl, binding.appId);
      }
    }
    const authorization = await beginDeviceAuthorization(apiUrl);
    process.stderr.write(
      `Open this URL to approve the CLI:\n${authorization.verificationUriComplete}\n`,
    );
    const browserOpened = options.browser !== false
      ? openBrowser(authorization.verificationUriComplete)
      : false;
    const account = await completeDeviceAuthorization(authorization);
    const stored = await credentialStore.saveAccount(account);
    output({
      state: "authenticated",
      apiUrl,
      browserOpened,
      credential: {
        backend: stored.backend,
        storedIn: stored.location,
        accessExpiresAt: account.accessExpiresAt,
        refreshExpiresAt: account.refreshExpiresAt,
      },
      next: "Run opencloud app list, then opencloud app connect <app-id> in the app directory.",
    });
  });

const auth = program
  .command("auth")
  .description("Inspect or clear the stored OpenCloud account login");

auth
  .command("status")
  .description("Show redacted account and workspace authentication status")
  .action(async () => {
    const apiUrl = normalizeApiUrl(targetApiUrl());
    const existing = await credentialStore.loadAccount(apiUrl);
    let account:
      | {
          state: "authenticated";
          backend: string;
          storedIn: string;
          accessExpiresAt: string;
          refreshExpiresAt: string;
        }
      | { state: "needs_login"; reason: string }
      | null = null;
    if (existing) {
      try {
        const fresh = await freshAccountCredential(credentialStore, apiUrl);
        account = {
          state: "authenticated",
          backend: fresh.backend,
          storedIn: fresh.location,
          accessExpiresAt: fresh.credential.accessExpiresAt,
          refreshExpiresAt: fresh.credential.refreshExpiresAt,
        };
      } catch (error) {
        account = {
          state: "needs_login",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const binding = availableWorkspace();
    const workspaceCredential = binding
      ? await credentialStore.loadWorkspace(binding.apiUrl, binding.appId)
      : null;
    output({
      authenticated: account?.state === "authenticated",
      apiUrl,
      account,
      workspace: binding
        ? {
            bindingFile: workspaceFile(),
            appId: binding.appId,
            appName: binding.appName,
            appUrl: binding.appUrl,
            credential: workspaceCredential
              ? {
                  present: true,
                  active:
                    Date.parse(workspaceCredential.credential.expiresAt) >
                    Date.now(),
                  expiresAt: workspaceCredential.credential.expiresAt,
                  backend: workspaceCredential.backend,
                  storedIn: workspaceCredential.location,
                }
              : { present: false },
          }
        : null,
      legacyOnboardingSession: availableSession()?.state ?? null,
    });
  });

async function logout(): Promise<void> {
  const apiUrl = normalizeApiUrl(targetApiUrl());
  const existing = await credentialStore.loadAccount(apiUrl);
  if (existing) await revokeAccountCredential(existing.credential);
  const binding = availableWorkspace();
  if (binding) {
    await credentialStore.deleteWorkspace(binding.apiUrl, binding.appId);
  }
  await credentialStore.deleteAccount(apiUrl);
  const legacyOnboardingSession = availableSession();
  const legacyOnboardingSessionRemoved = await deleteSession(sessionFile());
  output({
    state: "logged_out",
    apiUrl,
    remoteLoginRevoked: Boolean(existing),
    currentWorkspaceCredentialRemoved: Boolean(binding),
    workspaceBindingRetained: binding ? workspaceFile() : null,
    legacyOnboardingSessionRemoved: legacyOnboardingSessionRemoved
      ? legacyOnboardingSession?.state ?? true
      : false,
    next: binding
      ? "The non-secret app binding remains. Run opencloud login to reconnect it later."
      : "Run opencloud login to sign in again.",
  });
}

auth.command("logout").description("Revoke and clear the CLI login").action(logout);
program.command("logout").description("Revoke and clear the CLI login").action(logout);

program
  .command("onboard")
  .description(
    "Create an email-based OpenCloud identity and automatically addressed project",
  )
  .requiredOption("--email <email>", "user email address")
  .requiredOption("--name <name>", "project title")
  .addOption(
    new Option("--visibility <visibility>", "public or private")
      .choices(["public", "private"])
      .default("private"),
  )
  .option("--idempotency-key <uuid>", "safe retry key")
  .action(async (options) => {
    const apiUrl = onboardingApiUrl();
    const file = sessionFile();
    const stored = loadSession(file);
    if (stored?.state === "ready") {
      throw new Error(
        `This workspace is already connected to ${stored.appId}. Use another --session-file for a new project.`,
      );
    }
    if (stored?.state === "awaiting_email_verification") {
      throw new Error(
        "Email verification is already pending. Confirm it and run opencloud onboard-complete.",
      );
    }
    const request = {
      email: String(options.email).trim().toLowerCase(),
      projectName: String(options.name).trim(),
      visibility: options.visibility as "public" | "private",
    };
    if (
      stored?.state === "starting" &&
      (stored.apiUrl !== apiUrl ||
        stored.email !== request.email ||
        stored.projectName !== request.projectName ||
        stored.visibility !== request.visibility)
    ) {
      throw new Error(
        "A different onboarding request is already pending in this session file. Re-run the original request or use another --session-file.",
      );
    }
    if (
      stored?.state === "starting" &&
      options.idempotencyKey &&
      options.idempotencyKey !== stored.idempotencyKey
    ) {
      throw new Error(
        "The pending onboarding request already has a retry key. Omit --idempotency-key or use another --session-file.",
      );
    }
    const idempotencyKey =
      options.idempotencyKey ??
      (stored?.state === "starting" ? stored.idempotencyKey : randomUUID());
    await saveSession(file, {
      schemaVersion: 1,
      state: "starting",
      apiUrl,
      idempotencyKey,
      ...request,
    });
    const response = parseOnboardingResponse(
      await new OpenCloudClient({ apiUrl }).post(
        "/v1/onboarding/agent",
        request,
        idempotencyKey,
      ),
    );
    output(await persistOnboardingResponse(response, apiUrl, file));
  });

program
  .command("onboard-complete")
  .description("Finish onboarding after an existing user confirms by email")
  .action(async () => {
    const file = sessionFile();
    const stored = loadSession(file);
    if (!stored) {
      throw new Error("No OpenCloud onboarding session was found");
    }
    if (stored.state === "ready") {
      output({
        state: "ready",
        appId: stored.appId,
        appUrl: stored.appUrl,
        credential: {
          expiresAt: stored.credentialExpiresAt,
          storedIn: file,
        },
      });
      return;
    }
    if (stored.state === "starting") {
      throw new Error(
        "The initial onboarding request has not completed. Re-run the same opencloud onboard command.",
      );
    }
    const response = parseOnboardingResponse(
      await new OpenCloudClient({ apiUrl: stored.apiUrl }).post(
        `/v1/onboarding/agent/${encodeURIComponent(stored.onboardingId)}/complete`,
        { completionToken: stored.completionToken },
      ),
    );
    output(await persistOnboardingResponse(response, stored.apiUrl, file));
  });

program
  .command("doctor")
  .description("Print redacted CLI, identity, endpoint, and platform diagnostics")
  .action(async () => {
    const options = program.opts<{ apiUrl?: string; token?: string }>();
    const file = sessionFile();
    const stored = availableSession();
    const binding = availableWorkspace();
    const account = await credentialStore.loadAccount(
      normalizeApiUrl(
        options.apiUrl ?? binding?.apiUrl ?? stored?.apiUrl ?? DEFAULT_API_URL,
      ),
    );
    const workspaceCredential = binding
      ? await credentialStore.loadWorkspace(binding.apiUrl, binding.appId)
      : null;
    const apiUrl =
      options.apiUrl ??
      binding?.apiUrl ??
      account?.credential.apiUrl ??
      stored?.apiUrl ??
      null;
    const token =
      options.token ??
      workspaceCredential?.credential.token ??
      account?.credential.accessToken ??
      (stored?.state === "ready" ? stored.token : null);
    output(
      await doctorDiagnostics({
        apiUrl,
        token,
        cliVersion: CLI_VERSION,
        currentDirectory: process.cwd(),
        sessionFile: file,
        identitySource: options.token
          ? "environment-or-flag"
          : workspaceCredential
            ? "workspace-credential"
            : account
              ? "account-login"
              : stored
                ? "session-file"
                : "none",
        sessionState: binding ? "connected" : stored?.state ?? null,
        appId:
          binding?.appId ?? (stored?.state === "ready" ? stored.appId : null),
        credentialExpiresAt:
          workspaceCredential?.credential.expiresAt ??
          (stored?.state === "ready" ? stored.credentialExpiresAt : null),
        workspaceBindingFile: binding ? workspaceFile() : null,
        accountLogin: account
          ? {
              backend: account.backend,
              storedIn: account.location,
              accessExpiresAt: account.credential.accessExpiresAt,
              refreshExpiresAt: account.credential.refreshExpiresAt,
            }
          : null,
      }),
    );
  });

const app = program.command("app").description("Manage OpenCloud apps");

app
  .command("create")
  .requiredOption("--name <name>")
  .option("--visibility <visibility>", "public or private", "private")
  .option(
    "--owner-user-id <uuid>",
    "required when using the platform operator credential",
  )
  .option("--idempotency-key <key>")
  .action(async (options) => {
    output(
      await (await managementClient()).call(
        "createApp",
        {
          body: {
            name: options.name,
            visibility: options.visibility,
            ...(options.ownerUserId
              ? { ownerUserId: options.ownerUserId }
              : {}),
          },
        },
        {
          idempotencyKey: options.idempotencyKey ?? randomUUID(),
        },
      ),
    );
  });

app
  .command("list")
  .description("List apps available to the signed-in account")
  .action(async () =>
    output(await (await managementClient()).get("/v1/apps")),
  );

app
  .command("get")
  .argument("<app-id>")
  .action(async (appId) =>
    output(
      await (await managementClient()).get(`/v1/apps/${appId}`),
    ),
  );

app
  .command("connect")
  .description("Connect this directory to an app with an expiring credential")
  .argument("<app-id>")
  .action(async (appId) => {
    const account = await requiredAccountCredential();
    const connected = await connectWorkspace({
      store: credentialStore,
      bindingFile: workspaceFile(),
      apiUrl: account.credential.apiUrl,
      accessToken: account.credential.accessToken,
      appId,
    });
    output({
      state: "connected",
      app: connected.binding,
      workspaceFile: workspaceFile(),
      credential: {
        backend: connected.stored.backend,
        storedIn: connected.stored.location,
        expiresAt: connected.stored.credential.expiresAt,
      },
      next: "Codex can now build, validate, preview, and deploy this app with the OpenCloud CLI.",
    });
  });

app
  .command("sdk-inspect")
  .description("Show the SDK pinned to the active deployment")
  .argument("<app-id>")
  .action(async (appId) => {
    const control = client();
    const appValue = (await control.get(`/v1/apps/${appId}`)) as {
      activeDeploymentId?: string | null;
    };
    if (!appValue.activeDeploymentId) {
      throw new Error("App has no active deployment");
    }
    const deployment = (await control.get(
      `/v1/apps/${appId}/deployments/${appValue.activeDeploymentId}`,
    )) as {
      id?: string;
      version?: string;
      sdkVersion?: string;
    };
    if (
      !deployment.id ||
      !deployment.version ||
      !deployment.sdkVersion
    ) {
      throw new Error(
        "The active deployment does not expose an OpenCloud SDK pin",
      );
    }
    output({
      appId,
      deploymentId: deployment.id,
      deploymentVersion: deployment.version,
      sdk: {
        package: "@opencloud/js",
        version: deployment.sdkVersion,
        module: "/_opencloud/sdk.js",
        types: "/_opencloud/sdk.d.ts",
      },
    });
  });

app
  .command("origin")
  .description("Print the canonical public origins for an app")
  .argument("<app-id>")
  .action(async (appId) => {
    const value = (await client().get(`/v1/apps/${appId}`)) as {
      id?: string;
      appUrl?: string;
      authUrl?: string;
      apiUrl?: string;
    };
    if (!value.id || !value.appUrl || !value.authUrl || !value.apiUrl) {
      throw new Error("The control plane did not return canonical app origins");
    }
    output({
      appId: value.id,
      appUrl: value.appUrl,
      authUrl: value.authUrl,
      apiUrl: value.apiUrl,
    });
  });

const dev = app
  .command("dev")
  .description(
    "Develop against an isolated preview before production deployment",
  );

dev
  .command("start")
  .description("Validate, sync, and start or resume an isolated dev preview")
  .argument("<directory>")
  .action(async (directory) => {
    const sourceRoot = callerPath(directory);
    const control = client();
    const previous = await readDevState(sourceRoot);
    const synchronized = await synchronizeValidatedDraft(
      control,
      sourceRoot,
      previous?.draftId,
    );
    if (previous && previous.appId !== synchronized.appId) {
      throw new Error("The app manifest no longer matches .opencloud/dev.json");
    }
    const session = (await control.call("startDevSession", {
      appId: synchronized.appId,
      draftId: synchronized.draftId,
      body: { apply: true },
    })) as DevSessionWire;
    await storeDevSession(sourceRoot, synchronized.artifactSha256, session);
    output({
      session,
      validation: synchronized.validation,
      localState: devStatePath(sourceRoot),
      next: [
        "Open session.previewUrl or use `opencloud app dev request <directory> /`.",
        "After edits run `opencloud app dev sync <directory>`.",
        "Functions remain dormant until `app dev invoke` or a deliberate preview action calls them.",
        "Add isolated fixtures with `app dev data`, then verify and run `app dev promote`; promotion follows production verification and reports the live URL.",
      ],
    });
  });

dev
  .command("sync")
  .description(
    "Validate local files and atomically replace the active dev revision",
  )
  .argument("<directory>")
  .action(async (directory) => {
    const sourceRoot = callerPath(directory);
    const state = await requireDevState(sourceRoot);
    const control = client();
    const synchronized = await synchronizeValidatedDraft(
      control,
      sourceRoot,
      state.draftId,
    );
    if (state.appId !== synchronized.appId) {
      throw new Error("The app manifest no longer matches .opencloud/dev.json");
    }
    const session = (await control.call("applyDevRevision", {
      appId: state.appId,
      sessionId: state.sessionId,
    })) as DevSessionWire;
    await storeDevSession(sourceRoot, synchronized.artifactSha256, session);
    output({ session, validation: synchronized.validation });
  });

dev
  .command("status")
  .description(
    "Show the active revision, capability URL, and verification receipt",
  )
  .argument("[directory]", "app source directory", ".")
  .action(async (directory) => {
    const sourceRoot = callerPath(directory);
    const state = await requireDevState(sourceRoot);
    output(
      await client().call("getDevSession", {
        appId: state.appId,
        sessionId: state.sessionId,
      }),
    );
  });

dev
  .command("request")
  .description(
    "Inspect a preview page or REST GET/HEAD through the trusted edge",
  )
  .argument("<directory>")
  .argument("[path]", "same-origin preview path", "/")
  .addOption(
    new Option("--method <method>", "HTTP method")
      .choices(["GET", "HEAD"])
      .default("GET"),
  )
  .action(async (directory, requestPath, options) => {
    const state = await requireDevState(callerPath(directory));
    output(
      await client().call("requestDevApp", {
        appId: state.appId,
        sessionId: state.sessionId,
        body: {
          path: String(requestPath),
          method: options.method as "GET" | "HEAD",
        },
      }),
    );
  });

dev
  .command("data")
  .description(
    "Create, update, or delete typed fixtures in the isolated dev database",
  )
  .argument("<directory>")
  .argument("<table>", "lowercase table name")
  .addArgument(
    new Argument("<action>", "SDK-shaped fixture action").choices([
      "create",
      "createMany",
      "updateById",
      "deleteById",
    ]),
  )
  .option("--values <json>", "row object or row array, as JSON")
  .option("--id <id>", "row id for updateById or deleteById")
  .action(async (directory, table, action, options) => {
    const state = await requireDevState(callerPath(directory));
    const body = devDataRequest(String(table), action as DevDataAction, {
      id: options.id === undefined ? undefined : String(options.id),
      values:
        options.values === undefined ? undefined : String(options.values),
    });
    output(
      await client().call("mutateDevData", {
        appId: state.appId,
        sessionId: state.sessionId,
        body,
      }),
    );
  });

dev
  .command("invoke")
  .description("Explicitly boot one dev Function without production secrets")
  .argument("<directory>")
  .argument("<function-name>")
  .option("--body <json>", "JSON request body", "{}")
  .action(async (directory, functionName, options) => {
    const state = await requireDevState(callerPath(directory));
    let body: unknown;
    try {
      body = JSON.parse(String(options.body));
    } catch {
      throw new Error("--body must be valid JSON");
    }
    output(
      await client().call("invokeDevFunction", {
        appId: state.appId,
        sessionId: state.sessionId,
        functionName: String(functionName),
        body: { body },
      }),
    );
  });

dev
  .command("requests")
  .description("List correlated, redacted dev Function outcomes")
  .argument("[directory]", "app source directory", ".")
  .option("--limit <number>", "maximum records", "100")
  .action(async (directory, options) => {
    const state = await requireDevState(callerPath(directory));
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("--limit must be an integer between 1 and 200");
    }
    output(
      await client().call("listDevInvocations", {
        appId: state.appId,
        sessionId: state.sessionId,
        query: { limit },
      }),
    );
  });

dev
  .command("receipts")
  .description("List exact-revision verification evidence, even after dev stops")
  .argument("[directory]", "app source directory", ".")
  .option("--limit <number>", "maximum records", "50")
  .action(async (directory, options) => {
    const bundle = await buildBundle(callerPath(directory));
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("--limit must be an integer between 1 and 200");
    }
    output(
      await client().call("listDevReceipts", {
        appId: bundle.manifest.appId,
        query: { limit },
      }),
    );
  });

dev
  .command("evidence")
  .description("Export redacted, machine-readable dev verification evidence")
  .argument("[directory]", "app source directory", ".")
  .action(async (directory) => {
    const sourceRoot = callerPath(directory);
    const bundle = await buildBundle(sourceRoot);
    const localState = await readDevState(sourceRoot);
    const receipts = await client().call("listDevReceipts", {
      appId: bundle.manifest.appId,
      query: { limit: 50 },
    });
    output({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      cliVersion: CLI_VERSION,
      appId: bundle.manifest.appId,
      localArtifactSha256: bundle.sha256,
      localSession: localState
        ? {
            sessionId: localState.sessionId,
            artifactSha256: localState.artifactSha256,
            updatedAt: localState.updatedAt,
          }
        : null,
      warnings: bundle.warnings,
      receipts,
    });
  });

dev
  .command("verify")
  .description(
    "Run Chromium and primary-flow checks for the exact dev revision",
  )
  .argument("[directory]", "app source directory", ".")
  .action(async (directory) => {
    const state = await requireDevState(callerPath(directory));
    const result = await client().call("verifyDevSession", {
      appId: state.appId,
      sessionId: state.sessionId,
    });
    output(result);
    if (!result.receipt.summary.passed) process.exitCode = 1;
  });

dev
  .command("promote")
  .description(
    "Deploy only the exact dev revision covered by the current receipt",
  )
  .argument("[directory]", "app source directory", ".")
  .option("--idempotency-key <key>")
  .option("--no-follow", "return after starting the production deployment")
  .action(async (directory, options) => {
    const sourceRoot = callerPath(directory);
    const state = await requireDevState(sourceRoot);
    const control = client();
    const result = await control.call(
      "promoteDevRevision",
      { appId: state.appId, sessionId: state.sessionId },
      {
        idempotencyKey: options.idempotencyKey ?? randomUUID(),
        timeoutMs: 120_000,
      },
    );
    output({ promotion: result });
    if (options.follow === false) return;
    if (!result.operation.id) {
      throw new Error("Promotion did not return a durable operation");
    }
    const deploymentOperation = await followDurableOperation(
      control,
      result.operation.id,
    );
    if (deploymentOperation.state !== "succeeded") {
      throw new Error(
        `Production deployment ${deploymentOperation.state ?? "failed"}; dev remains available for repair`,
      );
    }
    const verification = await control.call(
      "verifyApp",
      { appId: state.appId },
      {
        idempotencyKey: randomUUID(),
        timeoutMs: 120_000,
      },
    );
    output({ verification });
    const verificationOperation = await followDurableOperation(
      control,
      verification.operation.id,
    );
    const finalVerification = await control.call("getVerification", {
      appId: state.appId,
      verificationId: verification.verification.id,
    });
    output({ finalVerification });
    if (
      verificationOperation.state !== "succeeded" ||
      finalVerification.state !== "passed"
    ) {
      throw new Error(
        "Production verification failed; dev remains available for repair",
      );
    }
    const appValue = await control.call("getApp", {
      appId: state.appId,
    });
    const stopped = await control.call("stopDevSession", {
      appId: state.appId,
      sessionId: state.sessionId,
    });
    await rm(devStatePath(sourceRoot), { force: true });
    output({
      completed: true,
      appId: state.appId,
      liveUrl: appValue.appUrl ?? null,
      productionVerificationId: finalVerification.id,
      devStopped: stopped.status === "stopped",
      localStateRemoved: true,
    });
  });

dev
  .command("stop")
  .description("Destroy the preview artifacts, Function links, and dev schema")
  .argument("[directory]", "app source directory", ".")
  .action(async (directory) => {
    const sourceRoot = callerPath(directory);
    const state = await requireDevState(sourceRoot);
    const result = await client().call("stopDevSession", {
      appId: state.appId,
      sessionId: state.sessionId,
    });
    await rm(devStatePath(sourceRoot), { force: true });
    output({ session: result, localStateRemoved: true });
  });

app
  .command("request")
  .description(
    "Request an app path through the edge without printing the response body",
  )
  .argument("<app-id>")
  .argument("[path]", "same-origin app path", "/")
  .addOption(
    new Option("--method <method>", "HTTP method")
      .choices(["GET", "HEAD"])
      .default("GET"),
  )
  .action(async (appId, requestPath, options) => {
    const value = await client().get(`/v1/apps/${appId}`);
    const edgeUrl = process.env.OPENCLOUD_EDGE_URL;
    output(
      await requestApp(value, requestPath, {
        method: options.method as "GET" | "HEAD",
        ...(edgeUrl ? { edgeUrl } : {}),
      }),
    );
  });

app
  .command("verify")
  .description("Run the authoritative OpenCloud release verification gate")
  .argument("<app-id>")
  .option("--idempotency-key <key>")
  .option("--follow", "follow the durable verification operation", true)
  .option("--interval <seconds>", "poll interval", "2")
  .action(async (appId, options) => {
    const control = client();
    const started = (await control.call(
      "verifyApp",
      { appId },
      {
        idempotencyKey: options.idempotencyKey ?? randomUUID(),
        timeoutMs: 120_000,
      },
    )) as {
      verification?: { id?: string };
      operation?: { id?: string; state?: string };
    };
    output(started);
    if (!options.follow || !started.operation?.id) return;
    let operationValue: { state?: string } = started.operation;
    while (
      !["succeeded", "failed", "cancelled"].includes(operationValue.state ?? "")
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, Number(options.interval) * 1000),
      );
      operationValue = (await control.call("getOperation", {
        operationId: started.operation.id!,
      })) as { state?: string };
      output(operationValue);
    }
    if (started.verification?.id) {
      const result = await control.call("getVerification", {
        appId,
        verificationId: started.verification.id,
      });
      output(result);
      if (
        result &&
        typeof result === "object" &&
        "state" in result &&
        result.state !== "passed"
      ) {
        process.exitCode = 1;
      }
    }
  });

app
  .command("configure")
  .argument("<app-id>")
  .option("--name <name>")
  .option("--visibility <visibility>")
  .option("--idempotency-key <key>")
  .action(async (appId, options) => {
    const patch = Object.fromEntries(
      Object.entries({
        name: options.name,
        expiresInHours: Number(options.expiresInHours),
        visibility: options.visibility,
      }).filter(([, value]) => value !== undefined),
    );
    output(
      await client().patch(
        `/v1/apps/${appId}`,
        patch,
        options.idempotencyKey ?? randomUUID(),
      ),
    );
  });

app
  .command("credential-list")
  .argument("<app-id>")
  .action(async (appId) =>
    output(await client().get(`/v1/apps/${appId}/credentials`)),
  );

app
  .command("credential-revoke")
  .argument("<app-id>")
  .argument("<credential-id>")
  .action(async (appId, credentialId) =>
    output(
      await client().delete(`/v1/apps/${appId}/credentials/${credentialId}`),
    ),
  );

app
  .command("credential-create")
  .argument("<app-id>")
  .requiredOption("--name <name>")
  .option(
    "--scopes <scopes>",
    "comma-separated app scopes",
    "app:read,app:deploy,app:configure,app:observe,app:rollback,app:restart",
  )
  .action(async (appId, options) => {
    output(
      await client().post(`/v1/apps/${appId}/credentials`, {
        name: options.name,
        scopes: String(options.scopes)
          .split(",")
          .map((scope) => scope.trim()),
      }),
    );
  });

program
  .command("init")
  .description("Create a minimal app bundle")
  .argument("<directory>")
  .option("--app-id <uuid>", "defaults to the connected workspace app")
  .option("--version <version>", "initial deployment version", "v1")
  .action(async (directory, options) => {
    const root = callerPath(directory);
    const binding = loadWorkspaceBinding(resolveWorkspaceFile(undefined, root));
    const stored = availableSession();
    const appId =
      options.appId ??
      binding?.appId ??
      (stored?.state === "ready" ? stored.appId : undefined);
    if (!appId) {
      throw new Error(
        "Pass --app-id or run opencloud app connect <app-id> in the target directory.",
      );
    }
    await mkdir(path.join(root, "frontend"), { recursive: true });
    await mkdir(path.join(root, "migrations"), { recursive: true });
    await writeFile(
      path.join(root, "frontend", "index.html"),
      `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OpenCloud app</title>
  <link rel="icon" type="image/png" sizes="32x32" href="${OPEN_CLOUD_FAVICON_DATA_URI}">
  <style>
    body { margin: 0; padding: 3rem 1.5rem; color: #eaf4ff; background: #071019; font: 1rem/1.6 Inter, ui-sans-serif, system-ui, sans-serif; }
    main { width: min(40rem, 100%); margin: auto; }
    .opencloud-logo { display: block; width: 4rem; height: 4rem; object-fit: contain; }
    h1 { margin: 1.25rem 0 .5rem; }
    p { color: #a9bdcb; }
  </style>
  <main>
    <img class="opencloud-logo" src="${OPEN_CLOUD_LOGO_DATA_URI}" alt="" aria-hidden="true" width="64" height="64" decoding="async">
    <h1>Your OpenCloud app is running</h1>
    <p id="runtime-status" role="status">Connecting to the OpenCloud runtime…</p>
    <p>Edit frontend/index.html and deploy again with a new version.</p>
  </main>
  <script type="module">
    import { opencloud, OPEN_CLOUD_SDK_VERSION } from "/_opencloud/sdk.js";

    const app = await opencloud.app.info();
    document.querySelector("#runtime-status").textContent =
      "Connected to " + app.id + " with SDK " + OPEN_CLOUD_SDK_VERSION + ".";
  </script>
</html>
`,
      { flag: "wx" },
    );
    await writeFile(
      path.join(root, "opencloud.yaml"),
      YAML.stringify({
        schemaVersion: 2,
        appId,
        version: options.version,
        frontend: { directory: "frontend", spa: true },
        runtime: {
          sdk: {
            version: OPEN_CLOUD_SDK_VERSION,
          },
        },
        files: { access: "user", maxUploadBytes: 50 * 1024 * 1024 },
        migrations: [],
        functions: [],
        cron: [],
        health: { path: "/" },
        secrets: {},
      }),
      { flag: "wx" },
    );
    output({ directory: root, manifest: path.join(root, "opencloud.yaml") });
  });

program
  .command("deploy")
  .argument("<directory>")
  .option("--idempotency-key <key>")
  .action(async (directory, options) => {
    const sourceRoot = callerPath(directory);
    const bundle = await buildBundle(sourceRoot);
    printBundleFiles(bundle.files);
    printBundleWarnings(bundle.warnings);
    process.stderr.write(
      `Syncing ${bundle.manifest.version} (${bundle.sha256.slice(0, 12)})\n`,
    );
    const control = client();
    const draft = (await control.call("createDraft", {
      appId: bundle.manifest.appId,
      body: {
        name: `CLI ${bundle.manifest.version}`,
        cloneActive: false,
      },
    })) as { id?: string; revision?: number };
    if (!draft.id || !draft.revision) {
      throw new Error("Control plane did not return a source draft");
    }
    const changes = [];
    for (const file of bundle.files) {
      const content =
        file === "opencloud.json"
          ? Buffer.from(`${JSON.stringify(bundle.manifest, null, 2)}\n`)
          : await readFile(path.join(sourceRoot, ...file.split("/")));
      changes.push({
        path: file,
        contentBase64: content.toString("base64"),
      });
    }
    let revision = draft.revision;
    for (let offset = 0; offset < changes.length; offset += 200) {
      const applied = (await control.call("applyDraftChanges", {
        appId: bundle.manifest.appId,
        draftId: draft.id,
        body: {
          expectedRevision: revision,
          changes: changes.slice(offset, offset + 200),
        },
      })) as { draft?: { revision?: number } };
      revision = applied.draft?.revision ?? revision + 1;
    }
    const validation = (await control.call("validateDraft", {
      appId: bundle.manifest.appId,
      draftId: draft.id,
      body: {},
    })) as { passed?: boolean; artifactSha256?: string };
    if (!validation.passed) {
      output({ draft, validation });
      throw new Error("Authoritative server validation failed");
    }
    if (validation.artifactSha256 !== bundle.sha256) {
      throw new Error("Local and server canonical bundle digests do not match");
    }
    output(
      await control.call(
        "deployDraft",
        {
          appId: bundle.manifest.appId,
          draftId: draft.id,
        },
        {
          idempotencyKey: options.idempotencyKey ?? randomUUID(),
          timeoutMs: 120_000,
        },
      ),
    );
  });

program
  .command("validate")
  .description("Run local artifact validation without contacting OpenCloud")
  .argument("<directory>")
  .option("--write-archive <path>", "write the canonical .tgz artifact")
  .action(async (directory, options) => {
    const bundle = await buildBundle(callerPath(directory));
    const archivePath = options.writeArchive
      ? callerPath(String(options.writeArchive))
      : null;
    if (archivePath) await writeFile(archivePath, bundle.archive);
    output({
      valid: true,
      scope: "local-artifact",
      authoritative: false,
      appId: bundle.manifest.appId,
      version: bundle.manifest.version,
      artifactSha256: bundle.sha256,
      artifactBytes: bundle.archive.byteLength,
      migrations: bundle.manifest.migrations.length,
      functions: bundle.manifest.functions.length,
      cron: bundle.manifest.cron.filter((item) => item.enabled).length,
      secrets: bundle.manifest.secrets,
      files: bundle.files,
      warnings: bundle.warnings,
      archivePath,
      next: archivePath
        ? "Use app dev start/sync for authoritative server validation."
        : "Use --write-archive <path> to persist this artifact, or app dev start/sync for authoritative server validation.",
    });
  });

program
  .command("artifact-check")
  .description(
    "Run a fast local early-artifact check; this is not server validation",
  )
  .argument("<directory>")
  .option("--expect-app-id <uuid>")
  .option("--max-files <count>")
  .action(async (directory, options) => {
    const bundle = await buildBundle(callerPath(directory));
    if (options.expectAppId && bundle.manifest.appId !== options.expectAppId) {
      throw new Error(
        `Manifest appId ${bundle.manifest.appId} does not match ${options.expectAppId}`,
      );
    }
    const maxFiles =
      options.maxFiles === undefined ? undefined : Number(options.maxFiles);
    if (
      maxFiles !== undefined &&
      (!Number.isSafeInteger(maxFiles) || maxFiles < 2)
    ) {
      throw new Error("--max-files must be an integer of at least 2");
    }
    if (maxFiles !== undefined && bundle.files.length > maxFiles) {
      throw new Error(
        `Early checkpoint has ${bundle.files.length} files, above --max-files ${maxFiles}`,
      );
    }
    output({
      valid: true,
      checkpoint: "early-agent-artifact-v1",
      appId: bundle.manifest.appId,
      version: bundle.manifest.version,
      fileCount: bundle.files.length,
      artifactSha256: bundle.sha256,
      artifactBytes: bundle.archive.byteLength,
      files: bundle.files,
      warnings: bundle.warnings,
    });
  });

const operation = program
  .command("operation")
  .description("Inspect durable operations");

operation
  .command("get")
  .argument("<operation-id>")
  .option("--follow")
  .option("--interval <seconds>", "poll interval", "2")
  .action(async (operationId, options) => {
    do {
      const value = (await client().get(`/v1/operations/${operationId}`)) as {
        state?: string;
      };
      output(value);
      if (
        !options.follow ||
        ["succeeded", "failed", "cancelled"].includes(value.state ?? "")
      ) {
        break;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Number(options.interval) * 1000),
      );
    } while (true);
  });

const deployment = program
  .command("deployment")
  .description("Inspect and roll back releases");

deployment
  .command("list")
  .argument("<app-id>")
  .action(async (appId) =>
    output(await client().get(`/v1/apps/${appId}/deployments`)),
  );

deployment
  .command("get")
  .argument("<app-id>")
  .argument("<deployment-id>")
  .action(async (appId, deploymentId) =>
    output(await client().get(`/v1/apps/${appId}/deployments/${deploymentId}`)),
  );

deployment
  .command("rollback")
  .argument("<app-id>")
  .argument("<deployment-id>")
  .option("--idempotency-key <key>")
  .action(async (appId, deploymentId, options) =>
    output(
      await client().post(
        `/v1/apps/${appId}/deployments/${deploymentId}/rollback`,
        {},
        options.idempotencyKey ?? randomUUID(),
      ),
    ),
  );

const cron = program
  .command("cron")
  .description("Inspect durable cron invocation history");

cron
  .command("history")
  .argument("<app-id>")
  .option("--name <name>")
  .option("--state <state>", "running, succeeded, or failed")
  .option("--after <iso>", "only invocations started at or after this time")
  .option("--limit <number>", "result limit", "50")
  .action(async (appId, options) => {
    const query = new URLSearchParams({
      limit: String(Number(options.limit)),
      ...(options.name ? { name: String(options.name) } : {}),
      ...(options.state ? { state: String(options.state) } : {}),
      ...(options.after ? { after: String(options.after) } : {}),
    });
    output(await client().get(`/v1/apps/${appId}/cron/invocations?${query}`));
  });

cron
  .command("invoke")
  .description(
    "Trigger an enabled cron on the active deployment and record normal invocation history",
  )
  .argument("<app-id>")
  .argument("<cron-name>")
  .action(async (appId, cronName) => {
    output(
      await client().post(
        `/v1/apps/${appId}/cron/${encodeURIComponent(cronName)}/invoke`,
        {},
      ),
    );
  });

const secret = program
  .command("secret")
  .description("Manage app-scoped secrets");

secret
  .command("rotate")
  .description(
    "Rotate a manifest-generated secret without returning its value",
  )
  .argument("<app-id>")
  .argument("<name>")
  .option("--bytes <number>", "random byte count", "32")
  .option("--encoding <encoding>", "base64url or hex", "base64url")
  .action(async (appId, name, options) =>
    output(
      await client().call("generateSecret", {
        appId,
        name,
        body: {
          bytes: Number(options.bytes),
          encoding: options.encoding,
        },
      }),
    ),
  );

secret
  .command("configure")
  .description(
    "Create a one-time browser link for configuring a required or optional secret",
  )
  .argument("<app-id>")
  .argument("<name>")
  .action(async (appId, name) =>
    output(
      await client().call("createSecretEntryLink", {
        appId,
        name,
      }),
    ),
  );

secret
  .command("list")
  .argument("<app-id>")
  .action(async (appId) =>
    output(await client().get(`/v1/apps/${appId}/secrets`)),
  );

secret
  .command("delete")
  .argument("<app-id>")
  .argument("<name>")
  .action(async (appId, name) =>
    output(
      await client().delete(
        `/v1/apps/${appId}/secrets/${encodeURIComponent(name)}`,
      ),
    ),
  );

const backup = program.command("backup").description("Manage app backups");

backup
  .command("list")
  .argument("<app-id>")
  .action(async (appId) =>
    output(await client().get(`/v1/apps/${appId}/backups`)),
  );

backup
  .command("create")
  .argument("<app-id>")
  .option("--idempotency-key <key>")
  .action(async (appId, options) =>
    output(
      await client().post(
        `/v1/apps/${appId}/backups`,
        {},
        options.idempotencyKey ?? randomUUID(),
      ),
    ),
  );

backup
  .command("restore")
  .argument("<app-id>")
  .argument("<backup-id>")
  .option("--idempotency-key <key>")
  .action(async (appId, backupId, options) =>
    output(
      await client().post(
        `/v1/apps/${appId}/backups/${backupId}/restore`,
        {},
        options.idempotencyKey ?? randomUUID(),
      ),
    ),
  );

backup
  .command("schedule")
  .argument("<app-id>")
  .argument("<schedule>", "none, daily, or weekly")
  .action(async (appId, schedule) =>
    output(
      await client().put(`/v1/apps/${appId}/backups/schedule`, { schedule }),
    ),
  );

program
  .command("logs")
  .argument("<app-id>")
  .option(
    "--from <iso>",
    "ISO time",
    new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  )
  .option("--to <iso>", "ISO time", new Date().toISOString())
  .option("--contains <text>")
  .option("--level <level>")
  .option("--limit <number>", "result limit", "200")
  .action(async (appId, options) =>
    output(
      await client().post(`/v1/apps/${appId}/logs/query`, {
        from: options.from,
        to: options.to,
        contains: options.contains,
        level: options.level,
        limit: Number(options.limit),
      }),
    ),
  );

program
  .command("metrics")
  .argument("<app-id>")
  .requiredOption("--metric <name>")
  .option(
    "--from <iso>",
    "ISO time",
    new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  )
  .option("--to <iso>", "ISO time", new Date().toISOString())
  .option("--aggregation <name>", "none, sum, avg, max, min, rate", "none")
  .option("--step <seconds>", "query step", "60")
  .action(async (appId, options) =>
    output(
      await client().post(`/v1/apps/${appId}/metrics/query`, {
        metric: options.metric,
        from: options.from,
        to: options.to,
        aggregation: options.aggregation,
        stepSeconds: Number(options.step),
        filters: {},
        groupBy: [],
      }),
    ),
  );

program
  .command("usage")
  .argument("<app-id>")
  .action(async (appId) =>
    output(await client().get(`/v1/apps/${appId}/usage`)),
  );

program
  .command("agent-feed")
  .description("Read the stable app health and alert contract for agents")
  .argument("<app-id>")
  .option("--since <iso>", "return events and resolved alerts after this time")
  .action(async (appId, options) => {
    const query = options.since
      ? `?since=${encodeURIComponent(String(options.since))}`
      : "";
    output(await client().get(`/v1/apps/${appId}/agent-feed${query}`));
  });

const alertRule = program
  .command("alert-rule")
  .description("Manage app-scoped custom metric alert rules");

alertRule
  .command("list")
  .argument("<app-id>")
  .action(async (appId) =>
    output(await client().get(`/v1/apps/${appId}/alert-rules`)),
  );

alertRule
  .command("put")
  .argument("<app-id>")
  .argument("<rule-id>")
  .requiredOption("--name <name>", "human-readable alert name")
  .requiredOption("--metric <metric>", "declared custom metric")
  .addOption(
    new Option("--aggregation <aggregation>")
      .choices(["sum", "rate", "latest", "min", "max", "avg"])
      .makeOptionMandatory(),
  )
  .addOption(
    new Option("--operator <operator>")
      .choices(["gt", "gte", "lt", "lte", "eq"])
      .makeOptionMandatory(),
  )
  .requiredOption("--threshold <number>")
  .addOption(
    new Option("--window <window>")
      .choices(["5m", "15m", "1h", "24h"])
      .makeOptionMandatory(),
  )
  .option("--minimum-samples <number>", "minimum points before evaluation", "1")
  .addOption(
    new Option("--severity <severity>")
      .choices(["info", "warning", "critical"])
      .default("warning"),
  )
  .option("--disabled", "create the rule in a disabled state")
  .action(async (appId, ruleId, options) =>
    output(
      await client().put(`/v1/apps/${appId}/alert-rules/${ruleId}`, {
        name: options.name,
        metric: options.metric,
        aggregation: options.aggregation,
        operator: options.operator,
        threshold: Number(options.threshold),
        window: options.window,
        minimumSamples: Number(options.minimumSamples),
        severity: options.severity,
        enabled: options.disabled !== true,
      }),
    ),
  );

alertRule
  .command("delete")
  .argument("<app-id>")
  .argument("<rule-id>")
  .action(async (appId, ruleId) =>
    output(await client().delete(`/v1/apps/${appId}/alert-rules/${ruleId}`)),
  );

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
