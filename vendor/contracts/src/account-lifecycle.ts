import { z } from "zod";

/**
 * Account lifecycle states. `suspended` is a reversible platform-administrator
 * hold. `deleted` means permanent deletion was requested; the account record is
 * removed, or anonymised when retained organisation records still refer to it.
 */
export const accountStatusSchema = z.enum([
  "pending_email_verification",
  "active",
  "expired_unverified",
  "suspended",
  "deleted",
]);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

/** A destructive account action needs a browser sign-in this recent. */
export const ACCOUNT_DELETION_RECENT_SIGN_IN_SECONDS = 10 * 60;

const confirmationEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .pipe(z.email());

/** The signed-in account's email, typed again as explicit confirmation. */
export const accountDeletionRequestSchema = z
  .object({ confirmationEmail: confirmationEmailSchema })
  .strict();
export type AccountDeletionRequest = z.infer<typeof accountDeletionRequestSchema>;

export const accountDeletionSchema = z
  .object({
    state: z.literal("deleting"),
    operationId: z.uuid(),
    requestedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type AccountDeletion = z.infer<typeof accountDeletionSchema>;

/** Stable error codes the dashboard maps to recovery actions. */
export const ACCOUNT_DELETION_ERROR_CODES = {
  recentSignInRequired: "ACCOUNT_RECENT_SIGN_IN_REQUIRED",
  confirmationMismatch: "ACCOUNT_DELETION_CONFIRMATION_MISMATCH",
  platformAdministrator: "ACCOUNT_DELETION_PLATFORM_ADMINISTRATOR",
  lastOrganisationAdministrator: "ACCOUNT_DELETION_LAST_ORGANISATION_ADMIN",
  unavailable: "ACCOUNT_DELETION_UNAVAILABLE",
} as const;
