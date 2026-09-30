import { z } from "zod";

export const exactOrganisationQuantitySchema = z.string().regex(/^(0|[1-9][0-9]{0,39})$/);
export const organisationLimitSchema = exactOrganisationQuantitySchema.nullable();
export const organisationTimeZoneSchema = z.string().max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Choose an IANA time zone");
export const organisationIdentitySchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  status: z.enum(["active", "suspended"]),
  policyVersion: exactOrganisationQuantitySchema,
});
export const organisationPersonSchema = z.object({
  organisationId: z.uuid(), userId: z.uuid(), role: z.enum(["admin", "member"]),
  email: z.email(), displayName: z.string().nullable(),
});
export const organisationOwnershipSchema = z.object({
  appId: z.uuid(), organisationId: z.uuid(), creatorUserId: z.uuid(),
  ownershipVersion: exactOrganisationQuantitySchema,
});
export const organisationOnlyContextSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("personal"), organisation: z.null() }).strict(),
  z.object({ state: z.literal("active"), organisation: organisationIdentitySchema,
    role: z.enum(["admin", "member"]), capabilities: z.object({
      manageOrganisation: z.boolean(), inviteMembers: z.boolean(), manageLimits: z.boolean(), leaveOrganisation: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({ state: z.enum(["removed", "suspended"]), organisation: organisationIdentitySchema.pick({ id: true, name: true }) }).strict(),
]);
export const organisationOnlyInvitationSchema = z.object({
  id: z.uuid(), organisationId: z.uuid(), recipientEmail: z.email(),
  organisationRole: z.enum(["admin", "member"]),
  expiresAt: z.iso.datetime(), acceptedAt: z.iso.datetime().nullable(), revokedAt: z.iso.datetime().nullable(),
});
export type OrganisationOnlyContext = z.infer<typeof organisationOnlyContextSchema>;
export type OrganisationOwnership = z.infer<typeof organisationOwnershipSchema>;
