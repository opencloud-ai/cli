import { z } from "zod";
import { appSharePermissionSchema } from "./organisation-directory.js";

/**
 * App invitations (personal installations). An app admin invites an email
 * address to use (`view`) or administer (`edit`) one app. Accepting grants
 * exactly that app; it never makes the person a member of the owner's
 * account and does not depend on the app's private/public setting.
 */

/** The invitation email. `retrying`: an attempt failed and repeats shortly;
 * `unknown`: the provider may or may not have sent it. */
export const appInvitationDeliverySchema = z.object({
  state: z.enum(["sending", "retrying", "sent", "unknown"]),
  sentAt: z.iso.datetime().nullable(),
}).strict();

/** An open invitation: not accepted and not cancelled. It may have expired. */
export const appInvitationSchema = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  recipientEmail: z.email(),
  permission: appSharePermissionSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** The inviting admin's name, or their email without one. */
  invitedBy: z.string().nullable(),
  delivery: appInvitationDeliverySchema.nullable(),
}).strict();

const appPersonSchema = z.object({
  userId: z.uuid(),
  email: z.email(),
  displayName: z.string().nullable(),
}).strict();

/** Someone who accepted an invitation and still has this app. */
export const appInvitedPersonSchema = appPersonSchema.extend({
  permission: appSharePermissionSchema,
  addedAt: z.iso.datetime(),
}).strict();

export const appInvitationsViewSchema = z.object({
  appId: z.uuid(),
  /** False where the app's people come from an organisation instead. */
  available: z.boolean(),
  /** The account that owns the app. It always keeps full access. */
  owner: appPersonSchema.nullable(),
  people: z.array(appInvitedPersonSchema),
  invitations: z.array(appInvitationSchema),
}).strict();

export const createAppInvitationRequestSchema = z.object({
  recipientEmail: z.email().max(320).transform((value) => value.toLowerCase()),
  permission: appSharePermissionSchema,
}).strict();

export const appInvitationPermissionRequestSchema = z.object({
  permission: appSharePermissionSchema,
}).strict();

export const appInvitationTokenRequestSchema = z.object({
  token: z.string().min(32).max(256),
}).strict();

/** What the holder of an invitation link sees before accepting it. */
export const appInvitationPreviewSchema = z.object({
  invitationId: z.uuid(),
  appId: z.uuid(),
  appName: z.string(),
  /** The app's own address; null before it has one. */
  appUrl: z.url().nullable(),
  permission: appSharePermissionSchema,
  recipientEmail: z.email(),
  invitedBy: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  status: z.enum(["pending", "accepted", "revoked", "expired"]),
  /** The signed-in account's email, and whether it is the invited address. */
  accountEmail: z.email(),
  emailMatches: z.boolean(),
  /** The signed-in account's current access to the app. */
  access: z.enum(["none", "view", "edit"]),
}).strict();

/** The accepted app. The operation output adds the access reconciliation. */
export const acceptedAppInvitationSchema = z.object({
  appId: z.uuid(),
  appName: z.string(),
  permission: appSharePermissionSchema,
  /** The app's own address, to open it; null before it has one. */
  appUrl: z.url().nullable(),
}).strict();

export type AppInvitation = z.infer<typeof appInvitationSchema>;
export type AppInvitedPerson = z.infer<typeof appInvitedPersonSchema>;
export type AppInvitationsView = z.infer<typeof appInvitationsViewSchema>;
export type AppInvitationPreview = z.infer<typeof appInvitationPreviewSchema>;
