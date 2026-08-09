import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const KEYRING_SERVICE = "ai.opencloud.cli";

export interface AccountCredential {
  schemaVersion: 1;
  kind: "account";
  apiUrl: string;
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

export interface WorkspaceCredential {
  schemaVersion: 1;
  kind: "workspace";
  apiUrl: string;
  appId: string;
  token: string;
  expiresAt: string;
}

export interface StoredCredential<T> {
  credential: T;
  backend: "keyring" | "protected-file";
  location: string;
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): void;
}

type KeyringEntryConstructor = new (
  service: string,
  account: string,
) => KeyringEntry;
type KeyringLoader = () => Promise<KeyringEntryConstructor | null>;

let keyringConstructor: Promise<KeyringEntryConstructor | null> | null = null;

async function loadKeyring(): Promise<KeyringEntryConstructor | null> {
  keyringConstructor ??= import("@napi-rs/keyring")
    .then(
      (module) =>
        (module as unknown as { Entry: KeyringEntryConstructor }).Entry,
    )
    .catch(() => null);
  return keyringConstructor;
}

function defaultConfigDirectory(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return appData
      ? path.join(appData, "OpenCloud")
      : path.join(os.homedir(), "AppData", "Roaming", "OpenCloud");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "OpenCloud");
  }
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "opencloud",
  );
}

function credentialName(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function accountName(apiUrl: string): string {
  return `account-${credentialName([apiUrl])}`;
}

function workspaceName(apiUrl: string, appId: string): string {
  return `workspace-${credentialName([apiUrl, appId])}`;
}

function parseAccount(raw: string): AccountCredential {
  const value = JSON.parse(raw) as Partial<AccountCredential>;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "account" ||
    !value.apiUrl ||
    !value.issuer ||
    !value.tokenEndpoint ||
    !value.revocationEndpoint ||
    !value.accessToken ||
    !value.accessExpiresAt ||
    !value.refreshToken ||
    !value.refreshExpiresAt
  ) {
    throw new Error("Stored OpenCloud account credential is invalid");
  }
  return value as AccountCredential;
}

function parseWorkspace(raw: string): WorkspaceCredential {
  const value = JSON.parse(raw) as Partial<WorkspaceCredential>;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "workspace" ||
    !value.apiUrl ||
    !value.appId ||
    !value.token ||
    !value.expiresAt
  ) {
    throw new Error("Stored OpenCloud workspace credential is invalid");
  }
  return value as WorkspaceCredential;
}

export class CredentialStore {
  readonly configDirectory: string;

  constructor(
    configDirectory = defaultConfigDirectory(),
    private readonly keyringLoader: KeyringLoader = loadKeyring,
  ) {
    this.configDirectory = path.resolve(configDirectory);
  }

  accountLocation(apiUrl: string): string {
    return this.fallbackFile(accountName(apiUrl));
  }

  workspaceLocation(apiUrl: string, appId: string): string {
    return this.fallbackFile(workspaceName(apiUrl, appId));
  }

  loadAccount(apiUrl: string): Promise<StoredCredential<AccountCredential> | null> {
    return this.load(accountName(apiUrl), parseAccount);
  }

  saveAccount(
    value: AccountCredential,
  ): Promise<StoredCredential<AccountCredential>> {
    return this.save(accountName(value.apiUrl), value);
  }

  deleteAccount(apiUrl: string): Promise<void> {
    return this.delete(accountName(apiUrl));
  }

  loadWorkspace(
    apiUrl: string,
    appId: string,
  ): Promise<StoredCredential<WorkspaceCredential> | null> {
    return this.load(workspaceName(apiUrl, appId), parseWorkspace);
  }

  saveWorkspace(
    value: WorkspaceCredential,
  ): Promise<StoredCredential<WorkspaceCredential>> {
    return this.save(workspaceName(value.apiUrl, value.appId), value);
  }

  deleteWorkspace(apiUrl: string, appId: string): Promise<void> {
    return this.delete(workspaceName(apiUrl, appId));
  }

  private async load<T>(
    name: string,
    parse: (raw: string) => T,
  ): Promise<StoredCredential<T> | null> {
    const Entry = await this.keyringLoader();
    if (Entry) {
      try {
        const raw = new Entry(KEYRING_SERVICE, name).getPassword();
        if (raw) {
          return {
            credential: parse(raw),
            backend: "keyring",
            location: `OS credential store (${KEYRING_SERVICE})`,
          };
        }
      } catch {
        // Headless Linux environments commonly have no usable secret service.
      }
    }
    const file = this.fallbackFile(name);
    if (!existsSync(file)) return null;
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Unsafe OpenCloud credential path: ${file}`);
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error(
        `OpenCloud credential permissions are too broad; run chmod 600 ${file}`,
      );
    }
    return {
      credential: parse(readFileSync(file, "utf8")),
      backend: "protected-file",
      location: file,
    };
  }

  private async save<T extends AccountCredential | WorkspaceCredential>(
    name: string,
    value: T,
  ): Promise<StoredCredential<T>> {
    const serialized = JSON.stringify(value);
    const Entry = await this.keyringLoader();
    if (Entry) {
      try {
        new Entry(KEYRING_SERVICE, name).setPassword(serialized);
        await this.deleteFallback(name);
        return {
          credential: value,
          backend: "keyring",
          location: `OS credential store (${KEYRING_SERVICE})`,
        };
      } catch {
        // Fall through to a mode-0600 per-user file.
      }
    }
    const directory = path.join(this.configDirectory, "credentials");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = lstatSync(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new Error(`Unsafe OpenCloud credential directory: ${directory}`);
    }
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const file = this.fallbackFile(name);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${serialized}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
    if (process.platform !== "win32") await chmod(file, 0o600);
    return { credential: value, backend: "protected-file", location: file };
  }

  private async delete(name: string): Promise<void> {
    const Entry = await this.keyringLoader();
    if (Entry) {
      try {
        new Entry(KEYRING_SERVICE, name).deletePassword();
      } catch {
        // Missing entries and unavailable keyrings are both safe to ignore.
      }
    }
    await this.deleteFallback(name);
  }

  private async deleteFallback(name: string): Promise<void> {
    const file = this.fallbackFile(name);
    if (!existsSync(file)) return;
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Refusing to remove unsafe credential path: ${file}`);
    }
    await rm(file, { force: true });
  }

  private fallbackFile(name: string): string {
    if (!/^(account|workspace)-[a-f0-9]{64}$/.test(name)) {
      throw new Error("Invalid OpenCloud credential key");
    }
    return path.join(this.configDirectory, "credentials", `${name}.json`);
  }
}
