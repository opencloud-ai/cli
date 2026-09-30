import { z } from "zod";
export const organisationEmailDomainSchema = z.object({
  id: z.uuid(), organisationId: z.uuid(), domain: z.string().min(1).max(253),
  generation: z.string().regex(/^[1-9][0-9]*$/),
  enabled: z.boolean(), status: z.enum(["pending", "verified", "expired", "proof_lost"]),
  txtName: z.string(), txtValue: z.string(),
  verifiedAt: z.iso.datetime().nullable(), validUntil: z.iso.datetime().nullable(),
});
export const organisationHostSchema = z.object({
  organisationId: z.uuid(), handle: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  hostname: z.string(), generation: z.string().regex(/^[1-9][0-9]*$/),
  status: z.enum(["pending", "provisioning", "ready", "failed", "retired"]),
  readyAt: z.iso.datetime().nullable(),
});
