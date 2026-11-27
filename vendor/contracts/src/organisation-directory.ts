import { z } from "zod";
import { sameRequestedWorkspace } from "./api-core.js";

/** Organisation directory and retained accounting contracts. */
/** Exact non-negative quantities; callers must use bigint for arithmetic. */
export const capacityQuantitySchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,39})$/);
export const organisationRoleSchema = z.enum(["admin", "member"]);
export const workspaceRoleSchema = organisationRoleSchema;
export const appSharePermissionSchema = z.enum(["edit", "view"]);
export const directoryNameSchema = z.string().trim().min(1).max(120);
export const workspacePlanSchema = z.enum(["free", "core", "scale", "enterprise"]);
export type WorkspacePlan = z.infer<typeof workspacePlanSchema>;
/** Maximum active Free workspaces an account may administer at once. */
export const MAX_FREE_WORKSPACES_PER_USER = 3;
/**
 * `workspaceId` is the canonical name of a workspace's ID; `organisationId`
 * is the older name for the same value. Workspace responses carry both, so
 * clients that read `organisationId` keep working.
 */
export const workspaceIdAliasSchema = z
  .uuid()
  .optional()
  .describe("The same ID as organisationId; workspaceId is its canonical name.");
/** Adds `workspaceId`, the canonical name of `organisationId`, to a response. */
export function withWorkspaceId<T extends { organisationId: string }>(
  value: T,
): T & { workspaceId: string } {
  return { ...value, workspaceId: value.organisationId };
}
export const organisationSchema = z.object({
  id: z.uuid(),
  name: directoryNameSchema,
  status: z.enum(["active", "suspended"]),
  policyVersion: capacityQuantitySchema,
  plan: workspacePlanSchema.default("free"),
});
export const workspaceSchema = z.object({
  id: z.uuid(),
  organisationId: z.uuid(),
  name: directoryNameSchema,
  status: z.enum(["active", "archived"]),
  isDefault: z.boolean(),
});
export const organisationMembershipSchema = z.object({
  organisationId: z.uuid(),
  workspaceId: workspaceIdAliasSchema,
  userId: z.uuid(),
  role: organisationRoleSchema,
});
export const workspaceMembershipSchema = z.object({
  organisationId: z.uuid(),
  workspaceId: z.uuid(),
  userId: z.uuid(),
  role: workspaceRoleSchema,
});
/** The invitation email. `retrying`: an attempt failed and repeats shortly;
 * `unknown`: the provider may or may not have sent it. */
export const organisationInvitationDeliverySchema = z.object({
  state: z.enum(["sending", "retrying", "sent", "unknown"]),
  sentAt: z.iso.datetime().nullable(),
});
export const organisationInvitationSchema = z.object({
  id: z.uuid(),
  organisationId: z.uuid(),
  workspaceId: workspaceIdAliasSchema,
  recipientEmail: z.email(),
  organisationRole: organisationRoleSchema,
  expiresAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime().optional(),
  /** The inviting admin's name, or their email without one. */
  invitedBy: z.string().nullable().optional(),
  /** Null once the invitation is accepted or revoked. */
  delivery: organisationInvitationDeliverySchema.nullable().optional(),
});
/** What the holder of an invitation link sees before accepting it. */
export const organisationInvitationPreviewSchema = z.object({
  invitationId: z.uuid(),
  organisationId: z.uuid(),
  workspaceId: workspaceIdAliasSchema,
  organisationName: z.string(),
  organisationRole: organisationRoleSchema,
  recipientEmail: z.email(),
  invitedBy: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  status: z.enum(["pending", "accepted", "revoked", "expired"]),
  /** The signed-in account's email, and whether it is the invited address. */
  accountEmail: z.email(),
  emailMatches: z.boolean(),
  /** `member`: already in this organisation. `other_organisation`: the
   * account belongs to another company, so it cannot accept. */
  membership: z.enum(["none", "member", "other_organisation"]),
});
export const organisationContextSchema = z.object({
  organisation: organisationSchema,
  membership: organisationMembershipSchema,
});
export const createOrganisationRequestSchema = z
  .object({ name: directoryNameSchema, autoJoinEmailDomain: z.boolean().optional() })
  .strict();
export const updateOrganisationRequestSchema = z.object({ name: directoryNameSchema }).strict();
/** `workspaceId`, or `organisationId` as its older name; two different values are refused. */
export const setActiveWorkspaceRequestSchema = z
  .object({
    workspaceId: z.uuid().optional(),
    organisationId: z.uuid().optional().describe("Older name for workspaceId."),
  })
  .strict()
  .superRefine(sameRequestedWorkspace)
  .refine((value) => Boolean(value.workspaceId ?? value.organisationId), {
    path: ["workspaceId"],
    message: "Send the workspace's workspaceId",
  });
export const createWorkspaceRequestSchema = z
  .object({ name: directoryNameSchema })
  .strict();
export const updateWorkspaceRequestSchema = createWorkspaceRequestSchema;
export const createOrganisationInvitationRequestSchema = z
  .object({
    recipientEmail: z.email().transform((value) => value.toLowerCase()),
    organisationRole: organisationRoleSchema.default("member"),
  })
  .strict();
export const acceptOrganisationInvitationRequestSchema = z
  .object({ token: z.string().min(32).max(256) })
  .strict();
export const setPrimaryWorkspaceRequestSchema = z
  .object({
    workspaceId: z.uuid(),
    removePreviousMembership: z.boolean().default(false),
  })
  .strict();
export const setOrganisationMemberRoleRequestSchema = z
  .object({ role: organisationRoleSchema })
  .strict();
export const setWorkspaceMemberRequestSchema = z
  .object({ role: workspaceRoleSchema })
  .strict();
export const removeWorkspaceMemberRequestSchema = z
  .object({ replacementWorkspaceId: z.uuid().optional() })
  .strict();
export const appShareRecipientSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), userId: z.uuid() }).strict(),
  z.object({ type: z.literal("workspace"), workspaceId: z.uuid() }).strict(),
]);
export const appShareSchema = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  recipient: appShareRecipientSchema,
  permission: appSharePermissionSchema,
});
export const appPlacementSchema = z.object({
  appId: z.uuid(),
  organisationId: z.uuid(),
  workspaceId: z.uuid(),
  creatorUserId: z.uuid(),
  placementVersion: capacityQuantitySchema,
});
export const payerSnapshotSchema = z.object({
  organisationId: z.uuid(),
  workspaceId: z.uuid().nullable(),
  placementVersion: capacityQuantitySchema.nullable(),
});
export type Organisation = z.infer<typeof organisationSchema>;
export type OrganisationWorkspace = z.infer<typeof workspaceSchema>;
export type OrganisationMembership = z.infer<
  typeof organisationMembershipSchema
>;
export type WorkspaceMembership = z.infer<typeof workspaceMembershipSchema>;
export type OrganisationInvitation = z.infer<
  typeof organisationInvitationSchema
>;
export type OrganisationInvitationPreview = z.infer<
  typeof organisationInvitationPreviewSchema
>;
export type OrganisationContext = z.infer<typeof organisationContextSchema>;
export type OrganisationRole = z.infer<typeof organisationRoleSchema>;
export type AppSharePermission = z.infer<typeof appSharePermissionSchema>;
export type AppShareRecipient = z.infer<typeof appShareRecipientSchema>;
export type AppPlacement = z.infer<typeof appPlacementSchema>;
export type PayerSnapshot = z.infer<typeof payerSnapshotSchema>;

export const APP_MANAGEMENT_ACTIONS = [
  "app.read",
  "app.logs.read",
  "app.agent.read",
  "app.open",
  "app.agent.send",
  "app.agent.cancel",
  "app.deploy",
  "app.settings.write",
  "app.shares.write",
  "app.domains.write",
  "app.secrets.write",
  "app.integrations.write",
  "app.credentials.write",
  "app.delete",
  "app.restore",
] as const;
export const appManagementActionSchema = z.enum(APP_MANAGEMENT_ACTIONS);
export type AppManagementAction = z.infer<typeof appManagementActionSchema>;
export const APP_ACTION_PERMISSIONS: Readonly<
  Record<AppManagementAction, "view" | "edit" | "organisation_admin">
> = {
  "app.read": "view",
  "app.logs.read": "edit",
  "app.agent.read": "edit",
  "app.open": "view",
  "app.agent.send": "edit",
  "app.agent.cancel": "edit",
  "app.deploy": "edit",
  "app.settings.write": "edit",
  "app.shares.write": "edit",
  "app.domains.write": "edit",
  "app.secrets.write": "edit",
  "app.integrations.write": "edit",
  "app.credentials.write": "edit",
  "app.delete": "edit",
  "app.restore": "edit",
};
export const appCapabilitiesSchema = z.object({
  actions: z.array(appManagementActionSchema),
  effectivePermission: appSharePermissionSchema.nullable(),
  authoritySource: z.enum(["share", "organisation_admin"]).nullable(),
  policyVersion: capacityQuantitySchema,
});
export const directoryCapabilitiesSchema = z.object({
  manageOrganisation: z.boolean(),
  inviteMembers: z.boolean(),
  manageLimits: z.boolean(),
  leaveOrganisation: z.boolean(),
  /** A Free workspace you created and still administer: it counts toward
   * MAX_FREE_WORKSPACES_PER_USER. */
  countsTowardFreeLimit: z.boolean().optional(),
});
export const workspaceCapabilitiesSchema = z.object({
  manageMembers: z.boolean(),
  manageWorkspace: z.boolean(),
  createApp: z.boolean(),
  setPrimary: z.boolean(),
  archive: z.boolean(),
});
export const organisationMemberViewSchema = organisationMembershipSchema.extend(
  {
    email: z.email(),
    displayName: z.string().nullable(),
  },
);
export const workspaceMemberViewSchema = workspaceMembershipSchema.extend({
  email: z.email(),
  displayName: z.string().nullable(),
  isPrimary: z.boolean(),
});
/**
 * Scale-and-Enterprise features this workspace has now: its current plan
 * includes them, or the installation sells no plans. A downgrade removes them
 * at once; what they already set up (members who joined by email domain,
 * published workspace addresses) stays.
 */
export const workspacePlanFeaturesSchema = z.object({
  /** New accounts with a confirmed email at a verified, enabled domain join automatically. */
  verifiedDomainAutoJoin: z.boolean(),
  /** New workspace addresses (`<workspace>.<base>` and `<app>.<workspace>.<base>`) can be claimed and activated. */
  workspaceSubdomain: z.boolean(),
  /** 90-day workspace activity log and CSV export. */
  auditLog: z.boolean().optional(),
  /** Workspace security policies (no public apps, delete protection, admin-only publish, email-link-only sign-in). */
  securityPolicies: z.boolean().optional(),
  /** Workspace alert webhooks (app errors and repairs, spending, AI credit). */
  alertWebhooks: z.boolean().optional(),
});
export type WorkspacePlanFeatures = z.infer<typeof workspacePlanFeaturesSchema>;
export const organisationDirectoryViewSchema = organisationContextSchema.extend(
  {
    capabilities: directoryCapabilitiesSchema,
    /** Absent from releases before plans gated these features. */
    planFeatures: workspacePlanFeaturesSchema.optional(),
  },
);
export type OrganisationDirectoryView = z.infer<
  typeof organisationDirectoryViewSchema
>;
export const accountOrganisationContextSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("personal"), organisation: z.null() }).strict(),
  z.object({ state: z.literal("onboarding_required"), organisation: z.null() }).strict(),
  z.object({ state: z.literal("active"), directory: organisationDirectoryViewSchema }).strict(),
  z.object({
    state: z.enum(["removed", "suspended"]),
    organisation: z.object({ id: z.uuid(), name: directoryNameSchema }).strict(),
  }).strict(),
]);
export type AccountOrganisationContext = z.infer<typeof accountOrganisationContextSchema>;
export const capacityMetricSchema = z.enum([
  "app_count",
  "file_bytes",
  "agent_concurrency",
  "ai_cost",
  /** Company organisations only: current members against the member ceiling. */
  "member_count",
]);
export const capacityUsageVectorSchema = z
  .object({
    agent_tokens: capacityQuantitySchema,
    agent_concurrency: capacityQuantitySchema,
    ai_cost: capacityQuantitySchema,
  })
  .strict();
export const capacityAdmissionReceiptSchema = z.object({
  admissionId: z.uuid(),
  state: z.enum(["reserved", "unknown", "settled", "released", "denied"]),
  payer: payerSnapshotSchema,
  period: z.string(),
  maximum: capacityUsageVectorSchema,
  denialCode: z.string().nullable(),
});
