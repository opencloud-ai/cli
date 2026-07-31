import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface PendingOnboardingSession {
  schemaVersion: 1;
  state: "awaiting_email_verification";
  apiUrl: string;
  onboardingId: string;
  completionToken: string;
  verificationExpiresAt: string;
}

export interface StartingOnboardingSession {
  schemaVersion: 1;
  state: "starting";
  apiUrl: string;
  idempotencyKey: string;
  email: string;
  projectName: string;
  visibility: "public" | "private";
}

export interface ReadyAgentSession {
  schemaVersion: 1;
  state: "ready";
  apiUrl: string;
  appId: string;
  appUrl: string;
  token: string;
  credentialExpiresAt: string;
}

export type OpenCloudSession =
  | StartingOnboardingSession
  | PendingOnboardingSession
  | ReadyAgentSession;

export function defaultSessionFile(cwd = process.cwd()): string {
  return path.join(cwd, ".opencloud", "session.json");
}

export function resolveSessionFile(
  value?: string,
  cwd = process.env.INIT_CWD ?? process.cwd(),
): string {
  const start = path.resolve(cwd);
  if (value) return path.resolve(start, value);
  let current = start;
  while (true) {
    const candidate = defaultSessionFile(current);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return defaultSessionFile(start);
    current = parent;
  }
}

export function loadSession(file: string): OpenCloudSession | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
  const value = JSON.parse(raw) as Partial<OpenCloudSession>;
  if (
    value.schemaVersion !== 1 ||
    typeof value.apiUrl !== "string" ||
    !value.apiUrl
  ) {
    throw new Error(`Invalid OpenCloud session file: ${file}`);
  }
  if (
    value.state === "starting" &&
    typeof value.idempotencyKey === "string" &&
    typeof value.email === "string" &&
    typeof value.projectName === "string" &&
    (value.visibility === "public" || value.visibility === "private")
  ) {
    return value as StartingOnboardingSession;
  }
  if (
    value.state === "ready" &&
    typeof value.appId === "string" &&
    typeof value.appUrl === "string" &&
    typeof value.token === "string" &&
    typeof value.credentialExpiresAt === "string"
  ) {
    return value as ReadyAgentSession;
  }
  if (
    value.state === "awaiting_email_verification" &&
    typeof value.onboardingId === "string" &&
    typeof value.completionToken === "string" &&
    typeof value.verificationExpiresAt === "string"
  ) {
    return value as PendingOnboardingSession;
  }
  throw new Error(`Invalid OpenCloud session file: ${file}`);
}

export async function saveSession(
  file: string,
  session: OpenCloudSession,
): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  try {
    await fs.writeFile(path.join(directory, ".gitignore"), "*\n!.gitignore\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
  }

  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
}
