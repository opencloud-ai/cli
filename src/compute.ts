import {
  controlPlaneOperations,
  type ControlPlaneOperationId,
  type ControlPlaneOperationInput,
} from "@opencloud/contracts/control-plane";
import { computeIdempotencyKeySchema } from "@opencloud/contracts/containers";
import { callerFailure } from "./caller-failure.js";

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

export function computeLogBody(options: ComputeLogOptions) {
  return {
    from: options.from, to: options.to, limit: Number(options.limit ?? 200),
    ...(options.contains !== undefined ? { contains: options.contains } : {}),
    ...(options.level !== undefined ? { level: options.level } : {}),
    ...(options.surface !== undefined ? { surface: options.surface } : {}),
    ...(options.workload !== undefined ? { workloadName: options.workload } : {}),
    ...(options.kind !== undefined ? { kind: options.kind } : {}),
    ...(options.execution !== undefined ? { executionId: options.execution } : {}),
    ...(options.instance !== undefined ? { instanceId: options.instance } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
  };
}
