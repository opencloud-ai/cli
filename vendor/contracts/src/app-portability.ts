import { z } from "zod";

export const portabilityLimits = {
  archiveBytes: 2 * 1024 * 1024 * 1024,
  expandedBytes: 2 * 1024 * 1024 * 1024,
  // These parts are parsed in memory; keep their former package-wide ceiling.
  metadataBytes: 128 * 1024 * 1024,
  rowBytes: 128 * 1024 * 1024,
  entries: 10_000,
  tables: 200,
  rows: 5_000_000,
  manifestBytes: 256 * 1024,
} as const;

export const publicHttpsUrlSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (!url.port || url.port === "443")
    );
  }, "Use a public HTTPS URL without credentials, a fragment, or a custom port");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);

export const appPackageDownloadSchema = z.object({
  url: publicHttpsUrlSchema,
  sha256: digest,
  bytes: z.number().int().positive().max(portabilityLimits.archiveBytes),
}).strict();
export const appExportDownloadSchema = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  sha256: digest,
  bytes: z.number().int().nonnegative().max(portabilityLimits.archiveBytes),
  expiresAt: z.iso.datetime(),
  downloadUrl: z.url(),
});

export const appInstallManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("opencloud.app-install"),
    id: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-z0-9][a-z0-9._/-]*$/),
    version: z.string().min(1).max(80),
    title: z.string().trim().min(1).max(80),
    summary: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(4000),
    publisher: z
      .object({
        name: z.string().min(1).max(120),
        url: publicHttpsUrlSchema.optional(),
      })
      .strict(),
    sourceUrl: publicHttpsUrlSchema.optional(),
    license: z.string().min(1).max(120),
    icon: publicHttpsUrlSchema.optional(),
    images: z
      .array(
        z
          .object({
            url: publicHttpsUrlSchema,
            alt: z.string().min(1).max(300),
            caption: z.string().max(300).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    data: z
      .object({
        kind: z.enum(["empty", "demo"]),
        description: z.string().min(1).max(1000),
      })
      .strict(),
    requirements: z
      .object({
        capabilities: z
          .array(
            z.enum([
              "data",
              "files",
              "functions",
              "cron",
              "queues",
              "agentTasks",
              "email",
              "ai",
            ]),
          )
          .max(8),
        integrations: z.array(z.string().min(1).max(100)).max(20),
        secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)).max(100),
      })
      .strict(),
    archive: appPackageDownloadSchema,
  })
  .strict();
export type AppInstallManifest = z.infer<typeof appInstallManifestSchema>;

/** App authors classify data explicitly; arbitrary text/JSON is never rewritten. */
export const appPortabilityProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    data: z.literal("business"),
    externalState: z.literal("none"),
    references: z
      .array(
        z
          .object({
            table: identifier,
            column: identifier,
            kind: z.enum(["user", "file"]),
          })
          .strict(),
      )
      .max(1000),
    /** Only a separately prepared fictional example may bind these exact identities. */
    installerIdentities: z.array(z.uuid()).max(20).default([]),
  })
  .strict();
export type AppPortabilityProfile = z.infer<typeof appPortabilityProfileSchema>;

export const portableColumnSchema = z
  .object({
    name: identifier,
    type: z.string().min(1).max(300),
    nullable: z.boolean(),
    identity: z.enum(["", "a", "d"]),
    generated: z.enum(["", "s", "v"]),
  })
  .strict();
export const portableTableSchema = z
  .object({
    name: identifier,
    columns: z.array(portableColumnSchema).min(1).max(1600),
    rows: z.number().int().nonnegative().max(portabilityLimits.rows),
  })
  .strict();
export const portableDatabaseSchema = z
  .object({
    tables: z.array(portableTableSchema).max(portabilityLimits.tables),
    sequences: z
      .array(
        z
          .object({
            name: identifier,
            value: z.string().regex(/^-?\d+$/),
            called: z.boolean(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type PortableDatabase = z.infer<typeof portableDatabaseSchema>;

export const portableFileSchema = z
  .object({
    id: z.uuid(),
    ownerUserId: z.uuid().nullable(),
    access: z.enum(["user", "app"]),
    name: z.string().min(1).max(255),
    contentType: z.string().min(1).max(255),
    size: z.number().int().nonnegative().max(portabilityLimits.expandedBytes),
    sha256: digest,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type PortableFile = z.infer<typeof portableFileSchema>;

export const appPackageSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("opencloud.app-package"),
    mode: z.literal("full"),
    name: z.string().min(1).max(120),
    sourceAppId: z.uuid(),
    createdAt: z.iso.datetime(),
    sourceDeploymentId: z.uuid(),
    profile: appPortabilityProfileSchema,
    sourceSha256: digest,
    artifactSha256: digest,
    /** Digests cover every other ZIP entry, including the human-readable report. */
    entries: z.record(z.string(), digest),
  })
  .strict();
export type AppPackage = z.infer<typeof appPackageSchema>;

export const appImportReviewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  sha256: digest,
  bytes: z.number().int().nonnegative(),
  state: z.enum(["review", "installing", "ready", "published", "failed"]),
  tables: z.number().int().nonnegative(),
  rows: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  identities: z.array(z.uuid()),
  installerIdentities: z.array(z.uuid()),
  identityMappings: z.record(z.uuid(), z.uuid()).default({}),
  requirements: appInstallManifestSchema.shape.requirements,
  appId: z.uuid().nullable(),
  draftId: z.uuid().nullable(),
  expiresAt: z.iso.datetime(),
  error: z.string().nullable(),
});
export const installAppPackageRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    identityMappings: z.record(z.uuid(), z.uuid()),
  })
  .strict();
export type AppImportReview = z.infer<typeof appImportReviewSchema>;
