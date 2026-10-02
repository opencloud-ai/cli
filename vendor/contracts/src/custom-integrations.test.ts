import { describe, expect, it } from "vitest";
import {
  createCustomIntegrationConnectionRequestSchema,
  updateCustomIntegrationConnectionRequestSchema,
} from "./custom-integrations.js";
import { integrationContractFunctionNames, parseManifest } from "./manifest.js";

const base = {
  schemaVersion: 3,
  appId: "aeea1c71-72a3-4b1d-a32e-213900735091",
  frontend: { directory: "frontend", spa: true },
  runtime: { sdk: { version: "2.5.0" } },
  functions: [
    { name: "orders-list", entrypoint: "functions/orders-list/index.ts", access: "system" },
  ],
};

const provider = {
  ...base,
  provides: {
    integration: {
      name: "acme-erp",
      title: "Acme ERP",
      description: "Orders from the Acme ERP.",
      credentials: [
        { name: "ERP_API_KEY", label: "API key" },
        { name: "ERP_BASE_URL", label: "Base URL", secret: false },
      ],
      capabilities: [{ name: "orders.read", description: "Read orders" }],
      operations: [
        {
          name: "orders.list",
          capability: "orders.read",
          function: "orders-list",
          description: "List orders by status.",
          input: { type: "object", properties: { status: { type: "string" } } },
          fake: { orders: [{ id: "ord_1", status: "open" }] },
        },
      ],
    },
  },
};

describe("custom integration manifests", () => {
  it("publishes a provider contract with defaults for credentials", () => {
    const manifest = parseManifest(provider);
    expect(manifest.schemaVersion).toBe(3);
    if (manifest.schemaVersion !== 3) throw new Error("expected schema 3");
    expect(manifest.provides?.integration.credentials).toEqual([
      { name: "ERP_API_KEY", label: "API key", secret: true, optional: false },
      { name: "ERP_BASE_URL", label: "Base URL", secret: false, optional: false },
    ]);
    expect(manifest.provides?.integration.operations[0]?.fake).toEqual({
      orders: [{ id: "ord_1", status: "open" }],
    });
  });

  it("requires operations to target declared system Functions and declared capabilities", () => {
    const contract = provider.provides.integration;
    expect(() =>
      parseManifest({
        ...provider,
        functions: [{ ...base.functions[0], access: "user" }],
      }),
    ).toThrow(/must declare access: system/);
    expect(() =>
      parseManifest({
        ...provider,
        provides: {
          integration: {
            ...contract,
            operations: [{ ...contract.operations[0], function: "missing" }],
          },
        },
      }),
    ).toThrow(/references unknown function: missing/);
    expect(() =>
      parseManifest({
        ...provider,
        provides: {
          integration: {
            ...contract,
            operations: [{ ...contract.operations[0], capability: "orders.write" }],
          },
        },
      }),
    ).toThrow(/undeclared capability orders.write/);
  });

  it("rejects reserved operation names, duplicates, and a missing fake output", () => {
    const contract = provider.provides.integration;
    const operation = contract.operations[0]!;
    for (const operations of [
      [{ ...operation, name: "bindings.list" }],
      [{ ...operation, name: "erp.bindings.list" }],
      [operation, operation],
      [{ ...operation, fake: undefined }],
    ]) {
      expect(() =>
        parseManifest({ ...provider, provides: { integration: { ...contract, operations } } }),
      ).toThrow();
    }
  });

  it("keeps credential names distinct from app secrets and runtime prefixes", () => {
    const contract = provider.provides.integration;
    expect(() =>
      parseManifest({ ...provider, secrets: { ERP_API_KEY: "required" } }),
    ).toThrow(/must not reuse an app secret name/);
    expect(() =>
      parseManifest({
        ...provider,
        provides: {
          integration: {
            ...contract,
            credentials: [{ name: "OPENCLOUD_TOKEN", label: "Token" }],
          },
        },
      }),
    ).toThrow(/reserved OpenCloud runtime prefix/);
  });

  it("publishes OAuth, per-connection sync, a webhook, and events on SDK 2.6.0", () => {
    const contract = provider.provides.integration;
    const extended = {
      ...provider,
      runtime: { sdk: { version: "2.6.0" } },
      functions: [
        ...base.functions,
        ...["oauth-exchange", "oauth-refresh", "sync-orders", "receive-webhook"].map((name) => ({
          name,
          entrypoint: `functions/${name}/index.ts`,
          access: "system",
        })),
      ],
      provides: {
        integration: {
          ...contract,
          authorization: {
            type: "oauth2",
            authorizationUrl: "https://erp.example/oauth/authorize",
            clientId: "synthetic-client",
            scopes: ["orders:read"],
            exchange: "oauth-exchange",
            refresh: "oauth-refresh",
          },
          sync: { function: "sync-orders", schedule: "*/15 * * * *", timezone: "Europe/London" },
          webhook: { function: "receive-webhook" },
          events: [
            {
              type: "order.created",
              capability: "orders.read",
              description: "A new order was placed.",
              fake: { id: "ord_1003" },
            },
          ],
        },
      },
    };
    const manifest = parseManifest(extended);
    if (manifest.schemaVersion !== 3) throw new Error("expected schema 3");
    expect([...integrationContractFunctionNames(manifest)].sort()).toEqual([
      "oauth-exchange",
      "oauth-refresh",
      "orders-list",
      "receive-webhook",
      "sync-orders",
    ]);
    expect(integrationContractFunctionNames(parseManifest(base)).size).toBe(0);
    expect(manifest.provides?.integration.authorization).toEqual({
      type: "oauth2",
      authorizationUrl: "https://erp.example/oauth/authorize",
      clientId: "synthetic-client",
      scopes: ["orders:read"],
      pkce: true,
      exchange: "oauth-exchange",
      refresh: "oauth-refresh",
      accessToken: "OAUTH_ACCESS_TOKEN",
    });
    expect(() => parseManifest({ ...extended, runtime: { sdk: { version: "2.5.0" } } })).toThrow(
      /require runtime SDK version 2.6.0/,
    );
    const invalid = (integration: Record<string, unknown>) =>
      parseManifest({
        ...extended,
        provides: { integration: { ...extended.provides.integration, ...integration } },
      });
    expect(() => invalid({ sync: { function: "sync-orders", schedule: "every minute" } })).toThrow(
      /invalid cron schedule/,
    );
    expect(() => invalid({ webhook: { function: "status-page" } })).toThrow(/unknown function/);
    expect(() =>
      invalid({
        events: [{ type: "order.created", capability: "orders.write", description: "x", fake: {} }],
      }),
    ).toThrow(/undeclared capability orders.write/);
    expect(() =>
      invalid({
        authorization: {
          ...extended.provides.integration.authorization,
          authorizationUrl: "http://erp.example/oauth",
        },
      }),
    ).toThrow(/https URL/);
    expect(() =>
      invalid({
        authorization: { ...extended.provides.integration.authorization, accessToken: "ERP_API_KEY" },
      }),
    ).toThrow(/access token name must differ/);
  });

  it("publishes only from schema 3", () => {
    expect(() =>
      parseManifest({ ...provider, schemaVersion: 2, version: "2026.09.30-1" }),
    ).toThrow();
  });

  it("declares consumer slots for app-account custom integrations", () => {
    const manifest = parseManifest({
      ...base,
      integrations: {
        erp: {
          provider: "custom",
          integration: "acme-erp",
          account: "app",
          capabilities: ["orders.read"],
        },
      },
    });
    expect(manifest.integrations.erp).toEqual({
      provider: "custom",
      integration: "acme-erp",
      account: "app",
      cardinality: "one",
      capabilities: ["orders.read"],
    });
  });

  it("accepts calling-user slots and system event handlers for app slots", () => {
    const slot = {
      provider: "custom",
      integration: "acme-erp",
      account: "app",
      capabilities: ["orders.read"],
    };
    expect(
      parseManifest({ ...base, integrations: { erp: { ...slot, account: "calling_user" } } })
        .integrations.erp,
    ).toMatchObject({ account: "calling_user" });
    expect(
      parseManifest({
        ...base,
        integrations: {
          erp: { ...slot, events: { function: "orders-list", types: ["order.created"] } },
        },
      }).integrations.erp,
    ).toMatchObject({ events: { function: "orders-list", types: ["order.created"] } });
  });

  it("rejects calling-user events, non-system handlers, and SDKs without the generic client", () => {
    const slot = {
      provider: "custom",
      integration: "acme-erp",
      account: "app",
      capabilities: ["orders.read"],
    };
    expect(() =>
      parseManifest({
        ...base,
        integrations: {
          erp: { ...slot, account: "calling_user", events: { function: "orders-list" } },
        },
      }),
    ).toThrow(/events require account: app/);
    expect(() =>
      parseManifest({
        ...base,
        functions: [{ ...base.functions[0], access: "user" }],
        integrations: { erp: { ...slot, events: { function: "orders-list" } } },
      }),
    ).toThrow(/must declare access: system/);
    expect(() =>
      parseManifest({
        ...base,
        integrations: { erp: { ...slot, events: { function: "missing" } } },
      }),
    ).toThrow(/unknown function: missing/);
    expect(() =>
      parseManifest({
        ...base,
        runtime: { sdk: { version: "2.1.0" } },
        integrations: { erp: slot },
      }),
    ).toThrow(/require runtime SDK version 2.2.0/);
    expect(() =>
      parseManifest({
        ...base,
        integrations: { erp: { ...slot, capabilities: ["Orders"] } },
      }),
    ).toThrow(/lowercase dotted names/);
  });
});

describe("custom integration connection requests", () => {
  it("accepts write-only credential values and defaults to personal custody", () => {
    expect(
      createCustomIntegrationConnectionRequestSchema.parse({
        label: "Production ERP",
        fields: { ERP_API_KEY: "synthetic-value" },
      }),
    ).toEqual({
      label: "Production ERP",
      custody: "personal",
      fields: { ERP_API_KEY: "synthetic-value" },
    });
  });

  it("requires a change and rejects unknown keys", () => {
    expect(() => updateCustomIntegrationConnectionRequestSchema.parse({})).toThrow(
      /Provide a new label or credential values/,
    );
    expect(() =>
      createCustomIntegrationConnectionRequestSchema.parse({
        label: "Production ERP",
        fields: {},
        providerToken: "unexpected",
      }),
    ).toThrow();
  });
});
