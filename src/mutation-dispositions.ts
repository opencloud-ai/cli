export const MUTATION_RECOVERY_DISPOSITIONS = [
  "bootstrap_explicit_server_replay",
  "credential_orphan_expiry",
  "durable_operation",
  "server_replay",
  "intrinsic_reconcile",
  "fail_closed_unknown",
  "workflow",
] as const;

export type MutationRecoveryDisposition =
  (typeof MUTATION_RECOVERY_DISPOSITIONS)[number];

export interface MutationDispositionRecord {
  boundary: "account_bootstrap" | "exact_app";
  recovery: MutationRecoveryDisposition;
  reason: string;
}

/**
 * Exhaustive registry of exact-app journal leaves plus the two app-bootstrap
 * leaves that establish an exact-app boundary.
 *
 * Account/OAuth and legacy-onboarding mutations are intentionally outside the
 * exact-app journal and are inventoried separately below. The release contract
 * compares these keys with the Commander tree and audits exact-app mutating
 * call sites in the CLI entrypoint.
 */
export const mutationDispositionRegistry = {
  "opencloud app domain add": {
    boundary: "exact_app",
    recovery: "server_replay",
    reason: "Domain ownership receipts replay the exact hostname claim using the retained idempotency key.",
  },
  "opencloud app domain check": {
    boundary: "exact_app",
    recovery: "server_replay",
    reason: "Domain check receipts replay reconciliation scheduling without repeating the effect.",
  },
  "opencloud app domain remove": {
    boundary: "exact_app",
    recovery: "server_replay",
    reason: "Domain removal receipts replay binding removal and cleanup status for the same key.",
  },
  "opencloud app create": {
    boundary: "account_bootstrap",
    recovery: "bootstrap_explicit_server_replay",
    reason:
      "The caller must provide a stable key; the server replays the app and operation before an app journal exists.",
  },
  "opencloud app connect": {
    boundary: "account_bootstrap",
    recovery: "credential_orphan_expiry",
    reason:
      "The unkeyed credential exchange precedes an exact-app journal; a lost response can orphan only the bounded 24-hour credential and a rerun mints a replacement.",
  },
  "opencloud app dev start": {
    boundary: "exact_app",
    recovery: "workflow",
    reason: "Draft creation, synchronization, validation, and session start are checkpointed.",
  },
  "opencloud app dev sync": {
    boundary: "exact_app",
    recovery: "workflow",
    reason: "Draft synchronization and revision activation are checkpointed.",
  },
  "opencloud app dev data": {
    boundary: "exact_app",
    recovery: "server_replay",
    reason: "The dev-effect receipt replays the same idempotency key and request digest.",
  },
  "opencloud app dev email inject": {
    boundary: "exact_app",
    recovery: "server_replay",
    reason: "The dev-effect receipt replays the same idempotency key and request digest.",
  },
  "opencloud app dev invoke": {
    boundary: "exact_app",
    recovery: "server_replay",
    reason: "The dev-effect receipt replays the same idempotency key and request digest.",
  },
  "opencloud app dev verify": {
    boundary: "exact_app",
    recovery: "intrinsic_reconcile",
    reason: "The exact session revision and durable verification receipts reconcile an ambiguous request.",
  },
  "opencloud app dev promote": {
    boundary: "exact_app",
    recovery: "workflow",
    reason: "Promotion, production verification, and dev cleanup are checkpointed.",
  },
  "opencloud app dev stop": {
    boundary: "exact_app",
    recovery: "intrinsic_reconcile",
    reason: "Stopping an already stopped session converges on the same target state.",
  },
  "opencloud app verify": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The operation and verification identifiers are retained before polling.",
  },
  "opencloud app configure": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The configuration operation is recovered by operation identifier.",
  },
  "opencloud app restart": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The lifecycle operation is recovered by operation identifier.",
  },
  "opencloud app archive": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The lifecycle operation is recovered by operation identifier.",
  },
  "opencloud app unarchive": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The lifecycle operation is recovered by operation identifier.",
  },
  "opencloud app delete": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The retained deletion operation remains the terminal recovery coordinate.",
  },
  "opencloud app access add": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The access operation is recovered by operation identifier.",
  },
  "opencloud app access grant": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The access operation is recovered by operation identifier.",
  },
  "opencloud app access revoke": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The access operation is recovered by operation identifier.",
  },
  "opencloud app access builder-add": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The access operation is recovered by operation identifier.",
  },
  "opencloud app access builder-remove": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The access operation is recovered by operation identifier.",
  },
  "opencloud app access-token create": {
    boundary: "exact_app",
    recovery: "server_replay",
    reason: "The same key replays the same protected reveal delivery.",
  },
  "opencloud app access-token request": {
    boundary: "exact_app",
    recovery: "server_replay",
    reason: "The same key replays the protected approval-link response without retaining the URL.",
  },
  "opencloud app access-token revoke": {
    boundary: "exact_app",
    recovery: "intrinsic_reconcile",
    reason: "Revocation of the exact token is convergent.",
  },
  "opencloud app credential-revoke": {
    boundary: "exact_app",
    recovery: "intrinsic_reconcile",
    reason: "Revocation of the exact credential is convergent.",
  },
  "opencloud app credential-create": {
    boundary: "exact_app",
    recovery: "server_replay",
    reason: "The same key deterministically replays material for protected file delivery.",
  },
  "opencloud draft create": {
    boundary: "exact_app",
    recovery: "server_replay",
    reason: "Draft creation retains and reuses its server idempotency key.",
  },
  "opencloud draft apply": {
    boundary: "exact_app",
    recovery: "intrinsic_reconcile",
    reason: "Expected revision and resulting file hashes reconcile an ambiguous apply.",
  },
  "opencloud draft validate": {
    boundary: "exact_app",
    recovery: "intrinsic_reconcile",
    reason: "Validation of the same immutable draft revision is convergent.",
  },
  "opencloud draft deploy": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The deployment operation is recovered by operation identifier.",
  },
  "opencloud draft discard": {
    boundary: "exact_app",
    recovery: "intrinsic_reconcile",
    reason: "Discarding the exact draft is convergent.",
  },
  "opencloud deploy": {
    boundary: "exact_app",
    recovery: "workflow",
    reason: "Draft creation, batched apply, validation, and deployment are checkpointed.",
  },
  "opencloud deployment rollback": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The rollback operation is recovered by operation identifier.",
  },
  "opencloud deployment delete": {
    boundary: "exact_app",
    recovery: "intrinsic_reconcile",
    reason: "Deletion of the exact inactive deployment is convergent.",
  },
  "opencloud cron invoke": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The invocation operation is recovered by operation identifier.",
  },
  "opencloud secret set": {
    boundary: "exact_app",
    recovery: "server_replay",
    reason: "The server-keyed replay fingerprint rejects changed input; the journal retains no secret-derived data.",
  },
  "opencloud secret rotate": {
    boundary: "exact_app",
    recovery: "server_replay",
    reason: "The same key replays rotation metadata without exposing generated material.",
  },
  "opencloud secret configure": {
    boundary: "exact_app",
    recovery: "server_replay",
    reason: "The same key replays the protected entry-link response without retaining the URL.",
  },
  "opencloud secret delete": {
    boundary: "exact_app",
    recovery: "intrinsic_reconcile",
    reason: "Deletion of the exact secret name is convergent.",
  },
  "opencloud backup create": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The backup operation is recovered by operation identifier.",
  },
  "opencloud backup restore": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The restore operation is recovered by operation identifier.",
  },
  "opencloud backup schedule": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The schedule operation is recovered by operation identifier.",
  },
  "opencloud data create": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The production-data operation is recovered by operation identifier.",
  },
  "opencloud data create-many": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The production-data operation is recovered by operation identifier.",
  },
  "opencloud data update": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The production-data operation is recovered by operation identifier.",
  },
  "opencloud data delete": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The production-data operation is recovered by operation identifier.",
  },
  "opencloud function invoke": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The Function operation is recovered by operation identifier.",
  },
  "opencloud file upload": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The upload operation is recovered by operation identifier.",
  },
  "opencloud file replace": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The replacement operation is recovered by operation identifier.",
  },
  "opencloud file delete": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The deletion operation is recovered by operation identifier.",
  },
  "opencloud integration bind": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The binding operation is recovered by operation identifier.",
  },
  "opencloud integration unbind": {
    boundary: "exact_app",
    recovery: "durable_operation",
    reason: "The unbinding operation is recovered by operation identifier.",
  },
  "opencloud alert-rule put": {
    boundary: "exact_app",
    recovery: "intrinsic_reconcile",
    reason: "Replacing the exact rule with the same definition is convergent.",
  },
  "opencloud alert-rule delete": {
    boundary: "exact_app",
    recovery: "intrinsic_reconcile",
    reason: "Deleting the exact rule is convergent.",
  },
} as const satisfies Record<string, MutationDispositionRecord>;

export const NON_JOURNAL_RECOVERY_DISPOSITIONS = [
  "device_flow_resume_or_expire",
  "rotating_credential_reauthenticate",
  "intrinsic_revocation_retry",
  "session_file_server_replay",
  "single_use_completion_or_expiry",
  "explicit_server_replay",
  "credential_orphan_expiry",
] as const;

export type NonJournalRecoveryDisposition =
  (typeof NON_JOURNAL_RECOVERY_DISPOSITIONS)[number];

export interface NonJournalMutationRecord {
  sourceFile: "src/account-auth.ts" | "src/index.ts" | "src/workspace-auth.ts";
  sourceFunction?: string | undefined;
  operation: string;
  commanderLeaves: readonly string[];
  entryPoints: readonly string[];
  recovery: NonJournalRecoveryDisposition;
  reason: string;
}

/**
 * Explicit inventory of remote mutations outside the exact-app journal.
 * These flows either establish/maintain authority or run before an app-scoped
 * journal can exist. Their bounded recovery limitations are part of the public
 * release contract rather than being mislabeled as journal-safe.
 */
export const nonJournalMutationInventory = {
  "account.device_authorization": {
    sourceFile: "src/account-auth.ts",
    sourceFunction: "beginDeviceAuthorization",
    operation: "postForm",
    commanderLeaves: ["opencloud login"],
    entryPoints: ["login"],
    recovery: "device_flow_resume_or_expire",
    reason:
      "A device code is bounded and no account authority exists until browser approval completes.",
  },
  "account.device_token_poll": {
    sourceFile: "src/account-auth.ts",
    sourceFunction: "completeDeviceAuthorization",
    operation: "postForm",
    commanderLeaves: ["opencloud login"],
    entryPoints: ["login"],
    recovery: "device_flow_resume_or_expire",
    reason:
      "Polling the same bounded device code converges until approval or expiry.",
  },
  "account.refresh": {
    sourceFile: "src/account-auth.ts",
    sourceFunction: "freshAccountCredential",
    operation: "postForm",
    commanderLeaves: ["opencloud login", "opencloud auth status"],
    entryPoints: ["account-backed management", "workspace credential renewal"],
    recovery: "rotating_credential_reauthenticate",
    reason:
      "A lost rotating-refresh response may require a new browser login; it is credential maintenance, not an app mutation.",
  },
  "account.revoke": {
    sourceFile: "src/account-auth.ts",
    sourceFunction: "revokeAccountCredential",
    operation: "postForm",
    commanderLeaves: [
      "opencloud login",
      "opencloud auth logout",
      "opencloud logout",
    ],
    entryPoints: ["login --force", "auth logout", "logout"],
    recovery: "intrinsic_revocation_retry",
    reason:
      "OAuth revocation of the same refresh credential is retried until local credential removal can finish.",
  },
  "legacy_onboarding.start": {
    sourceFile: "src/index.ts",
    operation: "POST /v1/onboarding/agent",
    commanderLeaves: ["opencloud onboard"],
    entryPoints: ["onboard"],
    recovery: "session_file_server_replay",
    reason:
      "The protected onboarding session stores the request and stable key before the request is sent.",
  },
  "legacy_onboarding.complete": {
    sourceFile: "src/index.ts",
    operation: "POST /v1/onboarding/agent/{}/complete",
    commanderLeaves: ["opencloud onboard-complete"],
    entryPoints: ["onboard-complete"],
    recovery: "single_use_completion_or_expiry",
    reason:
      "The retained completion token can be retried, but this legacy unkeyed boundary is not claimed as crash-safe server replay.",
  },
  "app.create": {
    sourceFile: "src/index.ts",
    operation: "control:createApp",
    commanderLeaves: ["opencloud app create"],
    entryPoints: ["app create"],
    recovery: "explicit_server_replay",
    reason:
      "A caller-supplied stable key makes server replay deterministic before the new app has a journal.",
  },
  "app.connect": {
    sourceFile: "src/workspace-auth.ts",
    sourceFunction: "connectWorkspace",
    operation: "control:connectCliWorkspace",
    commanderLeaves: ["opencloud app connect"],
    entryPoints: ["app connect", "workspace credential renewal"],
    recovery: "credential_orphan_expiry",
    reason:
      "The endpoint is unkeyed; a response lost before protected storage can orphan one bounded 24-hour credential, which expires and is replaced on rerun.",
  },
} as const satisfies Record<string, NonJournalMutationRecord>;

export type MutationCommandId = keyof typeof mutationDispositionRegistry;

export function mutationDisposition(
  commandId: string,
): MutationDispositionRecord {
  const value = (
    mutationDispositionRegistry as Record<
      string,
      MutationDispositionRecord | undefined
    >
  )[commandId];
  if (!value) {
    throw new Error(`Remote mutation has no recovery disposition: ${commandId}`);
  }
  return value;
}
