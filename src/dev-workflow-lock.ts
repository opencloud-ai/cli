import { mkdir } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";

const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 5_000;

async function withLock<T>(
  sourceRoot: string,
  name: ".dev-workflow.lock" | ".dev-state.lock",
  callback: () => Promise<T>,
): Promise<T> {
  const directory = path.join(sourceRoot, ".opencloud");
  await mkdir(directory, { recursive: true });
  // proper-lockfile keys its in-process ownership map by the `file` argument,
  // so the broad and short locks need distinct targets as well as distinct
  // lockfile paths to support the documented nested ordering.
  const target = path.join(directory, `${name}.target`);
  const release = await lockfile.lock(target, {
    realpath: false,
    lockfilePath: path.join(directory, name),
    stale: LOCK_STALE_MS,
    update: LOCK_UPDATE_MS,
    retries: {
      retries: name === ".dev-workflow.lock" ? 120 : 100,
      factor: name === ".dev-workflow.lock" ? 1.1 : 1.2,
      minTimeout: 20,
      maxTimeout: 500,
      randomize: name === ".dev-workflow.lock",
    },
  });
  try {
    return await callback();
  } finally {
    await release();
  }
}

/**
 * Serialize each complete local dev workflow across processes. Callers acquire
 * this before their first dev-state read and hold it through all remote effects
 * and their final state write/removal.
 */
export function withDevWorkflowLock<T>(
  sourceRoot: string,
  callback: () => Promise<T>,
): Promise<T> {
  return withLock(sourceRoot, ".dev-workflow.lock", callback);
}

/**
 * Protect one atomic state-file compare/write/remove. Dev workflows always
 * acquire the broader workflow lock first; never acquire these in reverse.
 */
export function withDevStateLock<T>(
  sourceRoot: string,
  callback: () => Promise<T>,
): Promise<T> {
  return withLock(sourceRoot, ".dev-state.lock", callback);
}
