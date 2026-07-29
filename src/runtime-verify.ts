import { createHash, randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";
import YAML from "yaml";
import { z } from "zod";
import type {
  OpenCloudManifest,
  StorageAuthorization,
} from "@opencloud/contracts";
import type { OpenCloudClient } from "./api-client.js";
import { EdgeTransport } from "./edge-transport.js";

const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const responseField = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
const logicalName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

const dataVerificationSchema = z
  .object({
    mode: z.enum(["owner", "shared"]).default("owner"),
    table: identifier,
    ownerColumn: identifier.optional(),
    markerColumn: identifier,
    insert: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const runtimeVerificationSchema = z
  .object({
    schemaVersion: z.literal(1),
    data: dataVerificationSchema,
    storage: z
      .object({
        authorization: z.enum(["app", "owner-prefix"]).optional(),
        objectPrefix: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,120}$/)
          .default("opencloud-verify"),
      })
      .strict()
      .default({
        objectPrefix: "opencloud-verify",
      }),
    realtime: z
      .object({
        topic: logicalName,
      })
      .strict(),
    function: z
      .object({
        name: logicalName,
        secretName: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
        digestField: responseField.default("secretDigest"),
        presentField: responseField.default("secretPresent"),
      })
      .strict(),
    cron: z
      .object({
        name: logicalName,
        timeoutSeconds: z.coerce.number().int().min(10).max(300).default(120),
      })
      .strict(),
  })
  .strict();

type RuntimeVerificationInput = z.infer<typeof runtimeVerificationSchema>;

export interface RuntimeVerificationSpec
  extends Omit<RuntimeVerificationInput, "data" | "storage"> {
  data: RuntimeVerificationInput["data"] & {
    ownerColumn?: string;
  };
  storage: {
    authorization: StorageAuthorization;
    objectPrefix: string;
  };
  manifest: {
    version: string;
    storageAuthorization: StorageAuthorization;
  };
}

interface RuntimeApp {
  id: string;
  slug: string;
  visibility: "public" | "private";
  state: string;
  activeDeploymentId: string | null;
  appUrl: string;
  authUrl: string;
  apiUrl: string;
}

interface VerificationUser {
  email: string;
  password: string;
}

interface UserSession {
  cookie: string;
  accessToken: string;
  userId: string;
}

interface AppConfig {
  appId: string;
  supabaseAnonKey: string;
  storageBucket: string;
}

interface JoinedChannel {
  socket: WebSocket;
  topic: string;
  joinRef: string;
  status: string | undefined;
}

const runtimeAppSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  visibility: z.enum(["public", "private"]),
  state: z.string(),
  activeDeploymentId: z.uuid().nullable(),
  appUrl: z.url(),
  authUrl: z.url(),
  apiUrl: z.url(),
});

const appConfigSchema = z.object({
  appId: z.uuid(),
  supabaseAnonKey: z.string().min(1),
  storageBucket: z.string().min(1),
});

const appSessionSchema = z.object({
  userId: z.uuid(),
  accessToken: z.string().min(1),
});

const cronInvocationSchema = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  deploymentId: z.uuid(),
  cronName: z.string(),
  functionName: z.string(),
  state: z.enum(["running", "succeeded", "failed"]),
  scheduledAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  responseStatus: z.number().int().nullable(),
  error: z.record(z.string(), z.unknown()).nullable(),
});

function assert(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function containsValue(value: unknown, target: string): boolean {
  if (value === target) return true;
  if (Array.isArray(value)) {
    return value.some((item) => containsValue(item, target));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsValue(item, target));
  }
  return false;
}

function verificationUsers(
  environment: NodeJS.ProcessEnv = process.env,
): { first: VerificationUser; second: VerificationUser } {
  const names = [
    "OPENCLOUD_VERIFY_USER_A_EMAIL",
    "OPENCLOUD_VERIFY_USER_A_PASSWORD",
    "OPENCLOUD_VERIFY_USER_B_EMAIL",
    "OPENCLOUD_VERIFY_USER_B_PASSWORD",
  ] as const;
  const missing = names.filter((name) => !environment[name]);
  if (missing.length) {
    throw new Error(
      `Runtime verification requires environment variables: ${missing.join(", ")}`,
    );
  }
  return {
    first: {
      email: environment.OPENCLOUD_VERIFY_USER_A_EMAIL!,
      password: environment.OPENCLOUD_VERIFY_USER_A_PASSWORD!,
    },
    second: {
      email: environment.OPENCLOUD_VERIFY_USER_B_EMAIL!,
      password: environment.OPENCLOUD_VERIFY_USER_B_PASSWORD!,
    },
  };
}

async function login(
  transport: EdgeTransport,
  app: RuntimeApp,
  user: VerificationUser,
): Promise<UserSession> {
  const response = await transport.request(app.authUrl, "/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  assert(response.ok, `Central login returned HTTP ${response.status}`);
  const rawCookies = response.headers["set-cookie"];
  const rawCookie = Array.isArray(rawCookies) ? rawCookies[0] : rawCookies;
  const cookie = rawCookie?.match(/(?:^|;\s*)(oc_session=[^;]+)/)?.[1];
  assert(cookie, "Central login did not return an opaque broker session");

  const sessionResponse = await transport.request(
    app.appUrl,
    "/_opencloud/session",
    { headers: { cookie } },
  );
  assert(
    sessionResponse.ok,
    `App session returned HTTP ${sessionResponse.status}`,
  );
  const session = appSessionSchema.parse(sessionResponse.value);
  return {
    cookie,
    accessToken: session.accessToken,
    userId: session.userId,
  };
}

async function config(
  transport: EdgeTransport,
  app: RuntimeApp,
  cookie: string,
): Promise<AppConfig> {
  const response = await transport.request(
    app.appUrl,
    "/_opencloud/config",
    { headers: { cookie } },
  );
  assert(response.ok, `App config returned HTTP ${response.status}`);
  return appConfigSchema.parse(response.value);
}

function userHeaders(
  configValue: AppConfig,
  session: UserSession,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    apikey: configValue.supabaseAnonKey,
    authorization: `Bearer ${session.accessToken}`,
    cookie: session.cookie,
    ...extra,
  };
}

async function establishSessions(
  transport: EdgeTransport,
  app: RuntimeApp,
): Promise<{
  first: UserSession;
  second: UserSession;
  config: AppConfig;
  redirectStatus: number;
}> {
  const anonymous = await transport.request(app.appUrl, "/");
  if (app.visibility === "private") {
    assert(
      anonymous.status === 302,
      `Private app anonymous request returned HTTP ${anonymous.status}, expected 302`,
    );
    const location = String(anonymous.headers.location ?? "");
    assert(
      location.startsWith(app.authUrl),
      "Private app redirect did not target the canonical auth origin",
    );
  }

  const users = verificationUsers();
  const first = await login(transport, app, users.first);
  const second = await login(transport, app, users.second);
  assert(first.userId !== second.userId, "Verification users are not distinct");
  const configValue = await config(transport, app, first.cookie);
  assert(configValue.appId === app.id, "Runtime config returned the wrong app ID");
  return {
    first,
    second,
    config: configValue,
    redirectStatus: anonymous.status,
  };
}

export function parseRuntimeVerificationSpec(
  source: string,
  manifest: OpenCloudManifest,
): RuntimeVerificationSpec {
  const input = runtimeVerificationSchema.parse(YAML.parse(source));
  const ownerColumn =
    input.data.ownerColumn ??
    (input.data.mode === "owner" ? "owner_id" : undefined);
  const requestedAuthorization = input.storage.authorization;
  if (
    requestedAuthorization &&
    requestedAuthorization !== manifest.storage.authorization
  ) {
    throw new Error(
      `Verification storage.authorization is ${requestedAuthorization}, but the app manifest declares ${manifest.storage.authorization}`,
    );
  }
  const verifiedFunction = manifest.functions.find(
    (definition) => definition.name === input.function.name,
  );
  if (!verifiedFunction) {
    throw new Error(
      `Verification function ${input.function.name} is not declared in the app manifest`,
    );
  }
  if (!verifiedFunction.verifyJwt) {
    throw new Error(
      `Verification function ${input.function.name} must declare verifyJwt: true`,
    );
  }
  if (!manifest.requiredSecrets.includes(input.function.secretName)) {
    throw new Error(
      `Verification secret ${input.function.secretName} is not declared in requiredSecrets`,
    );
  }
  const verifiedCron = manifest.cron.find(
    (definition) => definition.name === input.cron.name,
  );
  if (!verifiedCron) {
    throw new Error(
      `Verification cron ${input.cron.name} is not declared in the app manifest`,
    );
  }
  if (!verifiedCron.enabled) {
    throw new Error(`Verification cron ${input.cron.name} is disabled`);
  }
  const { ownerColumn: _inputOwnerColumn, ...data } = input.data;
  return {
    ...input,
    data: {
      ...data,
      ...(ownerColumn ? { ownerColumn } : {}),
    },
    storage: {
      authorization: manifest.storage.authorization,
      objectPrefix: input.storage.objectPrefix,
    },
    manifest: {
      version: manifest.version,
      storageAuthorization: manifest.storage.authorization,
    },
  };
}

export async function verifySessions(
  rawApp: unknown,
  options: { edgeUrl?: string } = {},
): Promise<Record<string, unknown>> {
  const app = runtimeAppSchema.parse(rawApp);
  const transport = new EdgeTransport(options.edgeUrl);
  const sessions = await establishSessions(transport, app);
  return {
    passed: true,
    appId: app.id,
    appUrl: app.appUrl,
    authUrl: app.authUrl,
    apiUrl: app.apiUrl,
    privateRedirect:
      app.visibility === "private"
        ? { status: sessions.redirectStatus, target: app.authUrl }
        : { status: sessions.redirectStatus, target: null },
    users: [
      { label: "A", userId: sessions.first.userId, session: "established" },
      { label: "B", userId: sessions.second.userId, session: "established" },
    ],
  };
}

async function verifyData(
  transport: EdgeTransport,
  app: RuntimeApp,
  configValue: AppConfig,
  sessions: { first: UserSession; second: UserSession },
  spec: RuntimeVerificationSpec["data"],
  marker: string,
): Promise<Record<string, unknown>> {
  const firstMarker = `verify-a-${marker}`;
  const secondMarker = `verify-b-${marker}`;
  const baseInsert = { ...spec.insert };
  if (spec.ownerColumn) delete baseInsert[spec.ownerColumn];
  delete baseInsert[spec.markerColumn];

  const insert = async (session: UserSession, value: string) => {
    const response = await transport.request(
      app.appUrl,
      `/rest/v1/${spec.table}`,
      {
        method: "POST",
        headers: userHeaders(configValue, session, {
          "content-type": "application/json",
          prefer: "return=representation",
        }),
        body: JSON.stringify({
          ...baseInsert,
          [spec.markerColumn]: value,
        }),
      },
    );
    assert(response.ok, `RLS fixture insert returned HTTP ${response.status}`);
    const rows = z.array(z.record(z.string(), z.unknown())).parse(response.value);
    const row = rows[0];
    assert(row && typeof row.id === "string", "RLS insert returned no row ID");
    if (spec.ownerColumn) {
      assert(
        row[spec.ownerColumn] === session.userId,
        "auth.uid() did not populate the expected owner",
      );
    }
    return row;
  };

  const firstRow = await insert(sessions.first, firstMarker);
  const secondRow = await insert(sessions.second, secondMarker);
  const select = ["id", spec.ownerColumn, spec.markerColumn]
    .filter((value): value is string => Boolean(value))
    .join(",");
  const read = async (session: UserSession) => {
    const response = await transport.request(
      app.appUrl,
      `/rest/v1/${spec.table}?select=${encodeURIComponent(select)}`,
      { headers: userHeaders(configValue, session) },
    );
    assert(response.ok, `RLS fixture read returned HTTP ${response.status}`);
    return z.array(z.record(z.string(), z.unknown())).parse(response.value);
  };
  const firstRows = await read(sessions.first);
  const secondRows = await read(sessions.second);
  if (spec.mode === "owner") {
    assert(
      firstRows.some((row) => row[spec.markerColumn] === firstMarker) &&
        !firstRows.some((row) => row[spec.markerColumn] === secondMarker),
      "User A did not see exactly its own verification row",
    );
    assert(
      secondRows.some((row) => row[spec.markerColumn] === secondMarker) &&
        !secondRows.some((row) => row[spec.markerColumn] === firstMarker),
      "User B did not see exactly its own verification row",
    );
    assert(spec.ownerColumn, "Owner-mode verification needs ownerColumn");
    const forged = await transport.request(
      app.appUrl,
      `/rest/v1/${spec.table}`,
      {
        method: "POST",
        headers: userHeaders(configValue, sessions.first, {
          "content-type": "application/json",
          prefer: "return=representation",
        }),
        body: JSON.stringify({
          ...baseInsert,
          [spec.markerColumn]: `verify-forged-${marker}`,
          [spec.ownerColumn]: sessions.second.userId,
        }),
      },
    );
    assert(!forged.ok, "RLS accepted an explicitly forged owner value");
  } else {
    for (const [label, rows] of [
      ["A", firstRows],
      ["B", secondRows],
    ] as const) {
      assert(
        rows.some((row) => row[spec.markerColumn] === firstMarker) &&
          rows.some((row) => row[spec.markerColumn] === secondMarker),
        `User ${label} did not see both shared verification rows`,
      );
    }
  }

  const remove = async (session: UserSession, id: unknown) => {
    const response = await transport.request(
      app.appUrl,
      `/rest/v1/${spec.table}?id=eq.${encodeURIComponent(String(id))}`,
      {
        method: "DELETE",
        headers: userHeaders(configValue, session),
      },
    );
    assert(response.ok, `RLS fixture cleanup returned HTTP ${response.status}`);
  };
  await remove(sessions.first, firstRow.id);
  await remove(
    spec.mode === "shared" ? sessions.first : sessions.second,
    secondRow.id,
  );
  return {
    status: "passed",
    mode: spec.mode,
    detail:
      spec.mode === "owner"
        ? "Two users saw only their own rows and forged ownership was denied."
        : "Two admitted users both saw the shared verification fixtures.",
  };
}

export async function verifyStorage(
  transport: EdgeTransport,
  app: RuntimeApp,
  configValue: AppConfig,
  sessions: { first: UserSession; second: UserSession },
  spec: RuntimeVerificationSpec["storage"],
  marker: string,
): Promise<Record<string, unknown>> {
  const objectName =
    spec.authorization === "owner-prefix"
      ? `${sessions.first.userId}/${spec.objectPrefix}/${marker}.txt`
      : `${spec.objectPrefix}/${marker}.txt`;
  const encodedName = objectName.split("/").map(encodeURIComponent).join("/");
  const path = `/storage/v1/object/${encodeURIComponent(
    configValue.storageBucket,
  )}/${encodedName}`;
  const payload = `OpenCloud verification ${marker}`;
  const upload = await transport.request(app.appUrl, path, {
    method: "POST",
    headers: userHeaders(configValue, sessions.first, {
      "content-type": "text/plain",
      "x-upsert": "true",
    }),
    body: payload,
  });
  assert(upload.ok, `Storage upload returned HTTP ${upload.status}`);

  const ownerRead = await transport.request(app.appUrl, path, {
    headers: userHeaders(configValue, sessions.first),
  });
  assert(
    ownerRead.ok && ownerRead.body === payload,
    `Storage owner read returned HTTP ${ownerRead.status}`,
  );

  const crossUserRead = await transport.request(app.appUrl, path, {
    headers: userHeaders(configValue, sessions.second),
  });
  if (spec.authorization === "owner-prefix") {
    assert(
      !crossUserRead.ok,
      "A second authenticated user read another user's Storage prefix",
    );
  } else {
    assert(
      crossUserRead.ok && crossUserRead.body === payload,
      `Storage app-scoped read returned HTTP ${crossUserRead.status}`,
    );
  }

  const anonymous = await transport.request(app.appUrl, path, {
    headers: {
      apikey: configValue.supabaseAnonKey,
      authorization: `Bearer ${configValue.supabaseAnonKey}`,
      cookie: sessions.first.cookie,
    },
  });
  assert(!anonymous.ok, "Anonymous JWT read a private Storage object");

  if (spec.authorization === "owner-prefix") {
    const forgedName =
      `${sessions.second.userId}/${spec.objectPrefix}/${marker}-forged.txt`
        .split("/")
        .map(encodeURIComponent)
        .join("/");
    const forged = await transport.request(
      app.appUrl,
      `/storage/v1/object/${encodeURIComponent(
        configValue.storageBucket,
      )}/${forgedName}`,
      {
        method: "POST",
        headers: userHeaders(configValue, sessions.first, {
          "content-type": "text/plain",
        }),
        body: "forbidden",
      },
    );
    assert(
      !forged.ok,
      "A user wrote into another user's Storage prefix",
    );
  }

  const foreignBucket =
    "app-00000000-0000-0000-0000-000000000000";
  const foreign = await transport.request(
    app.appUrl,
    `/storage/v1/object/${foreignBucket}/opencloud-verify/forbidden.txt`,
    {
      method: "POST",
      headers: userHeaders(configValue, sessions.first, {
        "content-type": "text/plain",
      }),
      body: "forbidden",
    },
  );
  assert(!foreign.ok, "Authenticated user wrote outside the app Storage bucket");

  const remove = await transport.request(app.appUrl, path, {
    method: "DELETE",
    headers: userHeaders(configValue, sessions.first),
  });
  assert(remove.ok, `Storage cleanup returned HTTP ${remove.status}`);
  return {
    status: "passed",
    detail:
      spec.authorization === "owner-prefix"
        ? "Owner-prefixed upload/read/delete passed; cross-user read/write, anonymous read, and foreign-bucket write were denied."
        : "App-scoped authenticated upload/read/delete passed; anonymous read and foreign-bucket write were denied.",
  };
}

function joinRealtime(
  transport: EdgeTransport,
  app: RuntimeApp,
  configValue: AppConfig,
  session: UserSession,
  channelName: string,
): Promise<JoinedChannel> {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({
      apikey: configValue.supabaseAnonKey,
      vsn: "1.0.0",
    });
    const socket = transport.webSocket(
      app.appUrl,
      `/realtime/v1/websocket?${query}`,
      { cookie: session.cookie },
    );
    const ref = `${Date.now()}-${Math.random()}`;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Realtime join timed out for ${channelName}`));
    }, 15_000);
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          topic: `realtime:${channelName}`,
          event: "phx_join",
          payload: {
            config: {
              private: true,
              broadcast: { ack: true, self: true },
              presence: { enabled: false },
              postgres_changes: [],
            },
            access_token: session.accessToken,
          },
          ref,
          join_ref: ref,
        }),
      );
    });
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as {
        event?: string;
        ref?: string;
        payload?: { status?: string };
      };
      if (message.event !== "phx_reply" || message.ref !== ref) return;
      clearTimeout(timeout);
      resolve({
        socket,
        topic: `realtime:${channelName}`,
        joinRef: ref,
        status: message.payload?.status,
      });
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      reject(new Error(`Realtime socket failed for ${channelName}`));
    });
  });
}

async function verifyRealtime(
  transport: EdgeTransport,
  app: RuntimeApp,
  configValue: AppConfig,
  sessions: { first: UserSession; second: UserSession },
  spec: RuntimeVerificationSpec["realtime"],
  marker: string,
): Promise<Record<string, unknown>> {
  const channelName = `app:${app.id}:${spec.topic}`;
  const first = await joinRealtime(
    transport,
    app,
    configValue,
    sessions.first,
    channelName,
  );
  const second = await joinRealtime(
    transport,
    app,
    configValue,
    sessions.second,
    channelName,
  );
  let foreign: JoinedChannel | undefined;
  try {
    assert(
      first.status === "ok" && second.status === "ok",
      "Granted users could not join the private app channel",
    );
    const received = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Realtime broadcast was not delivered")),
        15_000,
      );
      second.socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as {
          event?: string;
          payload?: { event?: string; payload?: { marker?: string } };
        };
        if (
          message.event === "broadcast" &&
          message.payload?.event === "opencloud-verify" &&
          message.payload.payload?.marker === marker
        ) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    first.socket.send(
      JSON.stringify({
        topic: first.topic,
        event: "broadcast",
        payload: {
          type: "broadcast",
          event: "opencloud-verify",
          payload: { marker },
        },
        ref: `${Date.now()}-broadcast`,
        join_ref: first.joinRef,
      }),
    );
    await received;

    foreign = await joinRealtime(
      transport,
      app,
      configValue,
      sessions.first,
      `app:00000000-0000-0000-0000-000000000000:${spec.topic}`,
    );
    assert(foreign.status !== "ok", "User joined a foreign private app topic");
  } finally {
    first.socket.close();
    second.socket.close();
    foreign?.socket.close();
  }
  return {
    status: "passed",
    detail:
      "Two granted users exchanged a private broadcast and a foreign-app topic was denied.",
  };
}

async function verifyFunction(
  transport: EdgeTransport,
  client: OpenCloudClient,
  app: RuntimeApp,
  configValue: AppConfig,
  session: UserSession,
  spec: RuntimeVerificationSpec["function"],
): Promise<Record<string, unknown>> {
  const functionPath = `/functions/v1/${spec.name}`;
  const anonymous = await transport.request(app.appUrl, functionPath, {
    method: "POST",
    headers: {
      apikey: configValue.supabaseAnonKey,
      authorization: `Bearer ${configValue.supabaseAnonKey}`,
      cookie: session.cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ verification: true }),
  });
  assert(
    anonymous.status === 401,
    `JWT-protected function returned HTTP ${anonymous.status} for the anonymous JWT`,
  );

  const invoke = async (secret: string) => {
    await client.put(
      `/v1/apps/${app.id}/secrets/${encodeURIComponent(spec.secretName)}`,
      { value: secret },
    );
    const response = await transport.request(app.appUrl, functionPath, {
      method: "POST",
      headers: userHeaders(configValue, session, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ verification: true }),
    });
    assert(
      response.ok,
      `Authenticated function returned HTTP ${response.status}`,
    );
    const value = z.record(z.string(), z.unknown()).parse(response.value);
    const digest = createHash("sha256").update(secret).digest("hex");
    assert(
      value[spec.presentField] === true &&
        value[spec.digestField] === digest,
      "Function did not return the expected one-way secret marker",
    );
    assert(
      !containsValue(value, secret),
      "Function response exposed a plaintext verification secret",
    );
    return digest;
  };

  const firstSecret = randomBytes(32).toString("base64url");
  const firstDigest = await invoke(firstSecret);
  const secondSecret = randomBytes(32).toString("base64url");
  const secondDigest = await invoke(secondSecret);
  assert(firstDigest !== secondDigest, "Secret rotation did not change the digest");

  const listed = await client.get(`/v1/apps/${app.id}/secrets`);
  assert(
    JSON.stringify(listed).includes(spec.secretName) &&
      !containsValue(listed, firstSecret) &&
      !containsValue(listed, secondSecret),
    "Secret metadata was missing or exposed plaintext",
  );
  return {
    status: "passed",
    detail:
      "Anonymous JWT was rejected; authenticated execution and secret rotation passed without plaintext disclosure.",
  };
}

async function verifyCron(
  client: OpenCloudClient,
  app: RuntimeApp,
  spec: RuntimeVerificationSpec["cron"],
): Promise<Record<string, unknown>> {
  const startedAt = new Date();
  const trigger = z
    .object({
      accepted: z.literal(true),
      jobId: z.string().min(1),
      cronName: z.string(),
      functionName: z.string(),
    })
    .parse(
      await client.post(
        `/v1/apps/${app.id}/cron/${encodeURIComponent(spec.name)}/invoke`,
        {},
      ),
    );
  const deadline = Date.now() + spec.timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    const query = new URLSearchParams({
      name: spec.name,
      state: "succeeded",
      after: startedAt.toISOString(),
      limit: "20",
    });
    const raw = await client.get(
      `/v1/apps/${app.id}/cron/invocations?${query}`,
    );
    const invocations = z.array(cronInvocationSchema).parse(raw);
    const invocation = invocations[0];
    if (invocation) {
      return {
        status: "passed",
        detail:
          "The active cron was triggered deterministically and a fresh successful invocation was read from structured history.",
        jobId: trigger.jobId,
        invocationId: invocation.id,
        startedAt: invocation.startedAt,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `No successful ${spec.name} invocation appeared in structured cron history`,
  );
}

export async function verifyRuntime(
  client: OpenCloudClient,
  rawApp: unknown,
  spec: RuntimeVerificationSpec,
  options: { edgeUrl?: string } = {},
): Promise<Record<string, unknown>> {
  const app = runtimeAppSchema.parse(rawApp);
  assert(app.state === "active", `App state is ${app.state}, expected active`);
  assert(app.activeDeploymentId, "App has no active deployment");
  const marker = randomUUID().slice(0, 12);
  const transport = new EdgeTransport(options.edgeUrl);
  const sessions = await establishSessions(transport, app);
  const scopedSessions = {
    first: sessions.first,
    second: sessions.second,
  };

  const results: Record<string, unknown>[] = [
    {
      name: "canonical origins and sessions",
      status: "passed",
      detail:
        "Canonical origins resolved; private redirect and two brokered user sessions passed.",
    },
    {
      name: "two-user RLS",
      ...(await verifyData(
        transport,
        app,
        sessions.config,
        scopedSessions,
        spec.data,
        marker,
      )),
    },
    {
      name: "authenticated Storage",
      ...(await verifyStorage(
        transport,
        app,
        sessions.config,
        scopedSessions,
        spec.storage,
        marker,
      )),
    },
    {
      name: "private Realtime",
      ...(await verifyRealtime(
        transport,
        app,
        sessions.config,
        scopedSessions,
        spec.realtime,
        marker,
      )),
    },
    {
      name: "function authentication and secret rotation",
      ...(await verifyFunction(
        transport,
        client,
        app,
        sessions.config,
        sessions.first,
        spec.function,
      )),
    },
    {
      name: "structured cron history",
      ...(await verifyCron(client, app, spec.cron)),
    },
  ];

  const now = new Date();
  const logs = await client.post(`/v1/apps/${app.id}/logs/query`, {
    from: new Date(now.getTime() - 15 * 60_000).toISOString(),
    to: now.toISOString(),
    limit: 50,
  });
  const usage = await client.get(`/v1/apps/${app.id}/usage`);
  results.push({
    name: "scoped observability",
    status: "passed",
    detail: `Logs query succeeded; usage returned ${
      Array.isArray(usage) ? usage.length : 0
    } rollup row(s).`,
    logsReturned: Array.isArray(logs) ? logs.length : undefined,
  });

  return {
    passed: true,
    appId: app.id,
    deploymentId: app.activeDeploymentId,
    contract: spec.manifest,
    appUrl: app.appUrl,
    authUrl: app.authUrl,
    apiUrl: app.apiUrl,
    adapterUsed: Boolean(options.edgeUrl),
    results,
  };
}
