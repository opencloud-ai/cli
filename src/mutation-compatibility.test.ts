import { describe, expect, it, vi } from "vitest";
import { assertMutationJournalCompatibility, releaseContracts } from "./mutation-compatibility.js";

const version = (contracts: unknown) => ({
  version: "3.7.0", commit: "abc123", builtAt: "2026-09-02T00:00:00Z", releaseId: "platform-v3.7.0", contracts,
});

describe("mutation journal compatibility", () => {
  it("probes every mutation and observes marker withdrawal", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(version({ cliMutationJournal: 1 }))
      .mockResolvedValueOnce(version({}));

    await expect(assertMutationJournalCompatibility({ get })).resolves.toBeUndefined();
    await expect(assertMutationJournalCompatibility({ get })).rejects.toMatchObject({ code: "CLI_MUTATION_JOURNAL_UNSUPPORTED" });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, "/version", { cacheControl: "no-cache" });
  });

  it("reads a marker with a value it does not know as absent, never as a contract mismatch", async () => {
    // A newer OpenCloud might send 2, or another shape: the earlier flow applies.
    const drifted = { get: vi.fn().mockResolvedValue(version({ cliMutationJournal: 1, pinnedDraftValidation: 2, releaseSource: "yes", platformBuilds: 1 })) };
    await expect(assertMutationJournalCompatibility(drifted)).resolves.toBeUndefined();
    await expect(releaseContracts(drifted)).resolves.toEqual({
      releaseSource: false, deployPreconditions: false, platformBuilds: true, pinnedDraftValidation: false,
    });
    const odd = { get: vi.fn().mockResolvedValue({ version: "x", contracts: ["cliMutationJournal"] }) };
    await expect(assertMutationJournalCompatibility(odd)).rejects.toMatchObject({ code: "CLI_MUTATION_JOURNAL_UNSUPPORTED" });
    await expect(releaseContracts({ get: vi.fn().mockResolvedValue(version({ cliMutationJournal: 1, pinnedDraftValidation: 1 })) }))
      .resolves.toMatchObject({ pinnedDraftValidation: true });
  });
});
