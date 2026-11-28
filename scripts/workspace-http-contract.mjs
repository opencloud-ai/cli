import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cliConfigDirectory } from "./cli-config-directory.mjs";

const binary = path.resolve(import.meta.dirname, "../dist/index.cjs");
const temporary = await mkdtemp(path.join(os.tmpdir(), "opencloud-workspace-contract-"));
const accountAccess = "synthetic-account-access";
const accountRefresh = "synthetic-account-refresh";
const later = new Date(Date.now() + 15 * 60 * 1_000).toISOString();
const userId = "00000000-0000-4000-8000-000000000002";
const wsA = "11111111-1111-4111-8111-111111111111";
const wsB = "22222222-2222-4222-8222-222222222222";
const wsUnknown = "33333333-3333-4333-8333-333333333333";
const appAId = "aaaa1111-1111-4111-8111-111111111111";
const appBId = "bbbb2222-2222-4222-8222-222222222222";
const importId = "cccc3333-3333-4333-8333-333333333333";
const stamp = "2026-11-27T15:00:00.000Z";

const user = {
  id: userId,
  email: "ada@example.test",
  displayName: "Ada Lovelace",
};

const workspaces = [
  {
    organisation: { id: wsA, name: "Alpha Free", status: "active", policyVersion: "1", plan: "free" },
    membership: { organisationId: wsA, workspaceId: wsA, userId, role: "admin" },
    capabilities: { manageOrganisation: true, inviteMembers: true, manageLimits: true, leaveOrganisation: false },
  },
  {
    organisation: { id: wsB, name: "Beta Core", status: "active", policyVersion: "2", plan: "core" },
    membership: { organisationId: wsB, workspaceId: wsB, userId, role: "member" },
    capabilities: { manageOrganisation: false, inviteMembers: false, manageLimits: false, leaveOrganisation: true },
  },
];

const appRecord = (id, name, organisationId) => ({
  id,
  identityStatus: "assigned",
  name,
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  appUrl: `https://${name.toLowerCase().replace(/\s+/g, "-")}.example.test`,
  authUrl: "https://auth.example.test",
  apiUrl: "https://api.example.test",
  visibility: "private",
  aiCredentialSource: "owner",
  state: "active",
  ownerUserId: userId,
  organisationId,
  desiredDeploymentId: null,
  activeDeploymentId: null,
  createdAt: stamp,
  updatedAt: stamp,
});

const operation = (appId, key) => ({
  id: "dddd4444-4444-4444-8444-444444444444",
  appId,
  deploymentId: null,
  type: "provision_app",
  state: "queued",
  actorType: "cli_account",
  actorId: userId,
  idempotencyKey: key,
  error: null,
  createdAt: stamp,
  updatedAt: stamp,
});

const requests = [];
let workspacesMode = "canonical";

const server = createServer(async (request, response) => {
  if (request.url === "/v1/platform-errors/reports") return response.writeHead(202).end();
  const send = (status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = text ? JSON.parse(text) : undefined;
  requests.push({ method: request.method, url: request.url, body });

  if (request.method === "GET" && request.url === "/v1/auth/identity") {
    return send(200, { user, credential: { kind: "account_login", appId: null, expiresAt: later } });
  }
  if (request.method === "GET" && request.url === "/v1/workspaces") {
    if (workspacesMode === "legacy404" || workspacesMode === "all404") {
      return send(404, { message: "Cannot GET /v1/workspaces" });
    }
    if (workspacesMode === "forbidden") {
      return send(403, { message: "Forbidden" });
    }
    return send(200, workspaces);
  }
  if (request.method === "GET" && request.url === "/v1/organisations") {
    if (workspacesMode === "all404") {
      return send(404, { message: "Cannot GET /v1/organisations" });
    }
    return send(200, workspaces);
  }
  if (request.method === "GET" && request.url === "/v1/apps") {
    return send(200, [
      appRecord(appAId, "Alpha Notes", wsA),
      appRecord(appBId, "Beta Planner", wsB),
    ]);
  }
  if (request.method === "POST" && request.url === "/v1/apps") {
    const targetWorkspaceId = body?.workspaceId ?? body?.organisationId;
    if (!targetWorkspaceId) {
      return send(409, {
        code: "WORKSPACE_REQUIRED",
        message: "This account belongs to 2 workspaces. Ask which one to use, then send its ID as workspaceId.",
        details: {
          choices: [
            { id: wsA, name: "Alpha Free", plan: "free", role: "admin" },
            { id: wsB, name: "Beta Core", plan: "core", role: "member" },
          ],
        },
      });
    }
    const createdId = targetWorkspaceId === wsB ? appBId : appAId;
    return send(201, {
      app: appRecord(createdId, body.name, targetWorkspaceId),
      operation: operation(createdId, request.headers["idempotency-key"]),
    });
  }
  if (request.method === "POST" && request.url === `/v1/app-imports/${importId}/install`) {
    return send(200, {
      id: importId,
      name: body.name,
      sha256: "a".repeat(64),
      bytes: 1024,
      state: "ready",
      tables: 0,
      rows: 0,
      files: 0,
      identities: [],
      installerIdentities: [],
      identityMappings: body.identityMappings ?? {},
      requirements: { capabilities: [], integrations: [], secrets: [] },
      appId: appBId,
      draftId: "eeee5555-5555-4555-8555-555555555555",
      expiresAt: later,
      error: null,
    });
  }
  const parsedUrl = new URL(request.url, "http://127.0.0.1");
  const computePrice = {
    id: "ffff6666-6666-4666-8666-666666666666",
    version: 1,
    key: "standard",
    currency: "usd",
    taxBehavior: "exclusive",
    quantumSeconds: 1,
    minimumSeconds: 1,
    ratesMinorPerUnit: { vcpu_second: "0.00001", gib_memory_second: "0.000002", gib_scratch_second: "0" },
    effectiveFrom: stamp,
    state: "published",
    publishedAt: stamp,
  };
  const computeUsage = {
    quantities: { vcpuSeconds: "0", memoryGiBSeconds: "0", scratchGiBSeconds: "0" },
    currency: null,
    grossEstimatedCostMinor: null,
    appliedCreditMinor: null,
    netEstimatedCostMinor: null,
    priceVersionIds: [],
    pendingEvidenceCount: 0,
    lastSettledAt: null,
    observedAt: stamp,
  };
  if (
    request.method === "GET" &&
    (parsedUrl.pathname === "/v1/billing/compute" ||
      parsedUrl.pathname === "/v1/billing/compute/prices" ||
      parsedUrl.pathname === "/v1/billing/compute/usage")
  ) {
    const workspaceId = parsedUrl.searchParams.get("workspaceId");
    if (!workspaceId) {
      return send(409, {
        code: "WORKSPACE_REQUIRED",
        message: "This account belongs to 2 workspaces. Ask which one to use, then send its ID as workspaceId.",
        details: {
          choices: [
            { id: wsA, name: "Alpha Free", plan: "free", role: "admin" },
            { id: wsB, name: "Beta Core", plan: "core", role: "member" },
          ],
        },
      });
    }
    if (parsedUrl.pathname === "/v1/billing/compute/prices") {
      return send(200, { prices: [computePrice] });
    }
    if (parsedUrl.pathname === "/v1/billing/compute") {
      return send(200, {
        payerId: workspaceId,
        enabled: true,
        mode: "workspace_plan",
        currency: "usd",
        priceVersionId: computePrice.id,
        price: computePrice,
        nextPriceVersionId: null,
        nextEffectiveAt: null,
        monthlyLimitMinor: null,
        dailyLimitMinor: null,
        activeInstanceLimit: 4,
        dailyTransferBytes: "10737418240",
        subscriptionState: "active",
        consentedAt: stamp,
        updatedAt: stamp,
      });
    }
    return send(200, {
      payerId: workspaceId,
      from: parsedUrl.searchParams.get("from"),
      to: parsedUrl.searchParams.get("to"),
      production: computeUsage,
      development: computeUsage,
      reservedMinor: "0",
      availableCreditMinor: "0",
    });
  }
  return send(404, { message: `Unhandled ${request.method} ${request.url}` });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;

const home = path.join(temporary, "home");
const configHome = path.join(temporary, "config");
const credentials = path.join(cliConfigDirectory({ home, configHome }), "credentials");
await mkdir(credentials, { recursive: true, mode: 0o700 });
await mkdir(home, { recursive: true });
const accountName = `account-${createHash("sha256").update(apiUrl).digest("hex")}`;
await writeFile(
  path.join(credentials, `${accountName}.json`),
  `${JSON.stringify({
    schemaVersion: 1,
    kind: "account",
    apiUrl,
    issuer: apiUrl,
    tokenEndpoint: `${apiUrl}/oauth/token`,
    revocationEndpoint: `${apiUrl}/oauth/revoke`,
    accessToken: accountAccess,
    accessExpiresAt: later,
    refreshToken: accountRefresh,
    refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  })}\n`,
  { mode: 0o600 },
);

async function run(args, { status = 0, workspaceEnv } = {}) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, OPENCLOUD_TELEMETRY: "0" };
  for (const key of [
    "INIT_CWD",
    "OPENCLOUD_API_URL",
    "OPENCLOUD_TOKEN",
    "OPENCLOUD_SESSION_FILE",
    "OPENCLOUD_WORKSPACE_FILE",
    "OPENCLOUD_WORKSPACE",
    "DO_NOT_TRACK",
  ]) {
    delete env[key];
  }
  if (workspaceEnv !== undefined) env.OPENCLOUD_WORKSPACE = workspaceEnv;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, "--api-url", apiUrl, ...args], {
      cwd: temporary,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, status, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse((status === 0 ? result.stdout : result.stderr).trim());
}

try {
  // 1. workspace list reads /v1/workspaces and reports unpinned state
  const listed = await run(["workspace", "list"]);
  assert.equal(listed.pinned, null);
  assert.equal(listed.workspaces.length, 2);
  assert.equal(listed.workspaces[0].id, wsA);
  assert.equal(listed.workspaces[1].plan, "core");

  // 2. app create & compute settings without workspace surface 409 WORKSPACE_REQUIRED with choices and hint
  const conflict = await run(
    ["app", "create", "--name", "Ambiguous", "--idempotency-key", "ws-create-0001"],
    { status: 1 },
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "WORKSPACE_REQUIRED");
  assert.equal(conflict.error.details.choices.length, 2);
  assert.equal(conflict.error.details.choices[1].id, wsB);
  assert.match(conflict.error.hint, /opencloud workspace list/);

  const computeConflict = await run(["compute", "settings"], { status: 1 });
  assert.equal(computeConflict.ok, false);
  assert.equal(computeConflict.error.code, "WORKSPACE_REQUIRED");
  assert.equal(computeConflict.error.details.choices.length, 2);
  assert.match(computeConflict.error.hint, /opencloud workspace list/);

  // 3. app list unpinned returns apps from all workspaces
  const allApps = await run(["app", "list"]);
  assert.deepEqual(allApps.map((a) => a.id), [appAId, appBId]);

  // 4. OPENCLOUD_WORKSPACE pins workspace by default for app list, app create, whoami, and auth status
  const envApps = await run(["app", "list"], { workspaceEnv: wsB });
  assert.deepEqual(envApps.map((a) => a.id), [appBId]);

  const envAllApps = await run(["app", "list", "--all-workspaces"], { workspaceEnv: wsB });
  assert.deepEqual(envAllApps.map((a) => a.id), [appAId, appBId]);

  const flagOverrideApps = await run(["app", "list", "--workspace", wsA], { workspaceEnv: wsB });
  assert.deepEqual(flagOverrideApps.map((a) => a.id), [appAId]);

  const topLevelFlagApps = await run(["--workspace", wsA, "app", "list"], { workspaceEnv: wsB });
  assert.deepEqual(topLevelFlagApps.map((a) => a.id), [appAId]);

  const conflictingFlags = await run(["app", "list", "--workspace", wsA, "--all-workspaces"], { status: 1 });
  assert.equal(conflictingFlags.error.code, "INVALID_OPTIONS");

  const createdWithEnv = await run(
    ["app", "create", "--name", "Sandbox App", "--idempotency-key", "ws-create-0002"],
    { workspaceEnv: wsB },
  );
  assert.equal(createdWithEnv.app.organisationId, wsB);
  const envCreateReq = requests.filter((r) => r.method === "POST" && r.url === "/v1/apps").at(-1);
  assert.equal(envCreateReq.body.organisationId, wsB);
  assert.equal("workspaceId" in envCreateReq.body, false, "app create must send organisationId for backward compatibility");

  const createdWithFlag = await run(
    ["app", "create", "--name", "Flag App", "--workspace", wsA, "--idempotency-key", "ws-create-0003"],
    { workspaceEnv: wsB },
  );
  assert.equal(createdWithFlag.app.organisationId, wsA);
  const flagCreateReq = requests.filter((r) => r.method === "POST" && r.url === "/v1/apps").at(-1);
  assert.equal(flagCreateReq.body.organisationId, wsA);
  assert.equal("workspaceId" in flagCreateReq.body, false);

  // Non-RFC UUID rejected cleanly as INVALID_OPTION (not unwrapped Zod CLI_ERROR)
  const nonRfcUuid = "11111111-1111-0111-0111-111111111111";
  const badCreateUuid = await run(
    ["app", "create", "--name", "Bad UUID", "--workspace", nonRfcUuid, "--idempotency-key", "ws-create-0004"],
    { status: 1 },
  );
  assert.equal(badCreateUuid.error.code, "INVALID_OPTION");
  const badImportUuid = await run(
    ["app", "import", "install", importId, "--name", "Bad UUID", "--workspace", nonRfcUuid, "--idempotency-key", "ws-import-bad-uuid"],
    { status: 1 },
  );
  assert.equal(badImportUuid.error.code, "INVALID_OPTION");

  const whoamiPinned = await run(["whoami"], { workspaceEnv: wsB });
  assert.deepEqual(whoamiPinned.defaultWorkspace, {
    workspaceId: wsB,
    source: "env:OPENCLOUD_WORKSPACE",
  });

  const statusPinned = await run(["auth", "status"], { workspaceEnv: wsB });
  assert.deepEqual(statusPinned.defaultWorkspace, {
    workspaceId: wsB,
    source: "env:OPENCLOUD_WORKSPACE",
  });

  // 5. workspace use validates membership, persists per-apiUrl default, and applies to create + import install
  const unknownUse = await run(["workspace", "use", wsUnknown], { status: 1 });
  assert.equal(unknownUse.error.code, "WORKSPACE_NOT_FOUND");
  assert.equal(unknownUse.error.details.choices.length, 2);

  const pinned = await run(["workspace", "use", wsA]);
  assert.equal(pinned.state, "pinned");
  assert.equal(pinned.workspaceId, wsA);
  assert.equal(pinned.verified, true);
  assert.equal(pinned.name, "Alpha Free");

  const currentConfig = await run(["workspace", "current"]);
  assert.equal(currentConfig.pinned.workspaceId, wsA);
  assert.equal(currentConfig.pinned.source, "config");
  assert.equal(currentConfig.pinned.name, "Alpha Free");
  assert.equal(currentConfig.environmentOverride, false);

  // Env var overrides saved config cleanly
  const currentEnvOverride = await run(["workspace", "current"], { workspaceEnv: wsB });
  assert.equal(currentEnvOverride.pinned.workspaceId, wsB);
  assert.equal(currentEnvOverride.pinned.source, "env:OPENCLOUD_WORKSPACE");
  assert.equal(currentEnvOverride.savedDefault.workspaceId, wsA);
  assert.equal(currentEnvOverride.environmentOverride, true);

  // Explicit --workspace flag beats env var and sets environmentOverride: false
  const currentFlagOverride = await run(["--workspace", wsUnknown, "workspace", "current"], {
    workspaceEnv: wsB,
  });
  assert.equal(currentFlagOverride.pinned.workspaceId, wsUnknown);
  assert.equal(currentFlagOverride.pinned.source, "flag");
  assert.equal(currentFlagOverride.savedDefault.workspaceId, wsA);
  assert.equal(currentFlagOverride.environmentOverride, false);

  // app import install forwards pinned workspaceId and lets --workspace override env
  await run(["app", "import", "install", importId, "--name", "Imported", "--idempotency-key", "ws-import-0001"], {
    workspaceEnv: wsB,
  });
  const installEnvReq = requests.filter((r) => r.url === `/v1/app-imports/${importId}/install`).at(-1);
  assert.equal(installEnvReq.body.workspaceId, wsB);

  await run(
    ["app", "import", "install", importId, "--name", "Imported Flag", "--workspace", wsA, "--idempotency-key", "ws-import-0002"],
    { workspaceEnv: wsB },
  );
  const installFlagReq = requests.filter((r) => r.url === `/v1/app-imports/${importId}/install`).at(-1);
  assert.equal(installFlagReq.body.workspaceId, wsA);

  // compute settings/prices/usage honor saved workspace use, OPENCLOUD_WORKSPACE, and --workspace
  const computeSavedSettings = await run(["compute", "settings"]);
  assert.equal(computeSavedSettings.payerId, wsA);
  const computeEnvSettings = await run(["compute", "settings"], { workspaceEnv: wsB });
  assert.equal(computeEnvSettings.payerId, wsB);
  const computeFlagPrices = await run(["compute", "prices", "--workspace", wsA], { workspaceEnv: wsB });
  assert.equal(computeFlagPrices.prices.length, 1);
  assert.equal(requests.at(-1).url, `/v1/billing/compute/prices?workspaceId=${wsA}`);
  const computeTopFlagUsage = await run(
    ["--workspace", wsB, "compute", "usage", "--from", "2026-11-27T00:00:00Z", "--to", "2026-11-28T00:00:00Z"],
  );
  assert.equal(computeTopFlagUsage.payerId, wsB);

  // 6. Invalid OPENCLOUD_WORKSPACE never crashes discovery/status/config commands
  const invalidStatus = await run(["auth", "status"], { workspaceEnv: "not-a-uuid" });
  assert.equal(invalidStatus.defaultWorkspace.state, "invalid");
  assert.equal(invalidStatus.defaultWorkspace.source, "env:OPENCLOUD_WORKSPACE");

  const invalidWhoami = await run(["whoami"], { workspaceEnv: "not-a-uuid" });
  assert.equal(invalidWhoami.defaultWorkspace.state, "invalid");
  assert.equal(invalidWhoami.defaultWorkspace.source, "env:OPENCLOUD_WORKSPACE");

  const invalidList = await run(["workspace", "list"], { workspaceEnv: "not-a-uuid" });
  assert.equal(invalidList.workspaces.length, 2);
  assert.equal(invalidList.pinned.state, "invalid");
  assert.equal(invalidList.pinned.source, "env:OPENCLOUD_WORKSPACE");

  const invalidCurrent = await run(["workspace", "current"], { workspaceEnv: "not-a-uuid" });
  assert.equal(invalidCurrent.pinned.state, "invalid");
  assert.equal(invalidCurrent.savedDefault.workspaceId, wsA);
  assert.equal(invalidCurrent.environmentOverride, false);

  const validFlagDespiteBadEnv = await run(["--workspace", wsA, "workspace", "current"], {
    workspaceEnv: "not-a-uuid",
  });
  assert.equal(validFlagDespiteBadEnv.pinned.workspaceId, wsA);
  assert.equal(validFlagDespiteBadEnv.pinned.source, "flag");
  assert.equal(validFlagDespiteBadEnv.environmentOverride, false);

  const useWithBadEnv = await run(["workspace", "use", wsB], { workspaceEnv: "not-a-uuid" });
  assert.equal(useWithBadEnv.state, "pinned");
  assert.equal(useWithBadEnv.workspaceId, wsB);
  assert.equal(useWithBadEnv.invalidEnvironmentVariable.name, "OPENCLOUD_WORKSPACE");
  assert.match(useWithBadEnv.note, /OPENCLOUD_WORKSPACE/);

  const clearWithBadEnv = await run(["workspace", "clear"], { workspaceEnv: "not-a-uuid" });
  assert.equal(clearWithBadEnv.state, "cleared");
  assert.equal(clearWithBadEnv.cleared, true);
  assert.equal(clearWithBadEnv.previousWorkspaceId, wsB);
  assert.equal(clearWithBadEnv.invalidEnvironmentVariable.name, "OPENCLOUD_WORKSPACE");
  assert.match(clearWithBadEnv.note, /OPENCLOUD_WORKSPACE/);

  const currentAfterClear = await run(["workspace", "current"]);
  assert.equal(currentAfterClear.pinned, null);

  // 7. Fallback to /v1/organisations on 404 and unverified workspace use on 403/404
  workspacesMode = "legacy404";
  const legacyList = await run(["workspace", "list"]);
  assert.equal(legacyList.workspaces.length, 2);
  assert.ok(requests.some((r) => r.method === "GET" && r.url === "/v1/organisations"));

  workspacesMode = "forbidden";
  const unverifiedForbidden = await run(["workspace", "use", wsA]);
  assert.equal(unverifiedForbidden.state, "pinned");
  assert.equal(unverifiedForbidden.verified, false);
  assert.equal(unverifiedForbidden.workspaceId, wsA);

  workspacesMode = "all404";
  const unverifiedNotFound = await run(["workspace", "use", wsB]);
  assert.equal(unverifiedNotFound.state, "pinned");
  assert.equal(unverifiedNotFound.verified, false);
  assert.equal(unverifiedNotFound.workspaceId, wsB);

  const clearedFinal = await run(["workspace", "clear"]);
  assert.equal(clearedFinal.cleared, true);
  assert.equal(clearedFinal.previousWorkspaceId, wsB);

  process.stdout.write("Workspace HTTP contract verified.\n");
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
