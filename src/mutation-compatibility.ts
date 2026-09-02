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
