import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectOption,
  devEmailCaptureLimit,
  devEmailInjectionRequest,
  emailHistoryQuery,
} from "./email.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("email history filters", () => {
  it("normalizes filters through the shared platform schema", () => {
    expect(
      emailHistoryQuery({
        cursor: "next-page",
        limit: "25",
        alias: "support",
        direction: "inbound",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-31T00:00:00.000Z",
      }),
    ).toEqual({
      cursor: "next-page",
      limit: 25,
      alias: "support",
      direction: "inbound",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-31T00:00:00.000Z",
    });
  });

  it("rejects invalid limits, aliases, and date ranges", () => {
    expect(() => emailHistoryQuery({ limit: "0" })).toThrow();
    expect(() => emailHistoryQuery({ alias: "Support" })).toThrow();
    expect(() =>
      emailHistoryQuery({
        from: "2026-02-01T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/after from/);
  });
});

describe("development email", () => {
  it("validates capture limits and repeated options", () => {
    expect(devEmailCaptureLimit("200")).toBe(200);
    expect(() => devEmailCaptureLimit("201")).toThrow(/between 1 and 200/);
    expect(collectOption("X-Two: 2", ["X-One: 1"])).toEqual([
      "X-One: 1",
      "X-Two: 2",
    ]);
  });

  it("loads body and attachment files relative to the app directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencloud-email-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "body.txt"), "Please acknowledge.");
    await writeFile(path.join(directory, "receipt.pdf"), "synthetic-pdf");

    await expect(
      devEmailInjectionRequest(
        {
          to: "support",
          from: "customer@example.test",
          fromName: "Synthetic Customer",
          subject: "Question",
          textFile: "body.txt",
          replyTo: "reply@example.test",
          headers: ["X-Test-Case: round-trip"],
          attachments: ["receipt.pdf"],
        },
        (value) => path.resolve(directory, value),
      ),
    ).resolves.toEqual({
      to: "support",
      from: "customer@example.test",
      fromName: "Synthetic Customer",
      subject: "Question",
      text: "Please acknowledge.",
      replyTo: "reply@example.test",
      headers: ["X-Test-Case: round-trip"],
      attachments: [
        {
          name: "receipt.pdf",
          contentType: "application/pdf",
          contentBase64: Buffer.from("synthetic-pdf").toString("base64"),
        },
      ],
    });
  });

  it("rejects real senders and ambiguous body sources", async () => {
    await expect(
      devEmailInjectionRequest({
        to: "support",
        from: "customer@example.com",
      }),
    ).rejects.toThrow(/reserved \.test address/);
    await expect(
      devEmailInjectionRequest({
        to: "support",
        from: "customer@example.test",
        text: "inline",
        textFile: "body.txt",
      }),
    ).rejects.toThrow(/cannot be used together/);
  });
});
