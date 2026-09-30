import { z } from "zod";
import {
  dashboardIntegrationNameSchema,
  devIntegrationModeSchema,
  injectDevIntegrationEventRequestSchema,
  type DevIntegrationMode,
  type InjectDevIntegrationEventRequest,
} from "@opencloud/contracts";
import { CliContractError, jsonOption, parseBoundedNumber } from "./owner-parity.js";

/** Server default and maximum page size for integration event deliveries. */
export const INTEGRATION_EVENT_DELIVERY_DEFAULT_LIMIT = 50;
const INTEGRATION_EVENT_DELIVERY_MAX_LIMIT = 100;

export interface DevIntegrationEventOptions {
  type: string;
  data?: string | undefined;
  dataFile?: string | undefined;
  id?: string | undefined;
}

/** Validates a manifest integration slot name before any journal entry or request. */
export function integrationSlotName(value: unknown): string {
  const parsed = dashboardIntegrationNameSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliContractError(
      "INVALID_INTEGRATION_NAME",
      "Integration names are manifest slot names: a lowercase letter followed by at most 62 lowercase letters, digits, or underscores",
    );
  }
  return parsed.data;
}

export function integrationEventDeliveriesQuery(limit: unknown): {
  limit: number;
} {
  return {
    limit: parseBoundedNumber(
      limit ?? INTEGRATION_EVENT_DELIVERY_DEFAULT_LIMIT,
      "--limit",
      1,
      INTEGRATION_EVENT_DELIVERY_MAX_LIMIT,
    ),
  };
}

export function devIntegrationModeRequest(value: unknown): {
  mode: DevIntegrationMode;
} {
  const parsed = devIntegrationModeSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliContractError(
      "INVALID_OPTION",
      "Development integration mode must be fake or live",
    );
  }
  return { mode: parsed.data };
}

/** Selects one eligible test connection, or clears it with an explicit null. */
export function devIntegrationTestConnectionRequest(input: {
  connectionId?: string | undefined;
  clear?: boolean | undefined;
}): { connectionId: string | null } {
  const selecting = input.connectionId !== undefined;
  if (selecting === (input.clear === true)) {
    throw new CliContractError(
      "INVALID_OPTION",
      "Pass exactly one eligible connection ID or --clear",
    );
  }
  if (!selecting) return { connectionId: null };
  const parsed = z.uuid().safeParse(input.connectionId);
  if (!parsed.success) {
    throw new CliContractError(
      "INVALID_OPTION",
      "The test connection ID must be a UUID",
    );
  }
  return { connectionId: parsed.data.toLowerCase() };
}

/**
 * Builds the synthetic event body. Omitted data lets OpenCloud use the
 * provider's declared fake payload for the event type.
 */
export async function devIntegrationEventRequest(
  options: DevIntegrationEventOptions,
  resolvePath: (value: string) => string,
): Promise<InjectDevIntegrationEventRequest> {
  const data =
    options.data === undefined && options.dataFile === undefined
      ? undefined
      : await jsonOption({
          inline: options.data,
          file: options.dataFile,
          resolvePath,
          kind: "object",
        });
  const parsed = injectDevIntegrationEventRequestSchema.safeParse({
    type: options.type,
    ...(data !== undefined ? { data } : {}),
    ...(options.id !== undefined ? { id: options.id } : {}),
  });
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const location = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  throw new CliContractError(
    "INVALID_INTEGRATION_EVENT",
    `Invalid integration event${location}: ${issue?.message ?? "invalid input"}`,
  );
}
