import { z } from "zod";

export const domainCoordinatesSchema = z
  .object({
    bindingId: z.uuid(),
    generation: z.number().int().positive(),
    appId: z.uuid(),
    hostname: z.string().min(1).max(253),
    origin: z.url(),
  })
  .strict();
export type DomainCoordinates = z.infer<typeof domainCoordinatesSchema>;
export const appDomainAddSchema = z
  .object({ hostname: z.string().trim().min(1).max(254) })
  .strict();
export const appDomainObservationSchema = z
  .object({
    status: z.enum(["pending", "ok", "failed"]),
    checkedAt: z.iso.datetime().nullable(),
    code: z.string().max(80).nullable(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict();
export const appDomainDnsRecordSchema = z
  .object({
    type: z.enum(["TXT", "CNAME", "A", "AAAA"]),
    name: z.string(),
    value: z.string(),
    purpose: z.enum(["ownership", "traffic", "certificate"]),
    optional: z.boolean(),
  })
  .strict();
export const appDomainBindingSchema = domainCoordinatesSchema.extend({
  apex: z.boolean(),
  status: z.enum(["setting_up", "connected", "needs_attention"]),
  verification: appDomainObservationSchema,
  publicHttps: appDomainObservationSchema,
  originHttps: appDomainObservationSchema,
  serving: appDomainObservationSchema,
  certificateMethod: z.enum(["http01", "dns01"]),
  records: z.array(appDomainDnsRecordSchema),
  warnings: z.array(z.string().max(240)).max(10),
  createdAt: z.iso.datetime(),
  pendingExpiresAt: z.iso.datetime(),
});
export const appDomainSettingsSchema = z
  .object({
    available: z.boolean(),
    unavailableReason: z.string().max(240).nullable(),
    binding: appDomainBindingSchema.nullable(),
    cleanupPending: z.boolean(),
  })
  .strict();
export type AppDomainSettings = z.infer<typeof appDomainSettingsSchema>;
export type AppDomainBinding = z.infer<typeof appDomainBindingSchema>;

// The adapter is a trusted installation process. It never receives upstreams,
// file paths, private keys or arbitrary proxy settings from app owners.
export const appDomainIngressHostSchema = domainCoordinatesSchema.extend({
  certificateMethod: z.enum(["http01", "dns01"]),
});
export const appDomainIngressSnapshotSchema = z
  .object({
    installationId: z.string().min(1).max(63),
    generation: z.number().int().nonnegative(),
    hosts: z.array(appDomainIngressHostSchema).max(10000),
    retirements: z.array(domainCoordinatesSchema).max(10000),
  })
  .strict();
export type AppDomainIngressSnapshot = z.infer<
  typeof appDomainIngressSnapshotSchema
>;
export const appDomainIngressAckSchema = z
  .object({
    generation: z.number().int().nonnegative(),
    retiredBindingIds: z.array(z.uuid()).max(10000).default([]),
  })
  .strict();
export const appDomainReadinessSchema = domainCoordinatesSchema.extend({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
