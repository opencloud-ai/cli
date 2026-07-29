import { describe, expect, it, vi } from "vitest";
import {
  parseRuntimeVerificationSpec,
  verifyStorage,
} from "./runtime-verify.js";

describe("runtime verification contract", () => {
  const manifest = (authorization: "app" | "owner-prefix" = "app") => ({
    schemaVersion: 1 as const,
    appId: "aeea1c71-72a3-4b1d-a32e-213900735091",
    version: "test",
    frontend: { directory: "frontend", spa: true },
    storage: { authorization },
    migrations: [],
    functions: [
      {
        name: "reading-probe",
        entrypoint: "functions/reading-probe/index.ts",
        verifyJwt: true,
      },
    ],
    cron: [
      {
        name: "reading-heartbeat",
        schedule: "* * * * *",
        function: "reading-probe",
        enabled: true,
      },
    ],
    health: { path: "/" },
    requiredSecrets: ["READING_VERIFY_SECRET"],
  });

  it("parses a reusable full-runtime verification contract", () => {
    expect(
      parseRuntimeVerificationSpec(`
schemaVersion: 1
data:
  table: reading_items
  markerColumn: title
  insert:
    status: unread
storage:
  objectPrefix: opencloud-verify/reading
realtime:
  topic: reading
function:
  name: reading-probe
  secretName: READING_VERIFY_SECRET
  digestField: secretDigest
  presentField: secretPresent
cron:
  name: reading-heartbeat
`, manifest()),
    ).toMatchObject({
      data: {
        mode: "owner",
        table: "reading_items",
        ownerColumn: "owner_id",
        markerColumn: "title",
      },
      function: {
        digestField: "secretDigest",
        presentField: "secretPresent",
      },
      storage: {
        authorization: "app",
      },
      cron: { timeoutSeconds: 120 },
    });
  });

  it("parses owner-prefixed Storage verification semantics", () => {
    expect(
      parseRuntimeVerificationSpec(`
schemaVersion: 1
data:
  table: reading_items
  markerColumn: title
storage:
  authorization: owner-prefix
realtime:
  topic: reading
function:
  name: reading-probe
  secretName: READING_VERIFY_SECRET
cron:
  name: reading-heartbeat
`, manifest("owner-prefix")).storage,
    ).toEqual({
      authorization: "owner-prefix",
      objectPrefix: "opencloud-verify",
    });
  });

  it("accepts documented camelCase function response fields", () => {
    expect(
      parseRuntimeVerificationSpec(`
schemaVersion: 1
data:
  table: reading_items
  markerColumn: title
realtime:
  topic: reading
function:
  name: reading-probe
  secretName: READING_VERIFY_SECRET
  digestField: secretDigest
  presentField: secretPresent
cron:
  name: reading-heartbeat
`, manifest()).function,
    ).toMatchObject({
      digestField: "secretDigest",
      presentField: "secretPresent",
    });
  });

  it("rejects identifiers that could escape a same-origin runtime path", () => {
    expect(() =>
      parseRuntimeVerificationSpec(`
schemaVersion: 1
data:
  table: "../other"
  markerColumn: title
realtime:
  topic: reading
function:
  name: reading-probe
  secretName: READING_VERIFY_SECRET
cron:
  name: reading-heartbeat
`, manifest()),
    ).toThrow();
  });

  it("rejects verifier settings that contradict the manifest", () => {
    expect(() =>
      parseRuntimeVerificationSpec(`
schemaVersion: 1
data:
  table: reading_items
  markerColumn: title
storage:
  authorization: app
realtime:
  topic: reading
function:
  name: reading-probe
  secretName: READING_VERIFY_SECRET
cron:
  name: reading-heartbeat
`, manifest("owner-prefix")),
    ).toThrow(/manifest declares owner-prefix/);
  });

  it("rejects unknown verifier fields before live execution", () => {
    expect(() =>
      parseRuntimeVerificationSpec(`
schemaVersion: 1
data:
  table: reading_items
  markerColumn: title
  inventedMode: unsafe
realtime:
  topic: reading
function:
  name: reading-probe
  secretName: READING_VERIFY_SECRET
cron:
  name: reading-heartbeat
`, manifest()),
    ).toThrow();
  });
});

describe("owner-prefixed Storage verification", () => {
  const firstUserId = "193da750-5dbb-4aac-872c-4d67a78f1d49";
  const secondUserId = "28248e8f-19ac-4bb7-88bb-b1d86739ae58";
  const response = (ok: boolean, body = "") => ({
    ok,
    status: ok ? 200 : 403,
    headers: {},
    body,
    value: body,
  });

  it("requires the owner path and observes cross-user read and write denial", async () => {
    const payload = "OpenCloud verification marker";
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response(true, payload))
      .mockResolvedValueOnce(response(false))
      .mockResolvedValueOnce(response(false))
      .mockResolvedValueOnce(response(false))
      .mockResolvedValueOnce(response(false))
      .mockResolvedValueOnce(response(true));

    await expect(
      verifyStorage(
        { request } as never,
        { appUrl: "https://reading.example.test" } as never,
        {
          appId: "aeea1c71-72a3-4b1d-a32e-213900735091",
          supabaseAnonKey: "anon-key",
          storageBucket: "app-aeea1c71-72a3-4b1d-a32e-213900735091",
        },
        {
          first: {
            cookie: "first-cookie",
            accessToken: "first-token",
            userId: firstUserId,
          },
          second: {
            cookie: "second-cookie",
            accessToken: "second-token",
            userId: secondUserId,
          },
        },
        {
          authorization: "owner-prefix",
          objectPrefix: "opencloud-verify",
        },
        "marker",
      ),
    ).resolves.toMatchObject({ status: "passed" });

    expect(request.mock.calls[0]?.[1]).toContain(
      `/${firstUserId}/opencloud-verify/marker.txt`,
    );
    expect(request.mock.calls[4]?.[1]).toContain(
      `/${secondUserId}/opencloud-verify/marker-forged.txt`,
    );
    expect(request).toHaveBeenCalledTimes(7);
  });

  it("fails if a second user can read an owner-prefixed object", async () => {
    const payload = "OpenCloud verification marker";
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response(true, payload))
      .mockResolvedValueOnce(response(true, payload));

    await expect(
      verifyStorage(
        { request } as never,
        { appUrl: "https://reading.example.test" } as never,
        {
          appId: "aeea1c71-72a3-4b1d-a32e-213900735091",
          supabaseAnonKey: "anon-key",
          storageBucket: "app-aeea1c71-72a3-4b1d-a32e-213900735091",
        },
        {
          first: {
            cookie: "first-cookie",
            accessToken: "first-token",
            userId: firstUserId,
          },
          second: {
            cookie: "second-cookie",
            accessToken: "second-token",
            userId: secondUserId,
          },
        },
        {
          authorization: "owner-prefix",
          objectPrefix: "opencloud-verify",
        },
        "marker",
      ),
    ).rejects.toThrow(/second authenticated user/);
  });
});
