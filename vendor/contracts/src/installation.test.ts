import { describe, expect, it } from "vitest";
import { controlPlaneOperations } from "./control-plane.js";
import { installationCapabilitiesSchema, installationViewSchema } from "./installation.js";
import { platformAdminOperations } from "./platform-admin.js";

describe("installation capabilities contract", () => {
  it("reads a missing switch as the original installation behaviour", () => {
    expect(installationCapabilitiesSchema.parse({})).toEqual({
      organisations: true,
      platformAi: false,
      appAiSubscriptionConnections: true,
    });
    expect(installationViewSchema.parse({ schemaVersion: 1, capabilities: { organisations: false } }))
      .toMatchObject({ capabilities: { organisations: false, appAiSubscriptionConnections: true } });
  });

  it("publishes a credential-free installation read outside MCP", () => {
    const operation = controlPlaneOperations.getInstallation;
    expect(operation).toMatchObject({ method: "GET", path: "/v1/installation", auth: "none", scopes: [], idempotency: "none" });
    expect("mcp" in operation).toBe(false);
  });

  it("keeps older session and welcome responses compatible", () => {
    const session = {
      userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      profile: { email: null, displayName: null, avatarUrl: null },
      accessTokenExpiresAt: "2026-09-01T12:15:00.000Z",
      refreshAfter: "2026-09-01T12:10:00.000Z",
      sessionExpiresAt: "2026-09-30T00:00:00.000Z",
      emailConfirmationRequired: false,
      emailConfirmationExpiresAt: null,
    };
    expect(controlPlaneOperations.getDashboardSession.output.parse(session).capabilities).toBeUndefined();
    expect(controlPlaneOperations.getDashboardSession.output.parse({ ...session, capabilities: { organisations: false } }).capabilities)
      .toEqual({ organisations: false, platformAi: false, appAiSubscriptionConnections: true });
    expect(controlPlaneOperations.getAccountWelcome.output.parse({
      step: "complete", displayName: "", email: "person@example.test", continueUrl: "https://agent.example.test",
    }).organisationsEnabled).toBe(true);
  });

  it("marks personal account scopes in the admin organisation listing", () => {
    const row = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Personal · person@example.test", status: "active", policyVersion: "1" };
    const output = platformAdminOperations.organisations.output;
    expect(output.parse([row])[0]?.personal).toBe(false);
    expect(output.parse([{ ...row, personal: true }])[0]?.personal).toBe(true);
  });
});
