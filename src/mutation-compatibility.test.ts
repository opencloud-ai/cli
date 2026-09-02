import { describe, expect, it, vi } from "vitest";
import { assertMutationJournalCompatibility } from "./mutation-compatibility.js";

describe("mutation journal compatibility", () => {
  it("probes every mutation and observes marker withdrawal", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        version: "3.7.0",
        commit: "abc123",
        builtAt: "2026-09-02T00:00:00Z",
        releaseId: "platform-v3.7.0",
        contracts: { cliMutationJournal: 1 },
      })
      .mockResolvedValueOnce({
        version: "3.7.0",
        commit: "abc123",
        builtAt: "2026-09-02T00:00:00Z",
        releaseId: "platform-v3.7.0",
        contracts: {},
      });

    await expect(
      assertMutationJournalCompatibility({ call }),
    ).resolves.toBeUndefined();
    await expect(
      assertMutationJournalCompatibility({ call }),
    ).rejects.toMatchObject({ code: "CLI_MUTATION_JOURNAL_UNSUPPORTED" });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenNthCalledWith(1, "getPlatformVersion", {}, {
      cacheControl: "no-cache",
    });
  });
});
