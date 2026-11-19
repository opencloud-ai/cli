import { describe, expect, it } from "vitest";
import { commandLine, journalHint, notConnectedMessage, shellArgument } from "./guidance.js";

const appId = "40000000-0000-4000-8000-000000000001";

describe("what to run after the mutation journal stopped a command", () => {
  const key = "ocj1:f96d3c45-0000-4000-8000-000000000001";
  const draftId = "40000000-0000-4000-8000-0000000000d1";
  const sessionId = "40000000-0000-4000-8000-0000000000e1";
  const devStart = { route: ["app", "dev", "start"], args: new Map([["directory", "my app"]]) };
  const pending = { command: "opencloud app dev start", idempotencyKey: key, state: "attempted", appId, draftId, revision: 3, sessionId };

  it("gives the exact resume command with the same key, and how to check it", () => {
    expect(journalHint("MUTATION_IN_PROGRESS", pending, devStart)).toBe(
      `To finish the earlier request, run it again with the input it had: \`opencloud app dev start 'my app' --idempotency-key ${key}\`. ` +
      "To see what it has done so far, run `opencloud app dev status 'my app'`. To send this request separately, add a new --idempotency-key.",
    );
    const operation = { command: "opencloud app restart", idempotencyKey: key, state: "attempted", appId, operationId: sessionId };
    expect(journalHint("MUTATION_IN_PROGRESS", operation, { route: ["app", "restart"], args: new Map([["app-id", appId]]) })).toContain(
      `\`opencloud app restart ${appId} --idempotency-key ${key}\`. To see what it has done so far, run \`opencloud operation get ${sessionId}\``,
    );
    // Another command holding an explicit key cannot be repeated exactly from here.
    expect(journalHint("MUTATION_IN_PROGRESS", { ...pending, command: "opencloud deploy" }, devStart)).toContain(`\`opencloud deploy … --idempotency-key ${key}\``);
  });

  it("asks for a check before a new key when the earlier outcome is unknown, and a new key when it finished", () => {
    expect(journalHint("MUTATION_IN_PROGRESS", { ...pending, state: "unknown", unknownCode: "DEV_APPLY_OUTCOME_UNKNOWN" }, devStart)).toBe(
      "Check whether the earlier request took effect with `opencloud app dev status 'my app'`. If it did not, add a new --idempotency-key to send this request.",
    );
    expect(journalHint("MUTATION_IN_PROGRESS", { ...pending, state: "completed" }, devStart)).toBe("Use a new --idempotency-key for this request.");
  });

  it("says how to find out whether an unconfirmed apply or validation took effect", () => {
    expect(journalHint("DEV_APPLY_OUTCOME_UNKNOWN", { ...pending, command: "opencloud app dev sync", state: "unknown" }, { route: ["app", "dev", "sync"], args: new Map([["directory", "."]]) }))
      .toBe("OpenCloud did not confirm the development apply in time, and it was not repeated. Check with `opencloud app dev status .`: " +
        "it did if session.activeRevision.draftRevision is 3. If it did not take effect, run `opencloud app dev sync . --idempotency-key <new-key>` to apply again.");
    expect(journalHint("DRAFT_VALIDATION_OUTCOME_UNKNOWN", { ...pending, state: "attempted" }, devStart)).toBe(
      `The validation may still be running and was not repeated. Check with \`opencloud draft get ${appId} ${draftId}\`; run the command again with a new --idempotency-key only if you still need it.`,
    );
    expect(journalHint("MUTATION_OUTCOME_UNKNOWN", { command: "opencloud secret rotate", idempotencyKey: key, state: "unknown", appId },
      { route: ["secret", "rotate"], args: new Map([["app-id", appId], ["name", "KEY"]]) })).toBe(
      `It was not repeated. Check whether it took effect with \`opencloud operation list ${appId}\`. If it did not, run the command again with a new --idempotency-key.`,
    );
    expect(journalHint("MUTATION_REPLAY_MISMATCH", pending, devStart)).toBeUndefined();
  });
});

describe("commands in guidance", () => {
  it("quotes only values a shell would split or expand", () => {
    expect(shellArgument("./app")).toBe("./app");
    expect(shellArgument("ocj1:5f2a1916-ba29-4fc0-8bf4-d914aacb4bef")).toBe("ocj1:5f2a1916-ba29-4fc0-8bf4-d914aacb4bef");
    expect(shellArgument("my app")).toBe("'my app'");
    expect(shellArgument("it's $HOME")).toBe(`'it'\\''s $HOME'`);
    expect(commandLine(["app", "dev", "start"], ["my app"])).toBe("opencloud app dev start 'my app'");
  });
});

describe("a folder without an app connection", () => {
  it("asks a signed-in person only to connect the folder", () => {
    expect(notConnectedMessage({ signedIn: true })).toBe(
      "This folder is not connected to an app. You are signed in, so run opencloud app connect <app-id> here, or run this command in a folder connected to the app.",
    );
    expect(notConnectedMessage({ signedIn: true, appId: appId.toUpperCase() })).toContain(`run opencloud app connect ${appId} here`);
    expect(notConnectedMessage({ signedIn: true, appId: "not-an-id" })).toContain("opencloud app connect <app-id>");
    expect(notConnectedMessage({ signedIn: true, directory: "../my app" })).toBe(
      "The folder '../my app' is not connected to an app. You are signed in, so run opencloud app connect <app-id> in that folder.",
    );
  });

  it("asks for a login first only when there is none", () => {
    expect(notConnectedMessage({ signedIn: false, appId })).toBe(
      `You are not signed in, and this folder is not connected to an app. Run opencloud login, then opencloud app connect ${appId} here.`,
    );
    expect(notConnectedMessage({ signedIn: null })).toBe(
      "This folder is not connected to an app. Run opencloud app connect <app-id> here (after opencloud login if you are not signed in), or run this command in a folder connected to the app.",
    );
  });
});
