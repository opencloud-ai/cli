import { describe, expect, it } from "vitest";
import {
  controlPlaneAppDeploymentTruthSchema,
  controlPlaneAppSchema,
  controlPlaneOperations,
  type ControlPlaneOperationId,
} from "./control-plane.js";

describe("controlPlaneOperations", () => {
  it("shares custom domain methods, scope, outputs and idempotency with typed callers", () => {
    const appId = "22222222-2222-4222-8222-222222222222";
    const output = { available: true, unavailableReason: null, binding: null, cleanupPending: false };
    const cases = [
      ["getAppDomain", "GET", "/domains", "app:read", "none", "get_app_domain", true],
      ["addAppDomain", "POST", "/domains", "app:configure", "required", "add_app_domain", false],
      ["checkAppDomain", "POST", "/domains/check", "app:configure", "required", "check_app_domain", false],
      ["removeAppDomain", "DELETE", "/domains", "app:configure", "required", "remove_app_domain", false],
    ] as const;
    for (const [id, method, suffix, scope, idempotency, toolName, readOnlyHint] of cases) {
      const operation = controlPlaneOperations[id];
      expect(operation).toMatchObject({
        method, path: `/v1/apps/{appId}${suffix}`, auth: "bearer",
        scopes: [scope], idempotency, mcp: { toolName, readOnlyHint },
      });
      expect(operation.output.parse(output)).toEqual(output);
      expect(() => operation.output.parse({ ...output, binding: { hostname: "app.example.test" } })).toThrow();
      const input = id === "addAppDomain" ? { appId, body: { hostname: "app.example.test" } } : { appId };
      expect(operation.input.parse(input)).toEqual(input);
      expect(() => operation.input.parse({ ...input, appId: "invalid" })).toThrow();
    }
    expect(controlPlaneOperations.addAppDomain.bodyKey).toBe("body");
    expect(controlPlaneOperations.getAppDomain.bodyKey).toBeUndefined();
    expect(controlPlaneOperations.checkAppDomain.bodyKey).toBeUndefined();
    expect(controlPlaneOperations.removeAppDomain.bodyKey).toBeUndefined();
    expect(() => controlPlaneOperations.addAppDomain.input.parse({ appId, body: {} })).toThrow();
    expect(() => controlPlaneOperations.addAppDomain.input.parse({ appId, body: { hostname: "app.example.test", target: "http://internal.test" } })).toThrow();
  });

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
        "list_app_web_push_messages",
        "get_app_web_push_message",
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
    expect(controlPlaneOperations.createDraft).toMatchObject({
      idempotency: "required",
      mcp: { idempotentHint: false },
    });
    expect(controlPlaneOperations.deployDraft.idempotency).toBe("required");
    expect(controlPlaneOperations.verifyApp.idempotency).toBe("required");
    expect(controlPlaneOperations.startDevSession).toMatchObject({
      idempotency: "intrinsic",
      mcp: { idempotentHint: true },
    });
  });

  it("requires stable keys for replay-safe development and secret effects", () => {
    const operationIds = [
      "mutateDevData",
      "invokeDevFunction",
      "injectDevEmail",
      "generateSecret",
      "createSecretEntryLink",
    ] as const;

    for (const operationId of operationIds) {
      expect(controlPlaneOperations[operationId]).toMatchObject({
        idempotency: "required",
        mcp: { idempotentHint: false },
      });
    }
    expect(
      controlPlaneOperations.requestAppAccessTokenApproval.idempotency,
    ).toBe("required");
    expect(controlPlaneOperations.putSecret).toMatchObject({
      method: "PUT",
      path: "/v1/apps/{appId}/secrets/{name}",
      idempotency: "required",
    });
    expect(controlPlaneOperations.putSecret.description).toContain(
      "replays the redacted success",
    );
    expect("mcp" in controlPlaneOperations.putSecret).toBe(false);
  });

  it("types the default-off platform mutation-journal marker", () => {
    const operation = controlPlaneOperations.getPlatformVersion;
    const base = {
      version: "1.2.3",
      commit: "abc123",
      builtAt: "2026-09-02T00:00:00Z",
      releaseId: "platform-v1.2.3",
    };

    expect(operation).toMatchObject({
      method: "GET",
      path: "/version",
      auth: "none",
      idempotency: "none",
    });
    expect(operation.output.parse({ ...base, contracts: {} })).toEqual({
      ...base,
      contracts: {},
    });
    expect(
      operation.output.parse({
        ...base,
        contracts: { cliMutationJournal: 1 },
      }),
    ).toEqual({ ...base, contracts: { cliMutationJournal: 1 } });
  });

  it("documents the durable reconciliation boundary for dev verification", () => {
    const operation = controlPlaneOperations.verifyDevSession;

    expect(operation).toMatchObject({
      idempotency: "none",
      mcp: { idempotentHint: false },
    });
    expect(operation.description).toContain("lost response");
    expect(operation.description).toContain("session status is verifying");
    expect(operation.description).toContain("exact active revision");
    expect(operation.description).toContain("durable receipt");
  });

  it("types the atomic deployment precondition for stopping a dev session", () => {
    const appId = "22222222-2222-4222-8222-222222222222";
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const deploymentId = "44444444-4444-4444-8444-444444444444";
    const operation = controlPlaneOperations.stopDevSession;

    expect(operation.queryKey).toBe("query");
    expect(
      operation.input.parse({
        appId,
        sessionId,
        query: { expectedActiveDeploymentId: deploymentId },
      }),
    ).toEqual({
      appId,
      sessionId,
      query: { expectedActiveDeploymentId: deploymentId },
    });
    expect(operation.input.parse({ appId, sessionId })).toEqual({
      appId,
      sessionId,
    });
    expect(operation.description).toContain("expectedActiveDeploymentId");
  });

  it("defaults existing apps to owner credentials and accepts user mode updates", () => {
    const appId = "22222222-2222-4222-8222-222222222222";
    const app = controlPlaneAppSchema.parse({
      id: appId,
      identityStatus: "assigned",
      name: "Family tasks",
      slug: "family-tasks",
      appUrl: "https://family-tasks.opencloud.ai",
      authUrl: "https://auth.opencloud.ai",
      apiUrl: "https://api.opencloud.ai",
      visibility: "private",
      state: "active",
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      desiredDeploymentId: null,
      activeDeploymentId: null,
      createdAt: "2026-08-13T12:00:00.000Z",
      updatedAt: "2026-08-13T12:00:00.000Z",
    });

    expect(app.aiCredentialSource).toBe("owner");
    expect(
      controlPlaneOperations.configureApp.input.parse({
        appId,
        body: { aiCredentialSource: "user" },
      }),
    ).toMatchObject({ body: { aiCredentialSource: "user" } });
    expect(() =>
      controlPlaneOperations.configureApp.input.parse({
        appId,
        body: { aiCredentialSource: "requester" },
      }),
    ).toThrow();
  });

  it("types one authoritative active deployment and its exact Agent activation", () => {
    const appId = "22222222-2222-4222-8222-222222222222";
    const deploymentId = "33333333-3333-4333-8333-333333333333";
    const operationId = "44444444-4444-4444-8444-444444444444";
    const rootRunId = "55555555-5555-4555-8555-555555555555";
    const truth = {
      schemaVersion: 1,
      appId,
      appState: "active",
      canonicalUrl: "https://family-tasks.opencloud.ai",
      activeDeployment: {
        id: deploymentId,
        version: "family-tasks-20260903-1",
        artifactSha256: "a".repeat(64),
        state: "active",
        activatedAt: "2026-09-03T12:00:00.000Z",
        activationOperationId: operationId,
        activatedByAgentRootRunId: rootRunId,
      },
    } as const;

    expect(controlPlaneAppDeploymentTruthSchema.parse(truth)).toEqual(truth);
    expect(
      controlPlaneOperations.getAppDeploymentTruth.output.parse(truth),
    ).toEqual(truth);
    expect(controlPlaneOperations.getAppDeploymentTruth).toMatchObject({
      method: "GET",
      path: "/v1/apps/{appId}/deployment-truth",
      scopes: ["app:read"],
      idempotency: "none",
    });
    expect(
      controlPlaneAppDeploymentTruthSchema.parse({
        ...truth,
        appState: "draft",
        canonicalUrl: null,
        activeDeployment: null,
      }).activeDeployment,
    ).toBeNull();
    expect(() =>
      controlPlaneAppDeploymentTruthSchema.parse({
        ...truth,
        activeDeployment: {
          ...truth.activeDeployment,
          activationOperationId: null,
        },
      }),
    ).toThrow();
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

  it("types bounded and redacted production Web Push history", () => {
    const appId = "22222222-2222-4222-8222-222222222222";
    const messageId = "33333333-3333-4333-8333-333333333333";
    const list = controlPlaneOperations.listWebPushMessages;

    expect(list).toMatchObject({
      method: "GET",
      path: "/v1/apps/{appId}/notifications/web-push/messages",
      scopes: ["app:read"],
      queryKey: "query",
      mcp: {
        toolName: "list_app_web_push_messages",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    });
    expect(list.input.parse({ appId })).toEqual({ appId });
    expect(
      list.input.parse({
        appId,
        query: {
          cursor: "page-2",
          limit: "25",
          userId: "11111111-1111-4111-8111-111111111111",
          status: "partial",
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-08-30T23:59:59.999Z",
        },
      }),
    ).toMatchObject({ query: { limit: 25, status: "partial" } });
    expect(() => list.input.parse({ appId, query: { limit: 201 } })).toThrow();
    expect(() =>
      list.input.parse({
        appId,
        query: {
          from: "2026-08-20T00:00:00.000Z",
          to: "2026-08-19T00:00:00.000Z",
        },
      }),
    ).toThrow(/after from/);
    expect(() =>
      list.input.parse({
        appId,
        query: {
          from: "2026-07-01T00:00:00.000Z",
          to: "2026-08-01T00:00:00.001Z",
        },
      }),
    ).toThrow(/30 days/);

    const detail = controlPlaneOperations.getWebPushMessage.output.parse({
      schemaVersion: 1,
      id: messageId,
      appId,
      deploymentId: null,
      userId: "11111111-1111-4111-8111-111111111111",
      title: "Report ready",
      body: "Open the report.",
      path: "/reports/latest",
      icon: "/_opencloud/notification-icon.png",
      status: "accepted",
      recipientCount: 1,
      acceptedCount: 1,
      failedCount: 0,
      deliveryAttempts: [
        {
          status: "accepted",
          attemptCount: 1,
          lastError: null,
          createdAt: "2026-08-23T00:00:00.000Z",
          updatedAt: "2026-08-23T00:00:01.000Z",
          acceptedAt: "2026-08-23T00:00:01.000Z",
          subscriptionId: "44444444-4444-4444-8444-444444444444",
          endpoint: "https://push.example.test/secret",
        },
      ],
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:01.000Z",
      completedAt: "2026-08-23T00:00:01.000Z",
      idempotencyKey: "report:ready",
    });
    expect(detail).not.toHaveProperty("idempotencyKey");
    expect(detail.deliveryAttempts[0]).not.toHaveProperty("subscriptionId");
    expect(detail.deliveryAttempts[0]).not.toHaveProperty("endpoint");
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
    expect(operation.input.parse({ appId })).toEqual({ appId });
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
    expect(controlPlaneOperations.getBackgroundJob.description).toContain(
      "idempotency key",
    );
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
      create_draft: { idempotentHint: false },
      configure_app: { destructiveHint: true },
      apply_file_changes: { destructiveHint: true },
      validate_draft: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
      deploy_draft: { destructiveHint: true },
      apply_dev_revision: { destructiveHint: true },
      mutate_dev_data: { destructiveHint: true, idempotentHint: false },
      invoke_dev_function: { destructiveHint: true, idempotentHint: false },
      inject_dev_email: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      promote_dev_revision: { destructiveHint: true },
      verify_app: { idempotentHint: false },
      rollback_app: { idempotentHint: false },
      generate_secret: { destructiveHint: true, idempotentHint: false },
      create_secret_entry_link: { idempotentHint: false },
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
    expect(tools.get("start_dev_session")?.description).toContain(
      "browserPreviewUrl",
    );
    expect(tools.get("start_dev_session")?.description).toContain("Not live");
    expect(tools.get("start_dev_session")?.description).toContain("Mobile");
    expect(tools.get("start_dev_session")?.description).toContain(
      "does not authorize promotion",
    );
    expect(tools.get("get_agent_feed")?.description).toContain(
      "without persisting alert state",
    );
    expect(tools.get("mutate_dev_data")?.description).toContain(
      "raw REST paths are not accepted",
    );
    expect(tools.get("inject_dev_email")?.description).toContain(
      "may change isolated data or external systems",
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
      expect(mcp.title.trim().length, `${mcp.toolName} title`).toBeGreaterThan(
        0,
      );
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
      browserPreviewUrl:
        "https://dev-example.opencloud.ai/_opencloud/dev/launch",
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
        notificationCapture: true,
      },
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
      lastActivityAt: "2026-08-05T00:00:00.000Z",
      expiresAt: "2026-08-06T00:00:00.000Z",
    };

    const parsed = controlPlaneOperations.getDevSession.output.parse(session);
    expect(parsed.capabilities).toEqual(session.capabilities);
    expect(parsed.browserPreviewUrl).toBe(session.browserPreviewUrl);
    expect(() =>
      controlPlaneOperations.getDevSession.output.parse({
        ...session,
        capabilities: { ...session.capabilities, files: false },
      }),
    ).toThrow();
  });
});

describe("Merged dashboard contracts", () => {
describe("controlPlaneOperations", () => {
  it("types the existing bounded cookie-backed dashboard session read", () => {
    const operation = controlPlaneOperations.getDashboardSession;
    const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    expect(operation).toMatchObject({
      method: "GET",
      path: "/v1/auth/session",
      auth: "user",
      scopes: [],
      idempotency: "none",
    });
    expect("mcp" in operation).toBe(false);
    expect(operation.input.parse({})).toEqual({});
    const output = {
      userId,
      profile: {
        email: "person@example.test",
        displayName: "Example person",
        avatarUrl: null,
      },
      accessTokenExpiresAt: "2026-09-01T12:15:00.000Z",
      refreshAfter: "2026-09-01T12:10:00.000Z",
      sessionExpiresAt: "2026-09-30T00:00:00.000Z",
      emailConfirmationRequired: false,
      emailConfirmationExpiresAt: null,
    };
    expect(operation.output.parse(output)).toEqual(output);
  });

  it("types dashboard preferences and account MCP token management outside MCP", () => {
    const tokenId = "11111111-1111-4111-8111-111111111111";
    const profile = controlPlaneOperations.updateDashboardProfile;
    const password = controlPlaneOperations.updateDashboardPassword;
    const list = controlPlaneOperations.listAccountMcpTokensPage;
    const create = controlPlaneOperations.createAccountMcpToken;
    const revoke = controlPlaneOperations.revokeAccountMcpToken;

    expect(profile).toMatchObject({
      method: "PATCH",
      path: "/v1/auth/profile",
      bodyKey: "body",
      auth: "user",
      idempotency: "none",
    });
    expect(
      profile.input.parse({
        body: {
          displayName: "  Example person  ",
          email: "  PERSON@Example.Test ",
          avatarUrl: " https://images.example.test/avatar.png ",
        },
      }),
    ).toEqual({
      body: {
        displayName: "Example person",
        email: "person@example.test",
        avatarUrl: "https://images.example.test/avatar.png",
      },
    });
    expect(() =>
      profile.input.parse({
        body: {
          displayName: "Example",
          email: "person@example.test",
          avatarUrl: "http://images.example.test/avatar.png",
        },
      }),
    ).toThrow();

    expect(password).toMatchObject({
      method: "PATCH",
      path: "/v1/auth/password",
      bodyKey: "body",
      idempotency: "none",
    });
    expect(() =>
      password.input.parse({
        body: {
          password: "test-password-42",
          confirmPassword: "different-password",
        },
      }),
    ).toThrow();

    expect(list).toMatchObject({
      method: "GET",
      path: "/v1/integrations/mcp/tokens/page",
      queryKey: "query",
      auth: "user",
      idempotency: "none",
    });
    expect(list.input.parse({ query: {} })).toEqual({ query: { limit: 25 } });
    expect(
      list.input.parse({ query: { cursor: "next-page", limit: "100" } }),
    ).toEqual({ query: { cursor: "next-page", limit: 100 } });
    expect(() => list.input.parse({ query: { limit: 101 } })).toThrow();
    expect(() =>
      list.input.parse({ query: { cursor: "x".repeat(2_049) } }),
    ).toThrow();
    const metadata = {
      id: tokenId,
      name: "Desktop MCP client",
      prefix: "oc_oauth_review_ab",
      scopes: ["mcp:tools"],
      createdAt: "2026-09-01T10:00:00.000Z",
      expiresAt: "2027-09-01T10:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    };
    const parsedPage = list.output.parse({
      asOf: "2026-09-01T12:00:00.000Z",
      mcpUrl: "https://mcp.opencloud.test",
      tokenLifetimeDays: 365,
      tokenLifetimeOptions: [1, 14, 365, "unlimited"],
      tokens: [metadata],
      nextCursor: null,
    });
    expect(parsedPage.tokens).toEqual([metadata]);
    expect(JSON.stringify(parsedPage)).not.toContain("token-value");

    expect(
      create.input.parse({ body: { name: "  Desktop client  " } }),
    ).toEqual({ body: { name: "Desktop client", lifetimeDays: 365 } });
    expect(create.idempotency).toBe("none");
    expect(revoke.input.parse({ tokenId })).toEqual({ tokenId });
    expect(
      revoke.output.parse({
        id: tokenId,
        revokedAt: "2026-09-01T12:30:00.000Z",
      }),
    ).toEqual({
      id: tokenId,
      revokedAt: "2026-09-01T12:30:00.000Z",
    });

    for (const operation of [profile, password, list, create, revoke]) {
      expect("mcp" in operation).toBe(false);
    }
  });

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
    const httpRoutes = entries.map(
      ([, operation]) => `${operation.method} ${operation.path}`,
    );

    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(new Set(httpRoutes).size).toBe(httpRoutes.length);
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
        "list_app_web_push_messages",
        "get_app_web_push_message",
        "generate_secret",
        "create_secret_entry_link",
        "list_background_jobs",
        "get_background_job",
        "get_agent_feed",
        "put_alert_rule",
      ]),
    );
  });

  it("keeps dashboard integration workflows outside the MCP tool surface", () => {
    const dashboardIntegrationOperationIds = [
      "listAccountIntegrationConnections",
      "beginGoogleIntegrationAuthorization",
      "beginAsanaIntegrationAuthorization",
      "beginHubSpotIntegrationAuthorization",
      "beginSlackIntegrationAuthorization",
      "listBankIntegrationInstitutions",
      "beginBankIntegrationAuthorization",
      "createWiseIntegrationConnection",
      "renameWiseIntegrationConnection",
      "listGoogleIntegrationCalendars",
      "listGoogleAnalyticsProperties",
      "listGoogleSearchConsoleSites",
      "listGoogleAdsCustomers",
      "listBankIntegrationAccounts",
      "listSlackIntegrationChannels",
      "listAsanaIntegrationProjects",
      "disconnectAccountIntegrationConnection",
      "removeAccountIntegrationBinding",
      "beginTelegramIntegrationPairing",
      "listAppIntegrations",
      "bindAppIntegration",
      "unbindAppIntegration",
      "getAiIntegrationOverview",
      "createAiIntegrationConnection",
      "getAiIntegrationAuthorization",
      "submitAiIntegrationAuthorizationCode",
      "cancelAiIntegrationAuthorization",
      "updateAiIntegrationConnection",
      "disconnectAiIntegrationConnection",
      "updateAppAiIntegration",
    ] as const;

    for (const operationId of dashboardIntegrationOperationIds) {
      expect("mcp" in controlPlaneOperations[operationId], operationId).toBe(
        false,
      );
    }
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

  it("types archived-app restoration as an idempotent durable operation", () => {
    const appId = "22222222-2222-4222-8222-222222222222";
    const operationId = "33333333-3333-4333-8333-333333333333";
    const operation = controlPlaneOperations.unarchiveApp;

    expect(operation).toMatchObject({
      method: "POST",
      path: "/v1/apps/{appId}/unarchive",
      scopes: ["app:configure"],
      idempotency: "required",
    });
    expect("mcp" in operation).toBe(false);
    expect(operation.input.parse({ appId })).toEqual({ appId });
    expect(
      operation.output.parse({
        id: operationId,
        appId,
        deploymentId: null,
        type: "unarchive_app",
        state: "queued",
        actorType: "user",
        actorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        idempotencyKey: "restore-app-42",
        error: null,
        createdAt: "2026-09-01T08:00:00.000Z",
        updatedAt: "2026-09-01T08:00:00.000Z",
      }),
    ).toMatchObject({ id: operationId, type: "unarchive_app" });
  });

  it("requires idempotency for mutating release operations", () => {
    expect(controlPlaneOperations.createApp.idempotency).toBe("required");
    expect(controlPlaneOperations.configureApp.idempotency).toBe("required");
    expect(controlPlaneOperations.deployDraft.idempotency).toBe("required");
    expect(controlPlaneOperations.verifyApp.idempotency).toBe("required");
    expect(controlPlaneOperations.unarchiveApp.idempotency).toBe("required");
  });

  it("adds a bounded deployment cursor page without changing the legacy list", () => {
    const appId = "22222222-2222-4222-8222-222222222222";
    const deploymentId = "44444444-4444-4444-8444-444444444444";
    const page = controlPlaneOperations.listDeploymentsPage;

    expect(page).toMatchObject({
      method: "GET",
      path: "/v1/apps/{appId}/deployments/page",
      queryKey: "query",
      scopes: ["app:read"],
      idempotency: "none",
    });
    expect("mcp" in page).toBe(false);
    expect(page.input.parse({ appId, query: {} })).toEqual({
      appId,
      query: { limit: 20 },
    });
    expect(
      page.input.parse({
        appId,
        query: { cursor: "page-two", state: "active", limit: "40" },
      }),
    ).toEqual({
      appId,
      query: { cursor: "page-two", state: "active", limit: 40 },
    });
    expect(
      page.output.parse({
        asOf: "2026-08-30T12:00:00.000Z",
        deployments: [
          {
            id: deploymentId,
            appId,
            version: "family-tasks-20260830-1",
            artifactSha256: "a".repeat(64),
            sdkVersion: "2.0.0",
            manifest: { schemaVersion: 3, appId },
            state: "active",
            rollbackOfDeploymentId: null,
            error: null,
            createdAt: "2026-08-30T11:00:00.000Z",
            activatedAt: "2026-08-30T11:01:00.000Z",
          },
        ],
        nextCursor: "page-two",
      }),
    ).toMatchObject({ deployments: [{ id: deploymentId }] });
    expect(() => page.input.parse({ appId, query: { limit: 101 } })).toThrow();
    expect(() =>
      page.input.parse({ appId, query: { state: "unknown" } }),
    ).toThrow();

    expect(controlPlaneOperations.listDeployments).toMatchObject({
      method: "GET",
      path: "/v1/apps/{appId}/deployments",
    });
    expect("queryKey" in controlPlaneOperations.listDeployments).toBe(false);
    expect(
      controlPlaneOperations.listDeployments.output.safeParse([]).success,
    ).toBe(true);
  });

  it("defaults existing apps to owner credentials and accepts user mode updates", () => {
    const appId = "22222222-2222-4222-8222-222222222222";
    const app = controlPlaneAppSchema.parse({
      id: appId,
      identityStatus: "assigned",
      name: "Family tasks",
      slug: "family-tasks",
      appUrl: "https://family-tasks.opencloud.ai",
      authUrl: "https://auth.opencloud.ai",
      apiUrl: "https://api.opencloud.ai",
      visibility: "private",
      state: "active",
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      desiredDeploymentId: null,
      activeDeploymentId: null,
      createdAt: "2026-08-13T12:00:00.000Z",
      updatedAt: "2026-08-13T12:00:00.000Z",
    });

    expect(app.aiCredentialSource).toBe("owner");
    expect(
      controlPlaneOperations.configureApp.input.parse({
        appId,
        body: { aiCredentialSource: "user" },
      }),
    ).toMatchObject({ body: { aiCredentialSource: "user" } });
    expect(() =>
      controlPlaneOperations.configureApp.input.parse({
        appId,
        body: { aiCredentialSource: "requester" },
      }),
    ).toThrow();
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

  it("types bounded and redacted production Web Push history", () => {
    const appId = "22222222-2222-4222-8222-222222222222";
    const messageId = "33333333-3333-4333-8333-333333333333";
    const list = controlPlaneOperations.listWebPushMessages;

    expect(list).toMatchObject({
      method: "GET",
      path: "/v1/apps/{appId}/notifications/web-push/messages",
      scopes: ["app:read"],
      queryKey: "query",
      mcp: {
        toolName: "list_app_web_push_messages",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    });
    expect(list.input.parse({ appId })).toEqual({ appId });
    expect(
      list.input.parse({
        appId,
        query: {
          cursor: "page-2",
          limit: "25",
          userId: "11111111-1111-4111-8111-111111111111",
          status: "partial",
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-08-30T23:59:59.999Z",
        },
      }),
    ).toMatchObject({ query: { limit: 25, status: "partial" } });
    expect(() => list.input.parse({ appId, query: { limit: 201 } })).toThrow();
    expect(() =>
      list.input.parse({
        appId,
        query: {
          from: "2026-08-20T00:00:00.000Z",
          to: "2026-08-19T00:00:00.000Z",
        },
      }),
    ).toThrow(/after from/);
    expect(() =>
      list.input.parse({
        appId,
        query: {
          from: "2026-07-01T00:00:00.000Z",
          to: "2026-08-01T00:00:00.001Z",
        },
      }),
    ).toThrow(/30 days/);

    const detail = controlPlaneOperations.getWebPushMessage.output.parse({
      schemaVersion: 1,
      id: messageId,
      appId,
      deploymentId: null,
      userId: "11111111-1111-4111-8111-111111111111",
      title: "Report ready",
      body: "Open the report.",
      path: "/reports/latest",
      icon: "/_opencloud/notification-icon.png",
      status: "accepted",
      recipientCount: 1,
      acceptedCount: 1,
      failedCount: 0,
      deliveryAttempts: [
        {
          status: "accepted",
          attemptCount: 1,
          lastError: null,
          createdAt: "2026-08-23T00:00:00.000Z",
          updatedAt: "2026-08-23T00:00:01.000Z",
          acceptedAt: "2026-08-23T00:00:01.000Z",
          subscriptionId: "44444444-4444-4444-8444-444444444444",
          endpoint: "https://push.example.test/secret",
        },
      ],
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:01.000Z",
      completedAt: "2026-08-23T00:00:01.000Z",
      idempotencyKey: "report:ready",
    });
    expect(detail).not.toHaveProperty("idempotencyKey");
    expect(detail.deliveryAttempts[0]).not.toHaveProperty("subscriptionId");
    expect(detail.deliveryAttempts[0]).not.toHaveProperty("endpoint");
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
    expect(operation.input.parse({ appId })).toEqual({ appId });
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
    expect(controlPlaneOperations.getBackgroundJob.description).toContain(
      "idempotency key",
    );
  });

  it("types additive cursor pages for operations, cron, and normalized logs", () => {
    const appId = "22222222-2222-4222-8222-222222222222";
    const operationId = "33333333-3333-4333-8333-333333333333";
    const deploymentId = "44444444-4444-4444-8444-444444444444";
    const operation = {
      id: operationId,
      appId,
      deploymentId: null,
      type: "app.configure",
      state: "succeeded",
      actorType: "user",
      actorId: "55555555-5555-4555-8555-555555555555",
      idempotencyKey: "configure-page-test",
      error: null,
      createdAt: "2026-08-30T11:00:00.000Z",
      updatedAt: "2026-08-30T11:01:00.000Z",
    };

    expect(controlPlaneOperations.listAppOperationsPage).toMatchObject({
      method: "GET",
      path: "/v1/apps/{appId}/operations/page",
      queryKey: "query",
      scopes: ["app:read"],
    });
    expect(
      controlPlaneOperations.listAppOperationsPage.input.parse({
        appId,
        query: {
          cursor: "page-two",
          type: "manual_backup",
          state: "succeeded",
          limit: "25",
        },
      }),
    ).toMatchObject({
      query: {
        cursor: "page-two",
        type: "manual_backup",
        state: "succeeded",
        limit: 25,
      },
    });
    expect(
      controlPlaneOperations.listAppOperationsPage.output.parse({
        asOf: "2026-08-30T12:00:00.000Z",
        operations: [operation],
        nextCursor: "page-two",
      }),
    ).toMatchObject({ operations: [{ id: operationId }] });
    expect(() =>
      controlPlaneOperations.listAppOperationsPage.input.parse({
        appId,
        query: { limit: 101 },
      }),
    ).toThrow();
    expect(() =>
      controlPlaneOperations.listAppOperationsPage.input.parse({
        appId,
        query: { type: "../../private" },
      }),
    ).toThrow();

    expect(controlPlaneOperations.listOwnedAppOperationsPage).toMatchObject({
      method: "GET",
      path: "/v1/account/operations/page",
      auth: "user",
      scopes: [],
      queryKey: "query",
      idempotency: "none",
    });
    expect("mcp" in controlPlaneOperations.listOwnedAppOperationsPage).toBe(
      false,
    );
    expect(
      controlPlaneOperations.listOwnedAppOperationsPage.input.parse({
        query: {
          appId,
          type: "deploy",
          state: "failed",
          cursor: "account-page-two",
          limit: "10",
        },
      }),
    ).toEqual({
      query: {
        appId,
        type: "deploy",
        state: "failed",
        cursor: "account-page-two",
        limit: 10,
      },
    });
    expect(() =>
      controlPlaneOperations.listOwnedAppOperationsPage.input.parse({
        query: { appId: "not-an-app-id" },
      }),
    ).toThrow();

    expect(controlPlaneOperations.listCronInvocationsPage).toMatchObject({
      method: "GET",
      path: "/v1/apps/{appId}/cron/invocations/page",
      queryKey: "query",
      scopes: ["app:observe"],
    });
    expect(
      controlPlaneOperations.listCronInvocationsPage.output.parse({
        asOf: "2026-08-30T12:00:00.000Z",
        invocations: [
          {
            id: operationId,
            appId,
            deploymentId,
            cronName: "heartbeat",
            functionName: "probe",
            state: "succeeded",
            scheduledAt: "2026-08-30T10:59:00.000Z",
            startedAt: "2026-08-30T11:00:00.000Z",
            finishedAt: "2026-08-30T11:00:01.000Z",
            responseStatus: 200,
            error: null,
          },
        ],
        nextCursor: null,
      }),
    ).toMatchObject({ invocations: [{ cronName: "heartbeat" }] });
    expect(
      controlPlaneOperations.listCronInvocationsPage.input.parse({
        appId,
        query: { state: "failed", limit: "20" },
      }),
    ).toMatchObject({ query: { state: "failed", limit: 20 } });

    expect(controlPlaneOperations.queryLogsPage).toMatchObject({
      method: "POST",
      path: "/v1/apps/{appId}/logs/page",
      bodyKey: "body",
      scopes: ["app:observe"],
    });
    expect(
      controlPlaneOperations.queryLogsPage.input.parse({
        appId,
        body: {
          from: "2026-08-30T10:00:00.000Z",
          to: "2026-08-30T12:00:00.000Z",
          level: "error",
          surface: "function",
          limit: "20",
        },
      }),
    ).toMatchObject({ body: { level: "error", surface: "function", limit: 20 } });
    expect(
      controlPlaneOperations.queryLogsPage.output.parse({
        entries: [
          {
            id: "a".repeat(64),
            timestamp: "2026-08-30T11:00:00.000Z",
            level: "error",
            surface: "function",
            message: "Synthetic failure",
            requestId: "request-1",
          },
        ],
        nextCursor: null,
      }),
    ).toMatchObject({ entries: [{ message: "Synthetic failure" }] });
    expect(() =>
      controlPlaneOperations.queryLogsPage.input.parse({
        appId,
        body: {
          from: "2026-08-30T12:00:00.000Z",
          to: "2026-08-30T10:00:00.000Z",
        },
      }),
    ).toThrow(/after from/);
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

  it("types the existing read-only alert-rule detail without adding an MCP tool", () => {
    const appId = "22222222-2222-4222-8222-222222222222";
    const ruleId = "checkout-errors";
    const operation = controlPlaneOperations.getAlertRule;

    expect(operation).toMatchObject({
      method: "GET",
      path: "/v1/apps/{appId}/alert-rules/{ruleId}",
      scopes: ["app:observe"],
      idempotency: "none",
    });
    expect("mcp" in operation).toBe(false);
    expect(operation.input.parse({ appId, ruleId })).toEqual({ appId, ruleId });
    expect(
      operation.output.parse({
        rule: {
          id: ruleId,
          appId,
          name: "Checkout errors",
          metric: "checkout_errors",
          aggregation: "sum",
          operator: "gte",
          threshold: 3,
          window: "15m",
          minimumSamples: 1,
          severity: "warning",
          enabled: true,
          origin: "manifest",
          createdAt: "2026-08-30T10:00:00.000Z",
          updatedAt: "2026-08-30T10:00:00.000Z",
        },
        metric: {
          name: "checkout_errors",
          type: "counter",
          unit: "errors",
          description: "Failed checkout attempts.",
        },
        evaluation: {
          state: "unknown",
          value: null,
          samples: 0,
          source: "none",
          observedAt: "2026-08-30T12:00:00.000Z",
          firstFiredAt: null,
          resolvedAt: null,
          lastEvaluatedAt: "2026-08-30T12:00:00.000Z",
          lastTransitionAt: null,
        },
        points: [],
        delivery: null,
      }),
    ).toMatchObject({
      rule: { id: ruleId, origin: "manifest" },
      evaluation: { state: "unknown", samples: 0 },
      points: [],
    });
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
      inject_dev_email: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
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
    expect(tools.get("start_dev_session")?.description).toContain(
      "browserPreviewUrl",
    );
    expect(tools.get("start_dev_session")?.description).toContain("Not live");
    expect(tools.get("start_dev_session")?.description).toContain("Mobile");
    expect(tools.get("start_dev_session")?.description).toContain(
      "does not authorize promotion",
    );
    expect(tools.get("get_agent_feed")?.description).toContain(
      "without persisting alert state",
    );
    expect(tools.get("mutate_dev_data")?.description).toContain(
      "raw REST paths are not accepted",
    );
    expect(tools.get("inject_dev_email")?.description).toContain(
      "may change isolated data or external systems",
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
      expect(mcp.title.trim().length, `${mcp.toolName} title`).toBeGreaterThan(
        0,
      );
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
      browserPreviewUrl:
        "https://dev-example.opencloud.ai/_opencloud/dev/launch",
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
        notificationCapture: true,
      },
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
      lastActivityAt: "2026-08-05T00:00:00.000Z",
      expiresAt: "2026-08-06T00:00:00.000Z",
    };

    const parsed = controlPlaneOperations.getDevSession.output.parse(session);
    expect(parsed.capabilities).toEqual(session.capabilities);
    expect(parsed.browserPreviewUrl).toBe(session.browserPreviewUrl);
    expect(() =>
      controlPlaneOperations.getDevSession.output.parse({
        ...session,
        capabilities: { ...session.capabilities, files: false },
      }),
    ).toThrow();
  });
});
});
