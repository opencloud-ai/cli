import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

/**
 * A bundle digest is the SHA-256 of its gzip-compressed archive, and gzip
 * output depends on the zlib a runtime links: official Node builds bundle
 * Chromium's zlib, while Node built against a system zlib (Homebrew, Linux
 * distributions), Bun and Deno compress the same tar differently. So when
 * OpenCloud's digest differs from the local one, the CLI checks whether
 * OpenCloud built the same content: the same files with the same bytes and
 * the same resolved manifest. If so, OpenCloud's digest names the release.
 */

const BLOCK = 512;

/** Path → SHA-256 of every regular file in a bundle archive (.tgz). */
export function archiveFileDigests(archive: Buffer): Map<string, string> {
  const tar = gunzipSync(archive);
  const digests = new Map<string, string>();
  let offset = 0;
  let pending: { path?: string; size?: number } = {};
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const type = String.fromCharCode(header[156] ?? 0);
    const size = pending.size ?? octal(header.subarray(124, 136));
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      pending = { ...pending, ...paxRecords(data) };
      continue;
    }
    if (type === "L") {
      pending = { ...pending, path: text(data) };
      continue;
    }
    const prefix = text(header.subarray(345, 500));
    const name = text(header.subarray(0, 100));
    const entryPath = (pending.path ?? (prefix ? `${prefix}/${name}` : name)).replace(/^\.\//, "");
    pending = {};
    if (type === "0" || type === "\0") {
      digests.set(entryPath, createHash("sha256").update(data).digest("hex"));
    }
  }
  return digests;
}

function text(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

function octal(bytes: Buffer): number {
  const value = text(bytes).trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function paxRecords(data: Buffer): { path?: string; size?: number } {
  const records: { path?: string; size?: number } = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === "path") records.path = value;
    if (key === "size") records.size = Number.parseInt(value, 10);
    offset += length;
  }
  return records;
}

export interface ArtifactComparisonInput {
  /** The local bundle's parsed manifest. */
  localManifest: unknown;
  /** The local bundle's archive paths, including opencloud.json. */
  localFiles: readonly string[];
  /** Path → SHA-256 of each file in the local archive. */
  localDigests: ReadonlyMap<string, string>;
  /** Path → SHA-256 of each file OpenCloud stored in the validated draft. */
  remoteDigests: ReadonlyMap<string, string>;
  /** OpenCloud's resolved manifest and archive paths for that draft. */
  validation: { manifest: unknown; artifactFiles: readonly string[] };
}

export interface ArtifactComparison {
  /** OpenCloud built the same files, bytes and manifest as the local bundle. */
  sameContent: boolean;
  /** Top-level manifest keys whose resolved values differ. */
  manifestKeys: string[];
  /** Archive paths only the local bundle has. */
  localOnlyFiles: string[];
  /** Archive paths only OpenCloud's artifact has. */
  serverOnlyFiles: string[];
  /** Files in both whose bytes differ between the local bundle and the draft. */
  changedFiles: string[];
}

const MANIFEST_FILE = "opencloud.json";

export function compareValidatedArtifact(
  input: ArtifactComparisonInput,
): ArtifactComparison {
  const local = new Set(input.localFiles);
  const server = new Set(input.validation.artifactFiles);
  const localOnlyFiles = [...local].filter((file) => !server.has(file)).sort();
  const serverOnlyFiles = [...server].filter((file) => !local.has(file)).sort();
  const changedFiles = [...local]
    .filter((file) => file !== MANIFEST_FILE && server.has(file))
    .filter((file) => {
      const localDigest = input.localDigests.get(file);
      return !localDigest || localDigest !== input.remoteDigests.get(file);
    })
    .sort();
  const manifestKeys = differingKeys(input.localManifest, input.validation.manifest);
  return {
    sameContent:
      !localOnlyFiles.length &&
      !serverOnlyFiles.length &&
      !changedFiles.length &&
      !manifestKeys.length,
    manifestKeys,
    localOnlyFiles,
    serverOnlyFiles,
    changedFiles,
  };
}

/** Explains a validated artifact that differs from the local bundle. */
export function describeArtifactMismatch(
  comparison: ArtifactComparison,
  localSha256: string,
  serverSha256: string | null,
): string {
  const facts = [
    `Local bundle ${localSha256} does not match OpenCloud's validated artifact ${serverSha256 ?? "(none)"}.`,
  ];
  if (comparison.manifestKeys.length) {
    facts.push(`OpenCloud resolved these manifest keys differently: ${comparison.manifestKeys.join(", ")}.`);
  }
  if (comparison.changedFiles.length) {
    facts.push(`These files differ between the local bundle and the uploaded draft: ${comparison.changedFiles.join(", ")}.`);
  }
  if (comparison.localOnlyFiles.length) {
    facts.push(`Only the local bundle has: ${comparison.localOnlyFiles.join(", ")}.`);
  }
  if (comparison.serverOnlyFiles.length) {
    facts.push(`Only OpenCloud's artifact has: ${comparison.serverOnlyFiles.join(", ")}.`);
  }
  return facts.join(" ");
}

function differingKeys(left: unknown, right: unknown): string[] {
  const leftRecord = record(left);
  const rightRecord = record(right);
  return [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])]
    .filter((key) => canonical(leftRecord[key]) !== canonical(rightRecord[key]))
    .sort();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** JSON with sorted object keys, so key order never counts as a difference. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : item,
  ) ?? "undefined";
}
