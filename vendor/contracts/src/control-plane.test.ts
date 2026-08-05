import { describe, expect, it } from "vitest";
import {
  controlPlaneOperations,
  type ControlPlaneOperationId,
} from "./control-plane.js";

describe("controlPlaneOperations", () => {
  it("keeps CLI, API, and MCP operations uniquely addressable", () => {
    const entries = Object.entries(controlPlaneOperations) as Array<
      [
        ControlPlaneOperationId,
        (typeof controlPlaneOperations)[ControlPlaneOperationId],
      ]
    >;
    const toolNames = entries.flatMap(([, operation]) =>
      operation.mcp ? [operation.mcp.toolName] : [],
    );

    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "start_onboarding",
        "create_app",
        "create_draft",
        "apply_file_changes",
        "validate_draft",
        "deploy_draft",
        "verify_app",
        "generate_secret",
        "create_secret_entry_link",
        "get_agent_feed",
        "put_alert_rule",
      ]),
    );
  });

  it("does not advertise owner-destructive legacy lifecycle actions to MCP", () => {
    const tools = Object.values(controlPlaneOperations).flatMap((operation) =>
      operation.mcp ? [operation.mcp.toolName] : [],
    );

    expect(tools).not.toEqual(
      expect.arrayContaining([
        "archive_app",
        "unarchive_app",
        "restart_app",
        "delete_app",
      ]),
    );
  });

  it("requires idempotency for mutating release operations", () => {
    expect(controlPlaneOperations.createApp.idempotency).toBe("required");
    expect(controlPlaneOperations.configureApp.idempotency).toBe("required");
    expect(controlPlaneOperations.deployDraft.idempotency).toBe("required");
    expect(controlPlaneOperations.verifyApp.idempotency).toBe("required");
  });

  it("treats development capabilities as negotiated booleans", () => {
    const session = {
      id: "11111111-1111-4111-8111-111111111111",
      appId: "22222222-2222-4222-8222-222222222222",
      draftId: "33333333-3333-4333-8333-333333333333",
      status: "active",
      previewUrl: "https://dev-example.opencloud.ai",
      baseDeploymentId: null,
      activeRevision: null,
      verification: null,
      capabilities: {
        frontend: true,
        database: true,
        functions: true,
        productionSecrets: false,
        cron: false,
        storageSandbox: false,
        syntheticAuth: false,
      },
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
      lastActivityAt: "2026-08-05T00:00:00.000Z",
      expiresAt: "2026-08-06T00:00:00.000Z",
    };

    for (const [name, enabled] of Object.entries(session.capabilities)) {
      const parsed = controlPlaneOperations.getDevSession.output.parse({
        ...session,
        capabilities: {
          ...session.capabilities,
          [name]: !enabled,
        },
      });
      expect(parsed.capabilities).toMatchObject({ [name]: !enabled });
    }
  });
});
