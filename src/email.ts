import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ZodType } from "zod";
import {
  appEmailHistoryQuerySchema,
  injectDevEmailRequestSchema,
} from "@opencloud/contracts";

export interface EmailHistoryOptions {
  cursor?: string | undefined;
  limit?: string | number | undefined;
  alias?: string | undefined;
  direction?: "outbound" | "inbound" | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export interface DevEmailInjectionOptions {
  to: string;
  from: string;
  fromName?: string | undefined;
  subject?: string | undefined;
  text?: string | undefined;
  textFile?: string | undefined;
  html?: string | undefined;
  htmlFile?: string | undefined;
  replyTo?: string | undefined;
  headers?: string[] | undefined;
  attachments?: string[] | undefined;
}

export function emailHistoryQuery(options: EmailHistoryOptions) {
  return parseOrThrow(
    appEmailHistoryQuerySchema,
    {
      limit: options.limit ?? 100,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.alias ? { alias: options.alias } : {}),
      ...(options.direction ? { direction: options.direction } : {}),
      ...(options.from ? { from: options.from } : {}),
      ...(options.to ? { to: options.to } : {}),
    },
    "email history filters",
  );
}

export function devEmailCaptureLimit(value: string | number | undefined) {
  const limit = Number(value ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("--limit must be an integer between 1 and 200");
  }
  return limit;
}

export async function devEmailInjectionRequest(
  options: DevEmailInjectionOptions,
  resolvePath: (value: string) => string = (value) => path.resolve(value),
) {
  const text = await contentValue(
    options.text,
    options.textFile,
    "--text",
    "--text-file",
    resolvePath,
  );
  const html = await contentValue(
    options.html,
    options.htmlFile,
    "--html",
    "--html-file",
    resolvePath,
  );
  const attachments = await Promise.all(
    (options.attachments ?? []).map(async (value) => {
      const filePath = resolvePath(value);
      const contentBase64 = (await readFile(filePath)).toString("base64");
      return {
        name: path.basename(filePath),
        contentType: attachmentContentType(filePath),
        contentBase64,
      };
    }),
  );
  return parseOrThrow(
    injectDevEmailRequestSchema,
    {
      to: options.to,
      from: options.from,
      ...(options.fromName ? { fromName: options.fromName } : {}),
      ...(options.subject ? { subject: options.subject } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(html !== undefined ? { html } : {}),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      headers: options.headers ?? [],
      attachments,
    },
    "development email",
  );
}

export function collectOption(value: string, previous: string[] = []) {
  return [...previous, value];
}

function attachmentContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".csv": "text/csv",
      ".gif": "image/gif",
      ".htm": "text/html",
      ".html": "text/html",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".json": "application/json",
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".txt": "text/plain",
      ".webp": "image/webp",
      ".xml": "application/xml",
      ".zip": "application/zip",
    } as Record<string, string>
  )[extension] ?? "application/octet-stream";
}

async function contentValue(
  inline: string | undefined,
  file: string | undefined,
  inlineFlag: string,
  fileFlag: string,
  resolvePath: (value: string) => string,
): Promise<string | undefined> {
  if (inline !== undefined && file !== undefined) {
    throw new Error(`${inlineFlag} and ${fileFlag} cannot be used together`);
  }
  return file === undefined ? inline : readFile(resolvePath(file), "utf8");
}

function parseOrThrow<T>(
  schema: ZodType<T>,
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const location = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  throw new Error(
    `Invalid ${label}${location}: ${issue?.message ?? "invalid input"}`,
  );
}
