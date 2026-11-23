import type { OpenCloudClient } from "./api-client.js";
import { CliContractError } from "./owner-parity.js";

/**
 * The compatibility markers /version advertises, read tolerantly: a marker
 * counts only when it is exactly 1. Any other value, or a shape this CLI does
 * not know, reads as absent (the earlier behaviour) rather than failing every
 * journaled command with API_CONTRACT_MISMATCH.
 */
async function platformContracts(control: Pick<OpenCloudClient, "get">): Promise<Record<string, unknown>> {
  const value = await control.get("/version", { cacheControl: "no-cache" });
  const contracts = value && typeof value === "object" ? (value as { contracts?: unknown }).contracts : undefined;
  return contracts && typeof contracts === "object" && !Array.isArray(contracts)
    ? (contracts as Record<string, unknown>)
    : {};
}

export async function assertMutationJournalCompatibility(
  control: Pick<OpenCloudClient, "get">,
): Promise<void> {
  if ((await platformContracts(control)).cliMutationJournal !== 1) {
    throw new CliContractError(
      "CLI_MUTATION_JOURNAL_UNSUPPORTED",
      "This OpenCloud API does not advertise CLI mutation journal contract 1; no mutation was started",
    );
  }
}

export interface ReleaseContracts {
  /** Releases keep their draft source and can be downloaded. */
  releaseSource: boolean;
  /** Deploys and dev starts honour expectedActiveDeploymentId. */
  deployPreconditions: boolean;
  /** Validation builds a frontend that declares frontend.build. */
  platformBuilds: boolean;
  /**
   * Validation honours expectedRevision: a request joins that revision's run
   * and answers DRAFT_VALIDATION_IN_PROGRESS while it lasts. Without it
   * (2.35.x and older), the CLI keeps 3.20's flow; see draft-validation.ts.
   */
  pinnedDraftValidation: boolean;
}

const releaseContractCache = new WeakMap<object, Promise<ReleaseContracts>>();

/** Reads the release-source contracts this API advertises, once per client. */
export function releaseContracts(
  control: Pick<OpenCloudClient, "get">,
): Promise<ReleaseContracts> {
  let cached = releaseContractCache.get(control);
  if (!cached) {
    cached = platformContracts(control)
      .then((contracts) => ({
        releaseSource: contracts.releaseSource === 1,
        deployPreconditions: contracts.deployPreconditions === 1,
        platformBuilds: contracts.platformBuilds === 1,
        pinnedDraftValidation: contracts.pinnedDraftValidation === 1,
      }))
      .catch((error: unknown) => {
        releaseContractCache.delete(control);
        throw error;
      });
    releaseContractCache.set(control, cached);
  }
  return cached;
}
