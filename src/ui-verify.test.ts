import { describe, expect, it, vi } from "vitest";
import { verifyAppUi } from "./ui-verify.js";

const app = {
  id: "11111111-1111-4111-8111-111111111111",
  visibility: "private",
  state: "active",
  activeDeploymentId: "22222222-2222-4222-8222-222222222222",
  appUrl: "https://example.opencloud.ai",
  authUrl: "https://auth.opencloud.ai",
};

function launcher(options: {
  session?: "established" | "none";
  consoleError?: string;
  publicSession401?: boolean;
  interactionContract?: {
    declared: boolean;
    required: boolean;
    checks: string[];
    coverage: Array<"view-transition" | "state-assertion">;
  };
} = {}) {
  const listeners = new Map<string, (...args: any[]) => void>();
  const page = {
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, listener);
    }),
    goto: vi.fn(async () => {
      if (options.publicSession401) {
        listeners.get("response")?.({
          status: () => 401,
          url: () => `${app.appUrl}/_opencloud/session`,
        });
        listeners.get("console")?.({
          type: () => "error",
          text: () =>
            "Failed to load resource: the server responded with a status of 401 ()",
        });
      }
      if (options.consoleError) {
        listeners.get("console")?.({
          type: () => "error",
          text: () => options.consoleError,
        });
      }
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({
      title: "Example",
      visibleTextLength: 120,
      landmarkCount: 2,
      sdk: {
        package: "@opencloud/js",
        version: "0.2.1",
        module: "/_opencloud/sdk/js/v0.2.1/index.js",
        types: "/_opencloud/sdk/js/v0.2.1/index.d.ts",
        exportedVersion: "0.2.1",
        configMatched: true,
        typesStatus: 200,
      },
      session: options.session ?? "established",
      interactionContract: options.interactionContract ?? {
        declared: false,
        required: false,
        checks: [],
        coverage: [],
      },
    }),
    url: vi.fn(() => app.appUrl),
  };
  const login = {
    ok: vi.fn(() => true),
    status: vi.fn(() => 201),
  };
  const browser = {
    newContext: vi.fn().mockResolvedValue({
      request: { post: vi.fn().mockResolvedValue(login) },
      newPage: vi.fn().mockResolvedValue(page),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    launch: vi.fn().mockResolvedValue(browser),
    browser,
    page,
  };
}

describe("verifyAppUi", () => {
  it("authenticates and verifies the exact runtime SDK contract", async () => {
    const fake = launcher();
    const result = await verifyAppUi(app, {
      email: "agent@example.test",
      password: "not-printed",
      launcher: fake as never,
    });

    expect(result).toMatchObject({
      passed: true,
      appId: app.id,
      session: "established",
      sdk: { version: "0.2.1", typesStatus: 200 },
    });
    expect(fake.browser.newContext).toHaveBeenCalledWith({
      ignoreHTTPSErrors: false,
    });
    expect(fake.browser.close).toHaveBeenCalled();
  });

  it("fails on browser console errors and still closes Chromium", async () => {
    const fake = launcher({ consoleError: "broken frontend" });
    await expect(
      verifyAppUi(app, {
        email: "agent@example.test",
        password: "not-printed",
        launcher: fake as never,
      }),
    ).rejects.toThrow("console: broken frontend");
    expect(fake.browser.close).toHaveBeenCalled();
  });

  it("requires provisioned verification credentials for a private app", async () => {
    await expect(
      verifyAppUi(app, {
        email: "",
        password: "",
        launcher: launcher() as never,
      }),
    ).rejects.toThrow("OPENCLOUD_VERIFY_USER_A_EMAIL");
  });

  it("accepts a public app without verifier credentials or a session", async () => {
    const fake = launcher({ session: "none" });
    const result = await verifyAppUi(
      { ...app, visibility: "public" },
      { launcher: fake as never },
    );

    expect(result).toMatchObject({
      passed: true,
      visibility: "public",
      session: "none",
    });
    expect(fake.browser.newContext).toHaveBeenCalled();
  });

  it("rejects the legacy public signed-out 401 browser error", async () => {
    const fake = launcher({
      session: "none",
      publicSession401: true,
    });

    await expect(
      verifyAppUi(
        { ...app, visibility: "public" },
        { launcher: fake as never },
      ),
    ).rejects.toThrow("status of 401");
  });

  it("does not suppress an unrelated generic 401 console entry", async () => {
    const fake = launcher({
      session: "none",
      consoleError:
        "Failed to load resource: the server responded with a status of 401 ()",
    });

    await expect(
      verifyAppUi(
        { ...app, visibility: "public" },
        { launcher: fake as never },
      ),
    ).rejects.toThrow("status of 401");
  });

  it("reports a passing app-supplied interaction contract", async () => {
    const fake = launcher({
      interactionContract: {
        declared: true,
        required: true,
        checks: ["opened workspace", "rendered empty state"],
        coverage: ["view-transition", "state-assertion"],
      },
    });
    const result = await verifyAppUi(app, {
      email: "agent@example.test",
      password: "not-printed",
      launcher: fake as never,
    });

    expect(result).toMatchObject({
      passed: true,
      interactionContract: {
        declared: true,
        required: true,
        checks: ["opened workspace", "rendered empty state"],
        coverage: ["view-transition", "state-assertion"],
      },
    });
  });

  it("fails when an app marks its interaction contract as required but omits it", async () => {
    const fake = launcher({
      interactionContract: {
        declared: false,
        required: true,
        checks: [],
        coverage: [],
      },
    });

    await expect(
      verifyAppUi(app, {
        email: "agent@example.test",
        password: "not-printed",
        launcher: fake as never,
      }),
    ).rejects.toThrow("did not declare it");
  });

  it("requires both interaction coverage categories", async () => {
    const fake = launcher({
      interactionContract: {
        declared: true,
        required: false,
        checks: ["opened workspace"],
        coverage: ["view-transition"],
      },
    });

    await expect(
      verifyAppUi(app, {
        email: "agent@example.test",
        password: "not-printed",
        requireInteraction: true,
        launcher: fake as never,
      }),
    ).rejects.toThrow("did not cover state-assertion");
  });

  it("lets the command require a complete interaction contract", async () => {
    const fake = launcher({
      interactionContract: {
        declared: true,
        required: false,
        checks: ["opened workspace", "confirmed active view"],
        coverage: ["view-transition", "state-assertion"],
      },
    });

    const result = await verifyAppUi(app, {
      email: "agent@example.test",
      password: "not-printed",
      requireInteraction: true,
      launcher: fake as never,
    });

    expect(result).toMatchObject({
      passed: true,
      interactionContract: {
        declared: true,
        required: true,
      },
    });
  });
});
