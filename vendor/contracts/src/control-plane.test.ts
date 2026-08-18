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
        "list_app_email_messages",
        "get_app_email_message",
        "generate_secret",
        "create_secret_entry_link",
        "list_background_jobs",
        "get_background_job",
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

  it("supports bounded cursor pages for retained app email history", () => {
    const appId = "22222222-2222-4222-8222-222222222222";
    const operation = controlPlaneOperations.getAppEmail;

    expect(operation.mcp).toMatchObject({
      toolName: "list_app_email_messages",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(operation.queryKey).toBe("query");
    expect(operation.input.parse({ appId })).toEqual({ appId });
    expect(
      operation.input.parse({
        appId,
        query: {
          cursor: "cursor-page-2",
          limit: 26,
          alias: "support",
          direction: "inbound",
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-08-10T23:59:59.999Z",
        },
      }),
    ).toMatchObject({
      appId,
      query: { alias: "support", direction: "inbound", limit: 26 },
    });
    expect(() =>
      operation.input.parse({ appId, query: { limit: 201 } }),
    ).toThrow();
    expect(() =>
      operation.input.parse({
        appId,
        query: {
          from: "2026-08-11T00:00:00.000Z",
          to: "2026-08-10T00:00:00.000Z",
        },
      }),
    ).toThrow(/after from/);
    expect(() =>
      operation.input.parse({
        appId,
        query: {
          from: "2025-01-01T00:00:00.000Z",
          to: "2026-08-10T00:00:00.000Z",
        },
      }),
    ).toThrow(/366 days/);
  });

  it("types retained email content details without attachment bytes", () => {
    const appId = "22222222-2222-4222-8222-222222222222";
    const messageId = "33333333-3333-4333-8333-333333333333";
    const operation = controlPlaneOperations.getAppEmailMessage;

    expect(operation.mcp).toMatchObject({
      toolName: "get_app_email_message",
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(operation).toMatchObject({
      method: "GET",
      path: "/v1/apps/{appId}/email/messages/{messageId}",
      scopes: ["app:read"],
    });
    expect(operation.input.parse({ appId, messageId })).toEqual({
      appId,
      messageId,
    });
    expect(
      operation.output.parse({
        schemaVersion: 1,
        id: messageId,
        appId,
        deploymentId: null,
        devSessionId: null,
        devRevisionId: null,
        direction: "inbound",
        environment: "production",
        address: "support",
        sender: "sender@example.com",
        recipient: "support@example.com",
        subject: "Need help",
        handlerFunction: "receive-support",
        providerId: null,
        providerMessageId: "<message@example.com>",
        idempotencyKey: null,
        recipientCount: 1,
        status: "processed",
        error: null,
        content: {
          schemaVersion: 1,
          displayFrom: "Sender <sender@example.com>",
          to: ["support@example.com"],
          cc: [],
          bcc: [],
          text: "Need help",
          html: "<p>Need help</p>",
          textTruncated: false,
          htmlTruncated: false,
          replyTo: "sender@example.com",
          inReplyTo: null,
          references: [],
          listUnsubscribe: null,
          tags: [],
          headers: ["From: sender@example.com"],
          headersTruncated: false,
          attachments: [
            {
              name: "request.txt",
              contentType: "text/plain",
              cid: null,
              sizeBytes: 9,
              sha256: "a".repeat(64),
            },
          ],
        },
        createdAt: "2026-08-10T12:00:00.000Z",
        updatedAt: "2026-08-10T12:00:01.000Z",
        processedAt: "2026-08-10T12:00:01.000Z",
      }),
    ).toMatchObject({ id: messageId, content: { text: "Need help" } });
  });

  it("types metadata-only background job observability", () => {
    const appId = "22222222-2222-4222-8222-222222222222";
    const operation = controlPlaneOperations.listBackgroundJobs;

    expect(operation.mcp).toMatchObject({
      toolName: "list_background_jobs",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(
      operation.input.parse({
        appId,
        query: {
          queue: "task-processing",
          state: "retry_wait",
          from: "2026-08-17T10:00:00.000Z",
          to: "2026-08-17T12:00:00.000Z",
          limit: 25,
        },
      }),
    ).toMatchObject({
      query: {
        queue: "task-processing",
        state: "retry_wait",
        from: "2026-08-17T10:00:00.000Z",
        to: "2026-08-17T12:00:00.000Z",
        limit: 25,
      },
    });
    expect(() =>
      operation.input.parse({ appId, query: { state: "cancelled" } }),
    ).toThrow();
    expect(() =>
      operation.input.parse({
        appId,
        query: {
          from: "2026-08-17T12:00:00.000Z",
          to: "2026-08-17T10:00:00.000Z",
        },
      }),
    ).toThrow(/after from/);
    expect(operation.description).toContain("Payloads");
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
      request_dev_app: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      get_agent_feed: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    } as const;

    for (const [name, annotations] of Object.entries(expected)) {
      expect(tools.get(name), `${name} annotations`).toMatchObject(annotations);
    }
    for (const name of ["request_dev_app", "mutate_dev_data"]) {
      expect(tools.get(name)?.description, `${name} API reference`).toContain(
        "https://docs.opencloud.ai/openapi.yaml",
      );
    }
    expect(tools.get("request_dev_app")?.description).toContain(
      "does not create, deploy, or modify an app",
    );
    expect(tools.get("get_agent_feed")?.description).toContain(
      "without persisting alert state",
    );
    expect(tools.get("mutate_dev_data")?.description).toContain(
      "raw REST paths are not accepted",
    );
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
        body: { requireInteractionContract: true, parallelism: 5 },
      }),
    ).toEqual({
      ...path,
      body: { requireInteractionContract: true, parallelism: 5 },
    });
    expect(() =>
      controlPlaneOperations.verifyDevSession.input.parse({
        ...path,
        body: { parallelism: 11 },
      }),
    ).toThrow();
  });

  it("allows an empty draft-file selection and documents normalized dev data paths", () => {
    const appId = "22222222-2222-4222-8222-222222222222";
    const draftId = "11111111-1111-4111-8111-111111111111";

    expect(
      controlPlaneOperations.readDraftFiles.input.parse({
        appId,
        draftId,
        body: { paths: [] },
      }),
    ).toEqual({ appId, draftId, body: { paths: [] } });
    expect(controlPlaneOperations.mutateDevData.mcp?.description).toContain(
      "synthetic-user-A fixture rows",
    );
  });

  it("requires the exact development capability vector", () => {
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
        jobs: true,
        files: true,
        productionSecrets: false,
        cron: false,
        syntheticAuth: true,
        emailCapture: true,
        emailInboundInjection: true,
      },
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
      lastActivityAt: "2026-08-05T00:00:00.000Z",
      expiresAt: "2026-08-06T00:00:00.000Z",
    };

    expect(
      controlPlaneOperations.getDevSession.output.parse(session).capabilities,
    ).toEqual(session.capabilities);
    expect(() =>
      controlPlaneOperations.getDevSession.output.parse({
        ...session,
        capabilities: { ...session.capabilities, files: false },
      }),
    ).toThrow();
  });
});
