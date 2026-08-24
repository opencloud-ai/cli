export function devNotificationCaptureLimit(
  value: string | number | undefined,
): number {
  const limit = Number(value ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("--limit must be an integer between 1 and 200");
  }
  return limit;
}
