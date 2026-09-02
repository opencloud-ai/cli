import { Readable } from "node:stream";
import {
  chmod,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-client.js";
import {
  CliContractError,
  OperationTerminalError,
  OperationWaitTimeoutError,
  downloadToFile,
  followOperation,
  jsonOption,
  parseBoundedNumber,
  persistCredentialToken,
  secretFromStdin,
  structuredCliError,
} from "./owner-parity.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "opencloud-owner-parity-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe("owner-parity CLI helpers", () => {
  it("validates bounded numeric options", () => {
    expect(parseBoundedNumber("2.5", "--interval", 0.05, 60, false)).toBe(2.5);
    expect(() => parseBoundedNumber("2.5", "--limit", 1, 100)).toThrow(
      CliContractError,
    );
    expect(() => parseBoundedNumber("101", "--limit", 1, 100)).toThrow(
      /--limit/,
    );
  });

  it("loads exactly one JSON input source and checks its shape", async () => {
    const directory = await temporaryDirectory();
    const inputFile = path.join(directory, "input.json");
    await writeFile(inputFile, '[{"name":"first"}]');

    await expect(
      jsonOption({
        file: inputFile,
        resolvePath: path.resolve,
        kind: "array",
      }),
    ).resolves.toEqual([{ name: "first" }]);
    await expect(
      jsonOption({
        inline: "{}",
        file: inputFile,
        resolvePath: path.resolve,
        kind: "object",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
    await expect(
      jsonOption({
        inline: "[]",
        resolvePath: path.resolve,
        kind: "object",
      }),
    ).rejects.toMatchObject({ code: "INVALID_JSON_SHAPE" });
  });

  it("follows one operation and returns only the terminal replacement", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ id: "operation-1", state: "running" })
      .mockResolvedValueOnce({
        id: "operation-1",
        state: "succeeded",
        output: { ok: true },
      });
    const result = await followOperation({
      client: { get },
      started: {
        resource: { id: "resource-1" },
        operation: { id: "operation-1", state: "queued" },
      },
      options: { follow: true, interval: "0.05", timeout: "5" },
      sleep: async () => undefined,
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      resource: { id: "resource-1" },
      operation: {
        id: "operation-1",
        state: "succeeded",
        output: { ok: true },
      },
    });
  });

  it("makes terminal failures and bounded wait timeouts recoverable", async () => {
    await expect(
      followOperation({
        client: { get: vi.fn() },
        started: { id: "operation-2", state: "failed" },
        options: { follow: false, interval: "2", timeout: "5" },
      }),
    ).rejects.toBeInstanceOf(OperationTerminalError);

    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(1_000);
    await expect(
      followOperation({
        client: { get: vi.fn() },
        started: { id: "operation-3", state: "queued" },
        options: { follow: true, interval: "1", timeout: "1" },
        now,
        sleep: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(OperationWaitTimeoutError);
  });

  it("reads bounded secrets from standard input without echo metadata", async () => {
    await expect(
      secretFromStdin(Readable.from(["secret-value\n"])),
    ).resolves.toBe("secret-value");
    await expect(secretFromStdin(Readable.from(["\n"]))).rejects.toMatchObject({
      code: "SECRET_INPUT_REQUIRED",
    });
  });

  it("persists one-time credentials with mode 0600 and never returns the token", async () => {
    const directory = await temporaryDirectory();
    const destination = path.join(directory, "private", "app.token");
    const metadata = await persistCredentialToken({
      response: {
        id: "credential-1",
        prefix: "oc_app_example",
        token: "oc_app_do-not-print-this-token",
      },
      destination,
    });

    expect(metadata).toEqual({
      id: "credential-1",
      prefix: "oc_app_example",
      tokenFile: destination,
    });
    expect(metadata).not.toHaveProperty("token");
    expect(await readFile(destination, "utf8")).toBe(
      "oc_app_do-not-print-this-token\n",
    );
    if (process.platform !== "win32") {
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
    }
    await expect(
      persistCredentialToken({
        response: { token: "replacement" },
        destination,
      }),
    ).rejects.toMatchObject({ code: "TOKEN_FILE_EXISTS" });
    expect(await readFile(destination, "utf8")).toContain("do-not-print");
    await expect(
      persistCredentialToken({
        response: {
          id: "credential-1",
          prefix: "oc_app_example",
          token: "oc_app_do-not-print-this-token",
        },
        destination,
      }),
    ).resolves.toEqual(metadata);
  });

  it.runIf(process.platform !== "win32")(
    "rejects existing credential files unless they are exact mode 0600 regular files",
    async () => {
      const directory = await temporaryDirectory();
      const destination = path.join(directory, "app.token");
      const response = { token: "same-secret" };

      await writeFile(destination, "same-secret\n", { mode: 0o400 });
      await expect(
        persistCredentialToken({ response, destination }),
      ).rejects.toMatchObject({ code: "UNSAFE_TOKEN_FILE" });

      await chmod(destination, 0o700);
      await expect(
        persistCredentialToken({ response, destination }),
      ).rejects.toMatchObject({ code: "UNSAFE_TOKEN_FILE" });

      await rm(destination);
      const target = path.join(directory, "target.token");
      await writeFile(target, "same-secret\n", { mode: 0o600 });
      await symlink(target, destination);
      await expect(
        persistCredentialToken({ response, destination }),
      ).rejects.toMatchObject({ code: "UNSAFE_TOKEN_FILE" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "detects replacement of an existing credential path after O_NOFOLLOW open",
    async () => {
      const directory = await temporaryDirectory();
      const destination = path.join(directory, "app.token");
      const retained = path.join(directory, "retained.token");
      await writeFile(destination, "same-secret\n", { mode: 0o600 });

      await expect(
        persistCredentialToken({
          response: { token: "same-secret" },
          destination,
          afterExistingFileOpened: async () => {
            await rename(destination, retained);
            await writeFile(destination, "same-secret\n", { mode: 0o600 });
          },
        }),
      ).rejects.toMatchObject({ code: "UNSAFE_TOKEN_FILE" });
      expect(await readFile(retained, "utf8")).toBe("same-secret\n");
    },
  );

  it("streams downloads to a new file and refuses overwrite", async () => {
    const directory = await temporaryDirectory();
    const destination = path.join(directory, "download.bin");
    const result = await downloadToFile({
      response: new Response("streamed-content"),
      destination,
      force: false,
    });

    expect(await readFile(destination, "utf8")).toBe("streamed-content");
    expect(result).toMatchObject({ output: destination, size: 16 });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      downloadToFile({
        response: new Response("replacement"),
        destination,
        force: false,
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_FILE_EXISTS" });
  });

  it("emits typed, redacted API and operation diagnostics", () => {
    const api = structuredCliError(
      new ApiError(503, {
        code: "CAPACITY_UNAVAILABLE",
        message: "retry Bearer oc_owner_do-not-leak",
        retryable: true,
        requestId: "request-1",
      }),
    );
    expect(api).toEqual({
      ok: false,
      error: {
        code: "CAPACITY_UNAVAILABLE",
        message: "retry [REDACTED]",
        status: 503,
        retryable: true,
        requestId: "request-1",
      },
    });
    expect(JSON.stringify(api)).not.toContain("do-not-leak");

    const failed = structuredCliError(
      new OperationTerminalError({
        id: "operation-4",
        state: "failed",
        error: { code: "FUNCTION_FAILED", secret: "hidden" },
      }),
    );
    expect(failed.error).toMatchObject({
      code: "OPERATION_FAILED",
      operationId: "operation-4",
      operationState: "failed",
      operationErrorCode: "FUNCTION_FAILED",
    });
    expect(failed).not.toHaveProperty("error.operation.error.secret");
  });
});
