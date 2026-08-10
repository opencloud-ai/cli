import { z } from "zod";

const values = z.record(z.string(), z.unknown());
const table = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, {
  message: "table must be a lowercase SQL identifier",
});

const actionSchema = z.discriminatedUnion("action", [
  z
    .object({
      table,
      action: z.literal("create"),
      values,
    })
    .strict(),
  z
    .object({
      table,
      action: z.literal("createMany"),
      values: z.array(values).min(1).max(100),
    })
    .strict(),
  z
    .object({
      table,
      action: z.literal("updateById"),
      id: z.string().min(1).max(512),
      values,
    })
    .strict(),
  z
    .object({
      table,
      action: z.literal("deleteById"),
      id: z.string().min(1).max(512),
    })
    .strict(),
]);

export type DevDataAction =
  | "create"
  | "createMany"
  | "updateById"
  | "deleteById";

interface DevDataOptions {
  id?: string | undefined;
  values?: string | undefined;
}

function parseValues(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("--values must be valid JSON");
  }
}

export function devDataRequest(
  tableName: string,
  action: DevDataAction,
  options: DevDataOptions,
): {
  path: string;
  method: "POST" | "PATCH" | "DELETE";
  body?: unknown;
} {
  const parsed = actionSchema.safeParse({
    table: tableName,
    action,
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.values === undefined
      ? {}
      : { values: parseValues(options.values) }),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new Error(
      `Invalid ${action} fixture${location}: ${issue?.message ?? "invalid input"}`,
    );
  }
  const input = parsed.data;
  const suffix =
    "id" in input ? `?id=eq.${encodeURIComponent(input.id)}` : "";
  const method =
    input.action === "updateById"
      ? "PATCH"
      : input.action === "deleteById"
        ? "DELETE"
        : "POST";
  return {
    path: `/rest/v1/${input.table}${suffix}`,
    method,
    ...(input.action === "deleteById" ? {} : { body: input.values }),
  };
}
