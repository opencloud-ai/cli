import { describe, expect, it } from "vitest";
import { controlPlaneOperations } from "./control-plane.js";
import {
  accountIntegrationConnectionSchema,
  aiIntegrationOverviewSchema,
  providerAuthorizationDestinationSchema,
  telegramPairingDestinationSchema,
} from "./dashboard-integrations.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const BINDING_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-09-01T12:00:00.000Z";

describe("dashboard integration contracts", () => {
  it("keeps account provider reads credential-free and bounded", () => {
    const parsed = accountIntegrationConnectionSchema.parse({
      id: CONNECTION_ID,
      provider: "slack",
      accountLabel: "Example workspace",
      status: "active",
      capabilities: ["slack.messages.send"],
      createdAt: NOW,
      updatedAt: NOW,
      lastUsedAt: null,
      usages: [
        {
          bindingId: BINDING_ID,
          appId: APP_ID,
          appName: "Family helper",
          appUrl: "https://family-helper.example.test",
          integrationName: "team_chat",
          label: "#family",
        },
      ],
      accessToken: "must-not-cross-the-browser-contract",
    });

    expect(parsed).not.toHaveProperty("accessToken");
    expect(() =>
      controlPlaneOperations.listAccountIntegrationConnections.output.parse(
        Array.from({ length: 501 }, () => parsed),
      ),
    ).toThrow();
    expect(
      controlPlaneOperations.listAccountIntegrationConnections,
    ).toMatchObject({
      method: "GET",
      path: "/v1/integrations/connections",
      auth: "user",
      idempotency: "none",
    });
  });

  it("types app binding row actions with explicit removal evidence", () => {
    expect(
      controlPlaneOperations.bindAppIntegration.input.parse({
        appId: APP_ID,
        integrationName: "team_chat",
        body: {
          connectionId: CONNECTION_ID,
          resourceId: "channel-1",
          label: "#family",
          triggerMode: "mention",
        },
      }),
    ).toMatchObject({ appId: APP_ID, integrationName: "team_chat" });
    const binding = controlPlaneOperations.bindAppIntegration.output.parse({
      id: BINDING_ID,
      integrationName: "team_chat",
      connectionId: CONNECTION_ID,
      callingUserId: null,
      resourceId: "channel-1",
      calendarId: "channel-1",
      label: "#family",
      accountLabel: "Example workspace",
      status: "active",
      capabilities: ["slack.messages.send"],
      triggerMode: "mention",
      createdAt: NOW,
      updatedAt: NOW,
      providerCredential: "must-not-cross-the-browser-contract",
    });
    expect(binding).not.toHaveProperty("calendarId");
    expect(binding).not.toHaveProperty("providerCredential");
    expect(
      controlPlaneOperations.unbindAppIntegration.output.parse({
        bindingId: BINDING_ID,
        removed: true,
      }),
    ).toEqual({ bindingId: BINDING_ID, removed: true });
    expect(
      controlPlaneOperations.disconnectAccountIntegrationConnection.output.parse(
        { connectionId: CONNECTION_ID, disconnected: true },
      ),
    ).toEqual({ connectionId: CONNECTION_ID, disconnected: true });
    for (const operation of [
      controlPlaneOperations.beginTelegramIntegrationPairing,
      controlPlaneOperations.listAppIntegrations,
      controlPlaneOperations.bindAppIntegration,
      controlPlaneOperations.unbindAppIntegration,
      controlPlaneOperations.updateAppAiIntegration,
    ]) {
      expect(operation.scopes).toEqual(["owner"]);
    }
  });

  it("types AI account workflows without echoing one-time secrets", () => {
    const create = controlPlaneOperations.createAiIntegrationConnection;
    const parsed = create.input.parse({
      body: {
        provider: "openai",
        authMethod: "api_key",
        label: "OpenAI billing key",
        apiKey: "sk-test-one-time-only",
      },
    });
    expect(parsed.body.apiKey).toBe("sk-test-one-time-only");
    expect(create.idempotency).toBe("none");

    const overview = aiIntegrationOverviewSchema.parse({
      schemaVersion: 1,
      providers: [],
      models: [],
      reasoningEfforts: [],
      connections: [],
      apps: [],
      apiKey: "must-not-cross-the-browser-contract",
    });
    expect(overview).not.toHaveProperty("apiKey");
    expect(
      controlPlaneOperations.submitAiIntegrationAuthorizationCode,
    ).toMatchObject({ method: "POST", idempotency: "none", bodyKey: "body" });
  });

  it("matches the AI handler's optional labels, default provider, and reconnect input", () => {
    expect(
      controlPlaneOperations.createAiIntegrationConnection.input.parse({
        body: {
          authMethod: "device_oauth",
          reconnectConnectionId: CONNECTION_ID,
        },
      }),
    ).toEqual({
      body: {
        provider: "openai",
        authMethod: "device_oauth",
        reconnectConnectionId: CONNECTION_ID,
      },
    });
  });

  it("keeps the exact AI usage projection while stripping unexpected nested state", () => {
    const parsed = aiIntegrationOverviewSchema.parse({
      schemaVersion: 1,
      providers: [],
      models: [],
      reasoningEfforts: [],
      connections: [
        {
          schemaVersion: 1,
          id: CONNECTION_ID,
          provider: "openai",
          label: "Family ChatGPT",
          authMethod: "device_oauth",
          status: "connected",
          stateVersion: 2,
          expiresAt: null,
          errorClass: null,
          accountHint: "owner@example.test",
          isDefault: true,
          connectedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
          revokedAt: null,
          encryptedCredential: "must-not-cross-the-browser-contract",
        },
      ],
      apps: [
        {
          id: APP_ID,
          name: "Family helper",
          slug: "family-helper",
          appUrl: "https://family-helper.example.test",
          aiCredentialSource: "owner",
          providerConnectionId: CONNECTION_ID,
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          usage: {
            appId: APP_ID,
            callCount: "2",
            completedCallCount: "2",
            inputTokens: "21",
            cachedInputTokens: "3",
            outputTokens: "13",
            reasoningTokens: "5",
            totalTokens: "34",
            lastUsedAt: NOW,
            rawTrace: "must-not-cross-the-browser-contract",
          },
          platformUsage: null,
        },
      ],
    });

    expect(parsed.apps[0]?.usage).toEqual({
      appId: APP_ID,
      callCount: "2",
      completedCallCount: "2",
      inputTokens: "21",
      cachedInputTokens: "3",
      outputTokens: "13",
      reasoningTokens: "5",
      totalTokens: "34",
      lastUsedAt: NOW,
    });
    expect(JSON.stringify(parsed)).not.toContain("must-not-cross");
  });

  it("allows only HTTPS provider and Telegram navigation destinations", () => {
    const expiresAt = "2026-09-01T12:10:00.000Z";

    expect(() =>
      providerAuthorizationDestinationSchema.parse({
        authorizationUrl: "javascript:alert(1)",
        expiresAt,
      }),
    ).toThrow();
    expect(() =>
      telegramPairingDestinationSchema.parse({
        pairingId: BINDING_ID,
        botUsername: "opencloud_test_bot",
        privateChatUrl: "http://t.me/opencloud_test_bot?start=private",
        groupChatUrl: "https://t.me/opencloud_test_bot?startgroup=group",
        triggerMode: "directed",
        expiresAt,
      }),
    ).toThrow();
  });
});
