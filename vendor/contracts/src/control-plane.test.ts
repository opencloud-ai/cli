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
});
