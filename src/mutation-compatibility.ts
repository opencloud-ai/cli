import type { OpenCloudClient } from "./api-client.js";
import { CliContractError } from "./owner-parity.js";

export async function assertMutationJournalCompatibility(
  control: Pick<OpenCloudClient, "call">,
): Promise<void> {
  const value = await control.call("getPlatformVersion", {}, {
    cacheControl: "no-cache",
  });
  if (value.contracts.cliMutationJournal !== 1) {
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
}

const releaseContractCache = new WeakMap<object, Promise<ReleaseContracts>>();

/** Reads the release-source contracts this API advertises, once per client. */
export function releaseContracts(
  control: Pick<OpenCloudClient, "call">,
): Promise<ReleaseContracts> {
  let cached = releaseContractCache.get(control);
  if (!cached) {
    cached = control
      .call("getPlatformVersion", {}, { cacheControl: "no-cache" })
      .then((value) => ({
        releaseSource: value.contracts.releaseSource === 1,
        deployPreconditions: value.contracts.deployPreconditions === 1,
        platformBuilds: value.contracts.platformBuilds === 1,
      }))
      .catch((error: unknown) => {
        releaseContractCache.delete(control);
        throw error;
      });
    releaseContractCache.set(control, cached);
  }
  return cached;
}
