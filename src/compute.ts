import {
  controlPlaneOperations,
  type ControlPlaneOperationId,
  type ControlPlaneOperationInput,
} from "@opencloud/contracts/control-plane";
import { computeIdempotencyKeySchema } from "@opencloud/contracts/containers";
import { callerFailure } from "./caller-failure.js";
import { CliContractError } from "./cli-contract-error.js";

/** Validate before opening a journal or making any request. */
export function computeInput<T extends ControlPlaneOperationId>(
  operation: T,
  value: unknown,
): ControlPlaneOperationInput<T> {
  try {
    return controlPlaneOperations[operation].input.parse(value) as ControlPlaneOperationInput<T>;
  } catch (error) {
    throw callerFailure(error);
  }
}

export function computeKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return computeIdempotencyKeySchema.parse(value);
  } catch (error) {
    throw callerFailure(error);
  }
}

export function computeJson(value: string): unknown {
  try { return JSON.parse(value); }
  catch (error) { throw callerFailure(error); }
}

export interface ComputeQueryOptions {
  workload?: string; kind?: string; state?: string;
  from?: string; to?: string; cursor?: string; limit?: string;
}

export function computeQuery(options: ComputeQueryOptions) {
  return {
    ...(options.workload !== undefined ? { workloadName: options.workload } : {}),
    ...(options.kind !== undefined ? { kind: options.kind } : {}),
    ...(options.state !== undefined ? { state: options.state } : {}),
    ...(options.from !== undefined ? { from: options.from } : {}),
    ...(options.to !== undefined ? { to: options.to } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    limit: Number(options.limit ?? 50),
  };
}

export interface ComputeLogOptions extends ComputeQueryOptions {
  contains?: string; level?: string; surface?: string;
  execution?: string; instance?: string;
}

/**
 * Where log lines come from, as the platform names them: an app's Functions,
 * its containers, the HTTP edge, the AI gateway, or the platform itself.
 */
export const LOG_SURFACES = ["function", "container", "http", "ai", "platform"] as const;
/**
 * Other names the platform accepts for a surface: the plurals people type, and
 * `runtime`, the older name for Function lines that the published telemetry
 * guide and earlier CLIs use.
 */
const LOG_SURFACE_ALIASES: Readonly<Record<string, (typeof LOG_SURFACES)[number]>> = {
  functions: "function",
  runtime: "function",
  containers: "container",
};

/**
 * The surface a log page asks for, by name or alias, as the platform reads it.
 * Any other value would only match nothing, so it is refused before a request
 * with the platform's own code and wording.
 */
export function logSurface(value: string): (typeof LOG_SURFACES)[number] {
  const name = value.trim().toLowerCase();
  const surface = Object.hasOwn(LOG_SURFACE_ALIASES, name) ? LOG_SURFACE_ALIASES[name] : name;
  const known = LOG_SURFACES.find((candidate) => candidate === surface);
  if (known) return known;
  throw callerFailure(new CliContractError(
    "LOG_SURFACE_UNKNOWN",
    `Unknown log surface ${JSON.stringify(value.trim().slice(0, 40))}: use function, container, http, ai or platform`,
  ));
}

export function computeLogBody(options: ComputeLogOptions) {
  return {
    from: options.from, to: options.to, limit: Number(options.limit ?? 200),
    ...(options.contains !== undefined ? { contains: options.contains } : {}),
    ...(options.level !== undefined ? { level: options.level } : {}),
    ...(options.surface !== undefined ? { surface: logSurface(options.surface) } : {}),
    ...(options.workload !== undefined ? { workloadName: options.workload } : {}),
    ...(options.kind !== undefined ? { kind: options.kind } : {}),
    ...(options.execution !== undefined ? { executionId: options.execution } : {}),
    ...(options.instance !== undefined ? { instanceId: options.instance } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
  };
}
