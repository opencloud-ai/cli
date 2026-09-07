export * from "@opencloud/bundler";
import type { OpenCloudManifest } from "@opencloud/contracts";

/** CLI draft/recovery transport uses the same optional-field omissions as bundles. */
export function serializeBundleManifest(manifest: OpenCloudManifest): string {
  const archiveManifest: Record<string, unknown> = { ...manifest };
  if (manifest.queues.length === 0) delete archiveManifest.queues;
  if (Object.keys(manifest.integrations).length === 0) delete archiveManifest.integrations;
  return `${JSON.stringify(archiveManifest, null, 2)}\n`;
}
