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

  it("keeps CLI workspace connection typed and outside the MCP tool surface", () => {
    const operation = controlPlaneOperations.connectCliWorkspace;
    const appId = "22222222-2222-4222-8222-222222222222";

    expect(operation).toMatchObject({
      method: "POST",
      path: "/v1/apps/{appId}/cli-connection",
      scopes: ["app:read"],
      idempotency: "none",
    });
    expect("mcp" in operation).toBe(false);
    expect(operation.input.parse({ appId })).toEqual({ appId });
    expect(
      operation.output.parse({
        app: {
          id: appId,
          name: "Family tasks",
          appUrl: "https://family-tasks.opencloud.ai",
        },
        credential: {
          token: "oc_agent_private-workspace",
          expiresAt: "2026-08-09T00:00:00.000Z",
        },
      }),
    ).toMatchObject({ app: { id: appId } });
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

  it("keeps MCP approval hints aligned with high-risk behavior", () => {
    const tools = new Map(
      Object.values(controlPlaneOperations).flatMap((operation) =>
        operation.mcp ? [[operation.mcp.toolName, operation.mcp] as const] : [],
      ),
    );
    const expected = {
      start_onboarding: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      create_app: { idempotentHint: false },
      configure_app: { destructiveHint: true },
      apply_file_changes: { destructiveHint: true },
      validate_draft: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
      deploy_draft: { destructiveHint: true },
      apply_dev_revision: { destructiveHint: true },
      mutate_dev_data: { destructiveHint: true },
      invoke_dev_function: { destructiveHint: true },
      promote_dev_revision: { destructiveHint: true },
      verify_app: { idempotentHint: false },
      rollback_app: { idempotentHint: false },
      generate_secret: { destructiveHint: true },
      create_backup: { idempotentHint: false },
      configure_backup_schedule: { destructiveHint: true },
      restore_backup: { idempotentHint: false },
      invoke_cron: { destructiveHint: true },
      put_alert_rule: { destructiveHint: true },
    } as const;

    for (const [name, annotations] of Object.entries(expected)) {
      expect(tools.get(name), `${name} annotations`).toMatchObject(annotations);
    }
    for (const name of ["request_dev_app", "mutate_dev_data"]) {
      expect(tools.get(name)?.description, `${name} API reference`).toContain(
        "https://docs.opencloud.ai/openapi.yaml",
      );
    }
    for (const operation of Object.values(controlPlaneOperations)) {
      if (operation.method === "DELETE" && operation.mcp) {
        expect(
          operation.mcp.destructiveHint,
          `${operation.mcp.toolName} destructiveHint`,
        ).toBe(true);
      }
    }
  });

  it("keeps MCP directory metadata complete and bounded", () => {
    for (const operation of Object.values(controlPlaneOperations)) {
      if (!operation.mcp) continue;

      const { mcp } = operation;
      expect(
        mcp.toolName.length,
        `${mcp.toolName} name length`,
      ).toBeLessThanOrEqual(64);
      expect(mcp.title.trim().length, `${mcp.toolName} title`).toBeGreaterThan(0);
      expect(
        mcp.description.trim().length,
        `${mcp.toolName} description`,
      ).toBeGreaterThan(0);
      expect(mcp.readOnlyHint, `${mcp.toolName} readOnlyHint`).toEqual(
        expect.any(Boolean),
      );
      expect(mcp.destructiveHint, `${mcp.toolName} destructiveHint`).toEqual(
        expect.any(Boolean),
      );
      expect(mcp.openWorldHint, `${mcp.toolName} openWorldHint`).toEqual(
        expect.any(Boolean),
      );
    }
  });

  it("keeps interaction verification optional for legacy clients", () => {
    const path = {
      appId: "22222222-2222-4222-8222-222222222222",
      sessionId: "11111111-1111-4111-8111-111111111111",
    };

    expect(controlPlaneOperations.verifyDevSession.input.parse(path)).toEqual(
      path,
    );
    expect(
      controlPlaneOperations.verifyDevSession.input.parse({
        ...path,
        body: {},
      }),
    ).toEqual({ ...path, body: {} });
    expect(
      controlPlaneOperations.verifyDevSession.input.parse({
        ...path,
        body: { requireInteractionContract: true },
      }),
    ).toEqual({
      ...path,
      body: { requireInteractionContract: true },
    });
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
