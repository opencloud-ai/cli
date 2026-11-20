import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildBundle as buildVendoredBundle,
  type BuiltBundle,
  type BundleOptions,
} from "@opencloud/bundler";
import type { OpenCloudManifest } from "@opencloud/contracts";
import YAML from "yaml";
import { sdkVersionAtLeast } from "@opencloud/contracts";
import { CONTAINER_SDK_VERSION, DEFAULT_SDK_VERSION, withUnpinnedSdkVersion } from "./sdk-version.js";

export * from "@opencloud/bundler";

/**
 * The vendored bundler's buildBundle, with the CLI choosing the SDK version a
 * manifest that pins none gets: CLI 3.20's default, or 2.8.0 when it declares
 * containers (see ./sdk-version.ts). A pinned version is never changed.
 */
export async function buildBundle(directory: string, options: BundleOptions = {}): Promise<BuiltBundle> {
  const version = (await declaresContainers(path.resolve(directory))) ? CONTAINER_SDK_VERSION : DEFAULT_SDK_VERSION;
  return withUnpinnedSdkVersion(version, () => buildVendoredBundle(directory, options));
}

/**
 * Whether the author manifest the bundler reads (the first of these names)
 * declares containers. One that can't be read says no; the bundler reports why.
 */
async function declaresContainers(root: string): Promise<boolean> {
  for (const name of ["opencloud.yaml", "opencloud.yml", "opencloud.json"]) {
    const file = path.join(root, name);
    const info = await lstat(file).catch(() => null);
    if (!info) continue;
    if (!info.isFile()) return false;
    try {
      const source = await readFile(file, "utf8");
      const raw = (name.endsWith(".json") ? JSON.parse(source) : YAML.parse(source)) as { containers?: unknown } | null;
      return Array.isArray(raw?.containers) && raw.containers.length > 0;
    } catch {
      return false;
    }
  }
  return false;
}

/** A warning this CLI adds to the bundler's, in the same shape. */
export interface CliBundleWarning {
  code: "CONTAINERS_NEED_SDK_2_8";
  path: string;
  message: string;
}

/**
 * A manifest that declares containers but pins an SDK older than 2.8.0, the
 * first whose Functions can call them (and what an unpinned one with
 * containers gets). OpenCloud accepts it, so this warns and names the fix.
 */
export function cliBundleWarnings(bundle: BuiltBundle): CliBundleWarning[] {
  const manifest = bundle.manifest;
  if (manifest.schemaVersion !== 3 || !manifest.containers?.length) return [];
  const version = manifest.runtime.sdk.version;
  if (sdkVersionAtLeast(version, CONTAINER_SDK_VERSION)) return [];
  return [{
    code: "CONTAINERS_NEED_SDK_2_8",
    path: bundle.sourceManifest,
    message: `${bundle.sourceManifest} declares containers but pins runtime SDK ${version}; Functions can call containers only from SDK ${CONTAINER_SDK_VERSION}. Set runtime.sdk.version: ${CONTAINER_SDK_VERSION} in ${bundle.sourceManifest}.`,
  }];
}

/** CLI draft/recovery transport uses the same optional-field omissions as bundles. */
export function serializeBundleManifest(manifest: OpenCloudManifest): string {
  const archiveManifest: Record<string, unknown> = { ...manifest };
  if (manifest.queues.length === 0) delete archiveManifest.queues;
  if (Object.keys(manifest.integrations).length === 0) delete archiveManifest.integrations;
  return `${JSON.stringify(archiveManifest, null, 2)}\n`;
}
