import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceBinding {
  schemaVersion: 1;
  apiUrl: string;
  appId: string;
  appName: string;
  appUrl: string;
  connectedAt: string;
  credentialExpiresAt: string;
}

export function defaultWorkspaceFile(cwd = process.cwd()): string {
  return path.join(cwd, ".opencloud", "app.json");
}

export function resolveWorkspaceFile(
  value?: string,
  cwd = process.env.INIT_CWD ?? process.cwd(),
): string {
  const start = path.resolve(cwd);
  if (value) return path.resolve(start, value);
  let current = start;
  while (true) {
    const candidate = defaultWorkspaceFile(current);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return defaultWorkspaceFile(start);
    current = parent;
  }
}

export function loadWorkspaceBinding(file: string): WorkspaceBinding | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(raw) as Partial<WorkspaceBinding>;
  if (
    value.schemaVersion !== 1 ||
    !value.apiUrl ||
    !value.appId ||
    !value.appName ||
    !value.appUrl ||
    !value.connectedAt ||
    !value.credentialExpiresAt
  ) {
    throw new Error(`Invalid OpenCloud workspace binding: ${file}`);
  }
  return value as WorkspaceBinding;
}

export async function saveWorkspaceBinding(
  file: string,
  binding: WorkspaceBinding,
): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  try {
    await writeFile(path.join(directory, ".gitignore"), "*\n!.gitignore\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, file);
  if (process.platform !== "win32") await chmod(file, 0o600);
}
