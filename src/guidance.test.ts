import { describe, expect, it } from "vitest";
import { commandLine, notConnectedMessage, shellArgument } from "./guidance.js";

const appId = "40000000-0000-4000-8000-000000000001";

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
