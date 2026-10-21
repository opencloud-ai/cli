import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderCliInstaller } from "./cli-installer.js";

const template = readFileSync(
  new URL("../../../docs/site/public/install.sh", import.meta.url),
  "utf8",
);
const sprout = {
  productName: "Sprout",
  cliCommand: "sprout",
  apiUrl: "https://api.sprout.example",
};
const archive = "fake-opencloud-cli-archive";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function executable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

/** A temporary HOME with fake curl, node and npm serving a fake release. */
async function fixture(checksum = createHash("sha256").update(archive).digest("hex")) {
  const root = await mkdtemp(join(tmpdir(), "brand-cli-installer-"));
  roots.push(root);
  const fakeBin = join(root, "fake-bin");
  const binDirectory = join(root, "bin");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(join(root, "downloads"), { recursive: true });
  await executable(
    join(fakeBin, "node"),
    `#!/usr/bin/env bash
[[ "\${1:-}" == "--version" ]] && { printf 'v22.0.0\\n'; exit 0; }
exit 1
`,
  );
  await executable(
    join(fakeBin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
destination="\${2:?}"
url="\${3:?}"
printf '%s\\n' "$url" >> "$FAKE_CURL_LOG"
case "$url" in
  */checksums.txt) printf '%s  opencloud-cli-3.13.1.tgz\\n' "$FAKE_CLI_CHECKSUM" > "$destination" ;;
  */opencloud-cli-3.13.1.tgz) printf '%s' "$FAKE_CLI_ARCHIVE" > "$destination" ;;
  *) exit 1 ;;
esac
`,
  );
  // The fake CLI reports its version and echoes the API URL it would use.
  await executable(
    join(fakeBin, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${1:-}" == "--version" ]] && { printf '10.0.0\\n'; exit 0; }
[[ "\${1:-}" == "install" ]] || exit 1
shift
prefix=""
while (($#)); do
  case "$1" in
    --prefix) prefix="\${2:?}"; shift 2 ;;
    *) shift ;;
  esac
done
entrypoint="$prefix/node_modules/@opencloud/cli/dist/index.cjs"
mkdir -p "$(dirname "$entrypoint")" "$prefix/node_modules/.bin"
cat > "$entrypoint" <<'CLI'
#!/usr/bin/env bash
if [[ "\${1:-}" == "--cli-version" ]]; then printf '3.13.1\\n'; exit 0; fi
printf 'api=%s args=%s\\n' "\${OPENCLOUD_API_URL:-default}" "$*"
CLI
chmod 0644 "$entrypoint"
ln -sfn ../@opencloud/cli/dist/index.cjs "$prefix/node_modules/.bin/opencloud"
`,
  );
  return {
    root,
    binDirectory,
    curlLog: join(root, "curl.log"),
    environment: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: root,
      TMPDIR: join(root, "downloads"),
      OPENCLOUD_INSTALL_DIR: join(root, "install"),
      OPENCLOUD_BIN_DIR: binDirectory,
      FAKE_CLI_ARCHIVE: archive,
      FAKE_CLI_CHECKSUM: checksum,
      FAKE_CURL_LOG: join(root, "curl.log"),
    },
  };
}

function run(script: string, environment: NodeJS.ProcessEnv) {
  return spawnSync("bash", ["-s"], {
    input: script,
    encoding: "utf8",
    env: environment,
  });
}

describe("CLI installer rendering", () => {
  it("returns the published installer unchanged for the CLI's own command", () => {
    expect(
      renderCliInstaller(template, {
        productName: "OpenCloud",
        cliCommand: "opencloud",
        apiUrl: "https://api.feature.ocd.dev",
      }),
    ).toBe(template);
  });

  it("installs the pinned release plus a wrapper bound to the installation", async () => {
    const script = renderCliInstaller(template, sprout);
    expect(script).toContain('CLI_VERSION="3.13.1"');
    expect(script).toContain("Sprout CLI installer: %s");
    expect(script).not.toMatch(/OpenCloud CLI|opencloud doctor/);
    const environment = await fixture();

    const result = run(script, environment.environment);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `Sprout CLI 3.13.1 installed at ${environment.binDirectory}/sprout`,
    );
    expect(result.stdout).toContain("Add the CLI to PATH, then run sprout doctor:");
    expect(script).toContain("printf 'Run: sprout doctor\\n'");
    // The same verified release, downloaded with its published checksums.
    expect((await readFile(environment.curlLog, "utf8")).trim().split("\n")).toEqual([
      "https://github.com/opencloud-ai/cli/releases/download/v3.13.1/opencloud-cli-3.13.1.tgz",
      "https://github.com/opencloud-ai/cli/releases/download/v3.13.1/checksums.txt",
    ]);
    const executablePath = join(
      environment.root,
      "install/3.13.1/node_modules/.bin/opencloud",
    );
    expect(await readlink(join(environment.binDirectory, "opencloud"))).toBe(
      executablePath,
    );

    const wrapper = join(environment.binDirectory, "sprout");
    const defaulted = spawnSync(wrapper, ["auth", "status"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: environment.root },
    });
    expect(defaulted.stdout.trim()).toBe(
      "api=https://api.sprout.example args=auth status",
    );
    const explicit = spawnSync(wrapper, ["doctor"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: environment.root,
        OPENCLOUD_API_URL: "https://api.other.example",
      },
    });
    expect(explicit.stdout.trim()).toBe("api=https://api.other.example args=doctor");
    const version = spawnSync(wrapper, ["--cli-version"], { encoding: "utf8" });
    expect(version.stdout.trim()).toBe("3.13.1");

    // Re-running replaces the managed wrapper.
    const again = run(script, environment.environment);
    expect(again.status, again.stderr).toBe(0);
  });

  it("refuses to replace a command it does not manage", async () => {
    const environment = await fixture();
    await mkdir(environment.binDirectory, { recursive: true });
    await writeFile(join(environment.binDirectory, "sprout"), "#!/bin/sh\necho mine\n");

    const result = run(renderCliInstaller(template, sprout), environment.environment);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("sprout already exists and is not managed by this installer");
    await expect(access(join(environment.binDirectory, "opencloud"))).rejects.toThrow();
  });

  it("still rejects a release whose checksum does not match", async () => {
    const environment = await fixture("0".repeat(64));
    const result = run(renderCliInstaller(template, sprout), environment.environment);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Sprout CLI installer: checksum verification failed");
    await expect(access(join(environment.binDirectory, "sprout"))).rejects.toThrow();
  });

  it("rejects values that are unsafe in a shell script", () => {
    expect(() =>
      renderCliInstaller(template, { ...sprout, apiUrl: "https://api.example/'$(id)'" }),
    ).toThrow("origin");
    expect(() =>
      renderCliInstaller(template, { ...sprout, cliCommand: "sprout;id" }),
    ).toThrow("command");
    expect(() =>
      renderCliInstaller(template.replace("ln -sfn", "ln -s"), sprout),
    ).toThrow("expected shape");
  });
});
