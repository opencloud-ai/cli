import { spawn } from "node:child_process";
import {
  CredentialStore,
  type AccountCredential,
  type StoredCredential,
} from "./credential-store.js";

export const OPEN_CLOUD_CLI_CLIENT_ID = "opencloud-cli";
export const DEVICE_AUTHORIZATION_GRANT =
  "urn:ietf:params:oauth:grant-type:device_code";
export const DEFAULT_API_URL = "https://api.opencloud.ai";

interface OAuthResourceMetadata {
  resource: string;
  authorization_servers: string[];
}

interface OAuthAuthorizationMetadata {
  issuer: string;
  token_endpoint: string;
  device_authorization_endpoint: string;
  revocation_endpoint: string;
}

export interface DeviceAuthorization {
  apiUrl: string;
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  deviceCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: string;
  intervalSeconds: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in: number;
  token_type: string;
  scope: string;
  resource: string;
}

export function normalizeApiUrl(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error("OpenCloud API URL must use HTTPS or HTTP for local testing");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("OpenCloud API URL cannot contain credentials, query, or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

export async function beginDeviceAuthorization(
  apiUrl: string,
  request: typeof fetch = fetch,
): Promise<DeviceAuthorization> {
  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  const resource = await requestJson<OAuthResourceMetadata>(
    `${normalizedApiUrl}/.well-known/oauth-protected-resource/api`,
    request,
  );
  const issuer = resource.authorization_servers?.[0];
  if (!issuer || resource.resource !== normalizedApiUrl) {
    throw new Error("OpenCloud returned invalid API authorization metadata");
  }
  const authorization = await requestJson<OAuthAuthorizationMetadata>(
    `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`,
    request,
  );
  if (
    authorization.issuer !== issuer ||
    !authorization.token_endpoint ||
    !authorization.device_authorization_endpoint ||
    !authorization.revocation_endpoint
  ) {
    throw new Error("OpenCloud returned incomplete authorization metadata");
  }
  const response = await postForm(
    authorization.device_authorization_endpoint,
    {
      client_id: OPEN_CLOUD_CLI_CLIENT_ID,
      scope: "openid profile cli:account",
      resource: normalizedApiUrl,
    },
    request,
  );
  if (!response.ok) throw await responseError(response, "start CLI login");
  const value = (await response.json()) as Record<string, unknown>;
  if (
    typeof value.device_code !== "string" ||
    typeof value.verification_uri !== "string" ||
    typeof value.verification_uri_complete !== "string" ||
    typeof value.expires_in !== "number" ||
    typeof value.interval !== "number"
  ) {
    throw new Error("OpenCloud returned an invalid device authorization");
  }
  return {
    apiUrl: normalizedApiUrl,
    issuer,
    tokenEndpoint: authorization.token_endpoint,
    revocationEndpoint: authorization.revocation_endpoint,
    deviceCode: value.device_code,
    verificationUri: value.verification_uri,
    verificationUriComplete: value.verification_uri_complete,
    expiresAt: new Date(Date.now() + value.expires_in * 1_000).toISOString(),
    intervalSeconds: Math.max(1, value.interval),
  };
}

export async function completeDeviceAuthorization(
  authorization: DeviceAuthorization,
  request: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<AccountCredential> {
  let intervalSeconds = authorization.intervalSeconds;
  while (Date.now() < Date.parse(authorization.expiresAt)) {
    const response = await postForm(
      authorization.tokenEndpoint,
      {
        grant_type: DEVICE_AUTHORIZATION_GRANT,
        device_code: authorization.deviceCode,
        client_id: OPEN_CLOUD_CLI_CLIENT_ID,
      },
      request,
    );
    if (response.ok) {
      return accountCredential(
        authorization,
        parseTokenResponse(await response.json()),
      );
    }
    const error = await oauthError(response);
    if (error.code === "authorization_pending") {
      await wait(intervalSeconds * 1_000);
      continue;
    }
    if (error.code === "slow_down") {
      intervalSeconds += 5;
      await wait(intervalSeconds * 1_000);
      continue;
    }
    if (error.code === "access_denied") {
      throw new Error("OpenCloud CLI login was cancelled in the browser");
    }
    if (error.code === "expired_token") {
      throw new Error("OpenCloud CLI login expired; run opencloud login again");
    }
    throw new Error(`OpenCloud CLI login failed: ${error.message}`);
  }
  throw new Error("OpenCloud CLI login expired; run opencloud login again");
}

export async function freshAccountCredential(
  store: CredentialStore,
  apiUrl: string,
  request: typeof fetch = fetch,
): Promise<StoredCredential<AccountCredential>> {
  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  const stored = await store.loadAccount(normalizedApiUrl);
  if (!stored) {
    throw new Error("No OpenCloud account login was found. Run opencloud login.");
  }
  if (Date.parse(stored.credential.refreshExpiresAt) <= Date.now()) {
    throw new Error("OpenCloud account login expired. Run opencloud login again.");
  }
  if (Date.parse(stored.credential.accessExpiresAt) > Date.now() + 60_000) {
    return stored;
  }
  const response = await postForm(
    stored.credential.tokenEndpoint,
    {
      grant_type: "refresh_token",
      refresh_token: stored.credential.refreshToken,
      client_id: OPEN_CLOUD_CLI_CLIENT_ID,
    },
    request,
  );
  if (!response.ok) {
    const error = await oauthError(response);
    throw new Error(
      error.code === "invalid_grant"
        ? "OpenCloud account login expired or was revoked. Run opencloud login again."
        : `Could not refresh OpenCloud login: ${error.message}`,
    );
  }
  const refreshed = accountCredential(
    {
      apiUrl: stored.credential.apiUrl,
      issuer: stored.credential.issuer,
      tokenEndpoint: stored.credential.tokenEndpoint,
      revocationEndpoint: stored.credential.revocationEndpoint,
    },
    parseTokenResponse(await response.json()),
  );
  return store.saveAccount(refreshed);
}

export async function revokeAccountCredential(
  credential: AccountCredential,
  request: typeof fetch = fetch,
): Promise<void> {
  const response = await postForm(
    credential.revocationEndpoint,
    {
      token: credential.refreshToken,
      client_id: OPEN_CLOUD_CLI_CLIENT_ID,
    },
    request,
  );
  if (!response.ok) throw await responseError(response, "revoke CLI login");
}

export function openBrowser(url: string): boolean {
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol)) return false;
  const command =
    process.platform === "darwin"
      ? { executable: "open", arguments: [parsed.href] }
      : process.platform === "win32"
        ? {
            executable: "rundll32.exe",
            arguments: ["url.dll,FileProtocolHandler", parsed.href],
          }
        : { executable: "xdg-open", arguments: [parsed.href] };
  try {
    const child = spawn(command.executable, command.arguments, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function accountCredential(
  authorization: Pick<
    DeviceAuthorization,
    "apiUrl" | "issuer" | "tokenEndpoint" | "revocationEndpoint"
  >,
  tokens: TokenResponse,
): AccountCredential {
  if (tokens.resource !== authorization.apiUrl) {
    throw new Error("OpenCloud returned a token for the wrong API resource");
  }
  const issuedAt = Date.now();
  return {
    schemaVersion: 1,
    kind: "account",
    apiUrl: authorization.apiUrl,
    issuer: authorization.issuer,
    tokenEndpoint: authorization.tokenEndpoint,
    revocationEndpoint: authorization.revocationEndpoint,
    accessToken: tokens.access_token,
    accessExpiresAt: new Date(issuedAt + tokens.expires_in * 1_000).toISOString(),
    refreshToken: tokens.refresh_token,
    refreshExpiresAt: new Date(
      issuedAt + tokens.refresh_expires_in * 1_000,
    ).toISOString(),
  };
}

function parseTokenResponse(value: unknown): TokenResponse {
  const token = value as Partial<TokenResponse>;
  if (
    !token ||
    typeof token.access_token !== "string" ||
    typeof token.refresh_token !== "string" ||
    typeof token.expires_in !== "number" ||
    typeof token.refresh_expires_in !== "number" ||
    token.token_type !== "Bearer" ||
    typeof token.scope !== "string" ||
    typeof token.resource !== "string"
  ) {
    throw new Error("OpenCloud returned an invalid CLI token response");
  }
  return token as TokenResponse;
}

async function requestJson<T>(
  url: string,
  request: typeof fetch,
): Promise<T> {
  const response = await request(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await responseError(response, "discover login");
  return (await response.json()) as T;
}

function postForm(
  url: string,
  values: Record<string, string>,
  request: typeof fetch,
): Promise<Response> {
  return request(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(15_000),
  });
}

async function oauthError(
  response: Response,
): Promise<{ code: string; message: string }> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { code: "http_error", message: `HTTP ${response.status}` };
  }
  const value = body as Record<string, unknown>;
  return {
    code:
      typeof value.code === "string"
        ? value.code
        : typeof value.error === "string"
          ? value.error
          : "http_error",
    message:
      typeof value.message === "string"
        ? value.message
        : typeof value.error_description === "string"
          ? value.error_description
          : `HTTP ${response.status}`,
  };
}

async function responseError(
  response: Response,
  action: string,
): Promise<Error> {
  const error = await oauthError(response);
  return new Error(`Could not ${action}: ${error.message}`);
}
