#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "commander";
import YAML from "yaml";
import { OPEN_CLOUD_JS_VERSION } from "@opencloud/js";
import type { AgentOnboardingResponse } from "@opencloud/contracts";
import { OpenCloudClient } from "./api-client.js";
import { requestApp, smokeApp } from "./app-edge.js";
import { buildBundle } from "./bundle.js";
import {
  parseRuntimeVerificationSpec,
  verifyRuntime,
  verifySessions,
} from "./runtime-verify.js";
import { verifyAppUi } from "./ui-verify.js";
import {
  loadSession,
  resolveSessionFile,
  saveSession,
  type OpenCloudSession,
} from "./session-store.js";

const program = new Command()
  .name("opencloud")
  .description("Agent- and human-facing client for the OpenCloud control plane")
  .version("0.2.1", "-V, --cli-version", "print the CLI version")
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
  );

function sessionFile(): string {
  return resolveSessionFile(
    program.opts<{ sessionFile?: string }>().sessionFile,
  );
}

function availableSession(): OpenCloudSession | null {
  return loadSession(sessionFile());
}

function client(): OpenCloudClient {
  const options = program.opts<{
    apiUrl?: string;
    token?: string;
  }>();
  const stored =
    options.apiUrl && options.token ? null : availableSession();
  const apiUrl = options.apiUrl ?? stored?.apiUrl;
  const token =
    options.token ?? (stored?.state === "ready" ? stored.token : undefined);
  if (!apiUrl || !token) {
    throw new Error(
      stored?.state === "awaiting_email_verification"
        ? "Email verification is still pending. Run opencloud onboard-complete after confirming the email."
        : stored?.state === "starting"
          ? "Onboarding has not completed. Re-run the same opencloud onboard command."
        : "Run opencloud onboard, set OPENCLOUD_API_URL and OPENCLOUD_TOKEN, or pass --api-url and --token.",
    );
  }
  return new OpenCloudClient({
    apiUrl,
    token,
  });
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
      next: "The app-scoped credential is stored locally. Continue with app list, app get, init, validate, and deploy; do not print the session file.",
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
      next: "Ask the user to confirm the email, then run opencloud onboard-complete. Do not print the session file.",
    };
  }
  return {
    ...safe,
    credential: null,
    sessionFile: file,
    next: "Email verification is still pending. Run opencloud onboard-complete after the user confirms.",
  };
}

program
  .command("onboard")
  .description(
    "Create a passwordless OpenCloud identity and automatically addressed project",
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
      (stored?.state === "starting"
        ? stored.idempotencyKey
        : randomUUID());
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
    output(
      await persistOnboardingResponse(
        response,
        apiUrl,
        file,
      ),
    );
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
    output(
      await persistOnboardingResponse(
        response,
        stored.apiUrl,
        file,
      ),
    );
  });

const app = program.command("app").description("Manage OpenCloud apps");

app
  .command("create")
  .requiredOption("--name <name>")
  .option("--expires-in-hours <hours>", "credential lifetime, max 168", "24")
  .requiredOption("--slug <slug>")
  .requiredOption("--owner-user-id <uuid>")
  .option("--visibility <visibility>", "public or private", "private")
  .option("--idempotency-key <key>")
  .action(async (options) => {
    output(
      await client().post(
        "/v1/apps",
        {
          name: options.name,
          slug: options.slug,
          ownerUserId: options.ownerUserId,
          visibility: options.visibility,
        },
        options.idempotencyKey ?? randomUUID(),
      ),
    );
  });

app.command("list").action(async () => output(await client().get("/v1/apps")));

app
  .command("get")
  .argument("<app-id>")
  .action(async (appId) => output(await client().get(`/v1/apps/${appId}`)));

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
      javascriptSdkVersion?: string;
    };
    if (
      !deployment.id ||
      !deployment.version ||
      !deployment.javascriptSdkVersion
    ) {
      throw new Error(
        "The active deployment does not expose a JavaScript SDK pin",
      );
    }
    output({
      appId,
      deploymentId: deployment.id,
      deploymentVersion: deployment.version,
      javascriptSdk: {
        package: "@opencloud/js",
        version: deployment.javascriptSdkVersion,
        module:
          `/_opencloud/sdk/js/v${deployment.javascriptSdkVersion}/index.js`,
        types:
          `/_opencloud/sdk/js/v${deployment.javascriptSdkVersion}/index.d.ts`,
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
  .command("smoke")
  .description("Check the active deployment and canonical edge behavior")
  .argument("<app-id>")
  .action(async (appId) => {
    const value = await client().get(`/v1/apps/${appId}`);
    const edgeUrl = process.env.OPENCLOUD_EDGE_URL;
    const result = await smokeApp(
      value,
      edgeUrl ? { edgeUrl } : {},
    );
    output(result);
    if (!result.passed) process.exitCode = 1;
  });

app
  .command("verify-ui")
  .description(
    "Load the canonical app in Chromium and verify render, session, SDK, console, and network behavior",
  )
  .argument("<app-id>")
  .option("--timeout-seconds <seconds>", "navigation timeout", "30")
  .option(
    "--require-interaction",
    "require view-transition and state-assertion UI coverage",
  )
  .option(
    "--chromium-path <path>",
    "Chromium executable; defaults to Playwright's installed browser",
  )
  .action(async (appId, options) => {
    const timeoutSeconds = Number(options.timeoutSeconds);
    if (
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds < 5 ||
      timeoutSeconds > 120
    ) {
      throw new Error("--timeout-seconds must be between 5 and 120");
    }
    const value = await client().get(`/v1/apps/${appId}`);
    output(
      await verifyAppUi(value, {
        timeoutMs: timeoutSeconds * 1_000,
        requireInteraction: options.requireInteraction === true,
        ...((options.chromiumPath ?? process.env.OPENCLOUD_CHROMIUM_PATH)
          ? {
              chromiumPath:
                options.chromiumPath ?? process.env.OPENCLOUD_CHROMIUM_PATH,
            }
          : {}),
      }),
    );
  });

app
  .command("configure")
  .argument("<app-id>")
  .option("--name <name>")
  .option("--slug <slug>")
  .option("--visibility <visibility>")
  .option("--idempotency-key <key>")
  .action(async (appId, options) => {
    const patch = Object.fromEntries(
      Object.entries({
        name: options.name,
        expiresInHours: Number(options.expiresInHours),
        slug: options.slug,
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
      await client().delete(
        `/v1/apps/${appId}/credentials/${credentialId}`,
      ),
    ),
  );

for (const action of ["archive", "unarchive", "restart"] as const) {
  app
    .command(action)
    .argument("<app-id>")
    .option("--idempotency-key <key>")
    .action(async (appId, options) =>
      output(
        await client().post(
          `/v1/apps/${appId}/${action}`,
          {},
          options.idempotencyKey ?? randomUUID(),
        ),
      ),
    );
}

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
  .option("--app-id <uuid>", "defaults to the onboarded project")
  .option("--version <version>", "initial deployment version", "v1")
  .action(async (directory, options) => {
    const stored = availableSession();
    const appId =
      options.appId ??
      (stored?.state === "ready" ? stored.appId : undefined);
    if (!appId) {
      throw new Error(
        "Pass --app-id or complete opencloud onboard first",
      );
    }
    const root = callerPath(directory);
    await mkdir(path.join(root, "frontend"), { recursive: true });
    await mkdir(path.join(root, "migrations"), { recursive: true });
    await writeFile(
      path.join(root, "frontend", "index.html"),
      `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OpenCloud app</title>
  <main>
    <h1>Your OpenCloud app is running</h1>
    <p>Edit frontend/index.html and deploy again with a new version.</p>
  </main>
</html>
`,
      { flag: "wx" },
    );
    await writeFile(
      path.join(root, "opencloud.yaml"),
      YAML.stringify({
        schemaVersion: 1,
        appId,
        version: options.version,
        frontend: { directory: "frontend", spa: true },
        runtime: {
          javascriptSdk: {
            version: OPEN_CLOUD_JS_VERSION,
          },
        },
        storage: { authorization: "app" },
        migrations: [],
        functions: [],
        cron: [],
        health: { path: "/" },
        requiredSecrets: [],
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
    const bundle = await buildBundle(callerPath(directory));
    printBundleFiles(bundle.files);
    process.stderr.write(
      `Uploading ${bundle.manifest.version} (${bundle.sha256.slice(0, 12)})\n`,
    );
    output(
      await client().uploadDeployment(
        bundle.manifest.appId,
        bundle.manifest,
        bundle.archive,
        options.idempotencyKey ?? randomUUID(),
      ),
    );
  });

program
  .command("validate")
  .description("Validate and package an app without contacting OpenCloud")
  .argument("<directory>")
  .action(async (directory) => {
    const bundle = await buildBundle(callerPath(directory));
    output({
      valid: true,
      appId: bundle.manifest.appId,
      version: bundle.manifest.version,
      artifactSha256: bundle.sha256,
      artifactBytes: bundle.archive.byteLength,
      migrations: bundle.manifest.migrations.length,
      functions: bundle.manifest.functions.length,
      cron: bundle.manifest.cron.filter((item) => item.enabled).length,
      requiredSecrets: bundle.manifest.requiredSecrets,
      files: bundle.files,
    });
  });

program
  .command("artifact-check")
  .description(
    "Validate an early agent artifact and enforce its expected app and file count",
  )
  .argument("<directory>")
  .option("--expect-app-id <uuid>")
  .option("--max-files <count>")
  .action(async (directory, options) => {
    const bundle = await buildBundle(callerPath(directory));
    if (
      options.expectAppId &&
      bundle.manifest.appId !== options.expectAppId
    ) {
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
      const value = (await client().get(
        `/v1/operations/${operationId}`,
      )) as { state?: string };
      output(value);
      if (!options.follow || ["succeeded", "failed", "cancelled"].includes(value.state ?? "")) {
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
    output(
      await client().get(
        `/v1/apps/${appId}/deployments/${deploymentId}`,
      ),
    ),
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

const session = program
  .command("session")
  .description("Verify brokered app sessions without printing credentials");

session
  .command("verify")
  .argument("<app-id>")
  .action(async (appId) => {
    const control = client();
    const value = await control.get(`/v1/apps/${appId}`);
    const edgeUrl = process.env.OPENCLOUD_EDGE_URL;
    output(
      await verifySessions(
        value,
        edgeUrl ? { edgeUrl } : {},
      ),
    );
  });

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
    output(
      await client().get(
        `/v1/apps/${appId}/cron/invocations?${query}`,
      ),
    );
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

program
  .command("verify")
  .description(
    "Run two-user runtime verification from an opencloud.verify.yaml contract",
  )
  .argument("<app-id>")
  .argument("<verification-file>")
  .action(async (appId, verificationFile) => {
    const control = client();
    const appValue = await control.get(`/v1/apps/${appId}`);
    const verificationPath = callerPath(verificationFile);
    const source = await readFile(verificationPath, "utf8");
    const bundle = await buildBundle(path.dirname(verificationPath));
    if (bundle.manifest.appId !== appId) {
      throw new Error(
        `Verification manifest appId ${bundle.manifest.appId} does not match ${appId}`,
      );
    }
    const spec = parseRuntimeVerificationSpec(source, bundle.manifest);
    const edgeUrl = process.env.OPENCLOUD_EDGE_URL;
    output(
      await verifyRuntime(
        control,
        appValue,
        spec,
        edgeUrl ? { edgeUrl } : {},
      ),
    );
  });

const secret = program.command("secret").description("Manage app-scoped secrets");

secret
  .command("set")
  .argument("<app-id>")
  .argument("<name>")
  .option("--value <value>", "secret value; prefer OPENCLOUD_SECRET_VALUE")
  .action(async (appId, name, options) => {
    const value = options.value ?? process.env.OPENCLOUD_SECRET_VALUE;
    if (!value) {
      throw new Error(
        "Pass --value or set OPENCLOUD_SECRET_VALUE (preferred for shell history)",
      );
    }
    output(
      await client().put(
        `/v1/apps/${appId}/secrets/${encodeURIComponent(name)}`,
        { value },
      ),
    );
  });

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
  .option("--from <iso>", "ISO time", new Date(Date.now() - 60 * 60 * 1000).toISOString())
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
  .option("--from <iso>", "ISO time", new Date(Date.now() - 60 * 60 * 1000).toISOString())
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

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
