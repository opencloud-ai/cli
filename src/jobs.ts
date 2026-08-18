const queueName = /^[a-z][a-z0-9-]{0,62}$/;
const backgroundJobStates = new Set([
  "queued",
  "running",
  "retry_wait",
  "succeeded",
  "dead_lettered",
]);

export interface BackgroundJobsQueryOptions {
  queue?: string;
  state?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string | number;
}

function timestamp(value: string | undefined, label: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new Error(`${label} must be an ISO 8601 timestamp with an offset`);
  }
  return parsed;
}

export function backgroundJobsQuery(
  options: BackgroundJobsQueryOptions,
): URLSearchParams {
  const limit = Number(options.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Background job limit must be an integer from 1 through 200");
  }
  if (options.queue && !queueName.test(options.queue)) {
    throw new Error("Queue must use lowercase kebab-case and at most 63 characters");
  }
  if (options.state && !backgroundJobStates.has(options.state)) {
    throw new Error(
      "Background job state must be queued, running, retry_wait, succeeded, or dead_lettered",
    );
  }
  if (options.cursor && options.cursor.length > 512) {
    throw new Error("Background job cursor must not exceed 512 characters");
  }
  const from = timestamp(options.from, "Background job from");
  const to = timestamp(options.to, "Background job to");
  if (from !== null && to !== null && from > to) {
    throw new Error("Background job to must be after from");
  }
  return new URLSearchParams({
    limit: String(limit),
    ...(options.queue ? { queue: options.queue } : {}),
    ...(options.state ? { state: options.state } : {}),
    ...(options.from ? { from: options.from } : {}),
    ...(options.to ? { to: options.to } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
}

export function backgroundJobPath(appId: string, jobId: string): string {
  return `/v1/apps/${encodeURIComponent(appId)}/jobs/${encodeURIComponent(jobId)}`;
}
