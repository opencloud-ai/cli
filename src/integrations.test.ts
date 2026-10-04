import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  devIntegrationEventRequest,
  devIntegrationModeRequest,
  devIntegrationTestConnectionRequest,
  integrationEventDeliveriesQuery,
  integrationSlotName,
} from "./integrations.js";

const temporaryDirectories: string[] = [];
const connectionId = "00000000-0000-4000-8000-000000000004";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("integration command inputs", () => {
  it("accepts manifest slot names and rejects path-like or uppercase names", () => {
    expect(integrationSlotName("crm_primary")).toBe("crm_primary");
    for (const value of ["CRM", "1crm", "crm-primary", "../crm", "", "a".repeat(64)]) {
      expect(() => integrationSlotName(value)).toThrow(
        expect.objectContaining({ code: "INVALID_INTEGRATION_NAME" }),
      );
    }
  });

  it("bounds event delivery pages to the server maximum", () => {
    expect(integrationEventDeliveriesQuery(undefined)).toEqual({ limit: 50 });
    expect(integrationEventDeliveriesQuery("100")).toEqual({ limit: 100 });
    for (const value of ["0", "101", "1.5", "all"]) {
      expect(() => integrationEventDeliveriesQuery(value)).toThrow(
        expect.objectContaining({ code: "INVALID_OPTION" }),
      );
    }
  });

  it("allows only fake and live development modes", () => {
    expect(devIntegrationModeRequest("live")).toEqual({ mode: "live" });
    expect(devIntegrationModeRequest("fake")).toEqual({ mode: "fake" });
    expect(() => devIntegrationModeRequest("production")).toThrow(
      expect.objectContaining({ code: "INVALID_OPTION" }),
    );
  });

  it("selects exactly one test connection or clears it with null", () => {
    expect(
      devIntegrationTestConnectionRequest({ connectionId: connectionId.toUpperCase() }),
    ).toEqual({ connectionId });
    expect(devIntegrationTestConnectionRequest({ clear: true })).toEqual({
      connectionId: null,
    });
    for (const input of [
      {},
      { connectionId, clear: true },
      { connectionId: "sandbox" },
    ]) {
      expect(() => devIntegrationTestConnectionRequest(input)).toThrow(
        expect.objectContaining({ code: "INVALID_OPTION" }),
      );
    }
  });
});

describe("synthetic integration events", () => {
  it("omits data so OpenCloud can use the provider's fake payload", async () => {
    await expect(
      devIntegrationEventRequest({ type: "contact.created" }, (value) => value),
    ).resolves.toEqual({ type: "contact.created" });
  });

  it("reads inline or app-relative file data and preserves the event ID", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencloud-integration-"));
    temporaryDirectories.push(directory);
    await writeFile(
      path.join(directory, "event.json"),
      JSON.stringify({ contactId: "c_1", tags: ["vip"] }),
    );
    await expect(
      devIntegrationEventRequest(
        { type: "contact.created", dataFile: "event.json", id: "evt-1" },
        (value) => path.resolve(directory, value),
      ),
    ).resolves.toEqual({
      type: "contact.created",
      data: { contactId: "c_1", tags: ["vip"] },
      id: "evt-1",
    });
    await expect(
      devIntegrationEventRequest(
        { type: "order.status_changed", data: '{"orderId":"o_1"}' },
        (value) => value,
      ),
    ).resolves.toEqual({
      type: "order.status_changed",
      data: { orderId: "o_1" },
    });
  });

  it("rejects undeclared shapes before a journal entry or request exists", async () => {
    const resolve = (value: string) => value;
    await expect(
      devIntegrationEventRequest({ type: "ContactCreated" }, resolve),
    ).rejects.toMatchObject({
      code: "INVALID_INTEGRATION_EVENT",
      message: expect.stringContaining("at type"),
    });
    await expect(
      devIntegrationEventRequest({ type: "contact.created", id: "" }, resolve),
    ).rejects.toMatchObject({ code: "INVALID_INTEGRATION_EVENT" });
    await expect(
      devIntegrationEventRequest(
        { type: "contact.created", data: "[]" },
        resolve,
      ),
    ).rejects.toMatchObject({ code: "INVALID_JSON_SHAPE" });
    await expect(
      devIntegrationEventRequest(
        { type: "contact.created", data: "{", dataFile: "event.json" },
        resolve,
      ),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });
});
