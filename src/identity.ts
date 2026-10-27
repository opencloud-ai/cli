import type { CredentialIdentity } from "@opencloud/contracts";
import { ApiError, type OpenCloudClient } from "./api-client.js";
import { brandText } from "./brand.js";

/** Where the CLI found the credential a command used. */
export type IdentitySource =
  | "environment-or-flag"
  | "account-login"
  | "workspace-credential"
  | "session-file";

export const IDENTITY_UNSUPPORTED =
  "This OpenCloud installation does not report the signed-in user yet.";

/**
 * The person behind the client's credential, or null when the installation
 * was released before it reported identities.
 */
export async function readIdentity(
  control: OpenCloudClient,
): Promise<CredentialIdentity | null> {
  try {
    return await control.call("getCurrentIdentity", {});
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Never fails the surrounding command: login state is useful on its own. */
export async function signedInUser(
  control: OpenCloudClient,
): Promise<
  | { user: CredentialIdentity["user"] }
  | { user: null; userUnavailable: string }
> {
  try {
    const identity = await readIdentity(control);
    return identity
      ? { user: identity.user }
      : { user: null, userUnavailable: brandText(IDENTITY_UNSUPPORTED) };
  } catch (error) {
    return {
      user: null,
      userUnavailable: brandText(error instanceof Error ? error.message : String(error)),
    };
  }
}
