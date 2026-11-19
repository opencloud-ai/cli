import { developmentReadinessTimeoutMs, type ControlPlaneOperationOutput } from "@opencloud/contracts/control-plane";
import { computeErrorSchema } from "@opencloud/contracts/containers";
import { ApiError, type OpenCloudClient } from "./api-client.js";
import { CliContractError, withHint } from "./cli-contract-error.js";
import { shellArgument } from "./guidance.js";
import type { MutationRun, SafeMutationCheckpoint } from "./mutation-journal.js";

type Session = ControlPlaneOperationOutput<"getDevSession">;
type Journal = Pick<MutationRun, "checkpoint" | "checkpointStage" | "markAttempted" | "markUnknown" | "complete">;
type Target = {
  appId: string; draftId: string; sessionId: string; revision: number;
  artifactSha256: string; serverArtifactSha256: string; baseDeploymentId: string | null;
};
type Pending = Target & { deadline: number };
/** How hints name the workflow: the directory as given and the command run. */
export interface DevApplyContext { directory?: string | undefined; command?: "start" | "sync" | undefined }
const stages = new Set(["dev_apply_dispatched", "dev_apply_ready"]);

function mismatch(message: string): never {
  throw new CliContractError("MUTATION_REPLAY_MISMATCH", message);
}

/** A dev command in backticks, so a sentence's full stop never joins a path such as ".". */
function dev(action: string, context: DevApplyContext): string {
  return `\`opencloud app dev ${action}${context.directory === undefined ? "" : ` ${shellArgument(context.directory)}`}\``;
}

/**
 * OpenCloud answered the apply itself and activated nothing: a coded 4xx
 * refusal, or a compute error, which an apply raises only before it activates
 * the revision (the server then marks that revision failed, so applying it
 * again is safe). A gateway's 502 or 504, a lost reply or an uncoded 5xx can
 * come while or after the apply takes effect, so they stay uncertain.
 */
export function refusedApply(error: ApiError): boolean {
  if (error.code === null) return false;
  if (error.status >= 400 && error.status < 500) return true;
  return computeErrorSchema.safeParse({ statusCode: error.status, code: error.code, message: error.message, details: error.details }).success;
}

/** Nothing is pending any more: record why, and let the next run start afresh. */
async function settle(journal: Journal, stage: string): Promise<void> {
  if (journal.checkpoint) await journal.checkpointStage({ ...journal.checkpoint, stage });
  await journal.complete();
}

/**
 * The session can never take this apply: production moved past its release,
 * or it stopped or expired. The same codes and next steps as OpenCloud's own
 * answers; whatever an earlier apply did no longer matters.
 */
function unusableSession(session: Session | null, app: { activeDeploymentId: string | null; desiredDeploymentId: string | null } | null,
  target: Target, context: DevApplyContext, dispatched: boolean): CliContractError | null {
  const restart = `Run ${dev("stop", context)}, then ${dev("start", context)}.`;
  const sent = dispatched ? "No apply was repeated" : "No apply was sent";
  if (session && (session.status === "stopped" || session.status === "expired")) {
    return new CliContractError(session.status === "stopped" ? "DEV_SESSION_STOPPED" : "DEV_SESSION_EXPIRED",
      `This development session ${session.status === "stopped" ? "was stopped" : "has expired"}: start a new one from the current release with opencloud app dev start; your source is kept. ${sent}.`,
      { hint: `Run ${dev("start", context)}.`, fields: { sessionId: session.id, sessionStatus: session.status } });
  }
  if (session?.status === "stale") {
    return new CliContractError("DEV_SESSION_STALE",
      `Production changed after this development session started, so it can no longer sync, verify or promote. ${sent}; your source is kept.`,
      { hint: restart, fields: { sessionId: session.id, sessionStatus: "stale", baseDeploymentId: session.baseDeploymentId } });
  }
  if (app && (app.activeDeploymentId !== target.baseDeploymentId || app.desiredDeploymentId !== target.baseDeploymentId)) {
    const deploying = app.activeDeploymentId === target.baseDeploymentId;
    return new CliContractError("ACTIVE_DEPLOYMENT_CHANGED",
      deploying
        ? `A new production release is being deployed, so this development session will no longer match production. ${sent}; your source is kept. Wait for the deploy to finish.`
        : `Production changed after this development session started, so it can no longer sync, verify or promote. ${sent}; your source is kept.`,
      { hint: restart, fields: {
        expectedActiveDeploymentId: target.baseDeploymentId, actualActiveDeploymentId: app.activeDeploymentId,
        ...(deploying ? { latestDeploymentId: app.desiredDeploymentId } : {}),
      } });
  }
  return null;
}

function checkSession(session: Session, target: Target): boolean {
  if (session.appId !== target.appId || session.draftId !== target.draftId || session.id !== target.sessionId ||
      session.baseDeploymentId !== target.baseDeploymentId || !["active", "verifying", "verified"].includes(session.status)) {
    return mismatch("Development session identity, base or usable state changed; no apply was repeated");
  }
  const revision = session.activeRevision;
  if (!revision || revision.draftRevision < target.revision) return false;
  if (revision.draftRevision !== target.revision || revision.artifactSha256 !== target.serverArtifactSha256) {
    return mismatch("Development activated a different revision or artifact; it is not this request's result");
  }
  return true;
}

async function readExact(control: OpenCloudClient, journal: Journal, target: Pending,
  context: DevApplyContext, dispatched: boolean): Promise<{ session: Session; ready: boolean }> {
  const options = () => {
    const remaining = target.deadline - Date.now();
    if (remaining <= 0) throw new Error("Development readiness deadline elapsed");
    return { timeoutMs: Math.min(30_000, remaining) };
  };
  const session = await control.call("getDevSession", { appId: target.appId, sessionId: target.sessionId }, options());
  if (session.appId === target.appId && session.id === target.sessionId) {
    const unusable = unusableSession(session, null, target, context, dispatched);
    if (unusable) {
      await settle(journal, "dev_session_unusable");
      throw unusable;
    }
  }
  const ready = checkSession(session, target);
  const draft = await control.call("getDraft", { appId: target.appId, draftId: target.draftId }, options());
  if (draft.revision !== target.revision || draft.id !== target.draftId || draft.appId !== target.appId) {
    return mismatch("The development draft revision changed; no apply was repeated");
  }
  const app = await control.call("getApp", { appId: target.appId }, options());
  const overtaken = app.id === target.appId ? unusableSession(null, app, target, context, dispatched) : null;
  if (app.id !== target.appId) return mismatch("OpenCloud returned a different app; no apply was repeated");
  if (overtaken) {
    await settle(journal, "dev_session_unusable");
    throw overtaken;
  }
  return { session, ready };
}

async function recordReady(journal: Journal, session: Session): Promise<Session> {
  await journal.checkpointStage({ ...journal.checkpoint!, stage: "dev_apply_ready", activeRevisionId: session.activeRevision!.id });
  return session;
}

async function reconcile(control: OpenCloudClient, journal: Journal, target: Pending, context: DevApplyContext): Promise<Session> {
  for (;;) {
    if (Date.now() >= target.deadline) return journal.markUnknown("DEV_APPLY_OUTCOME_UNKNOWN");
    let observed;
    try { observed = await readExact(control, journal, target, context, true); }
    catch (error) {
      // Explicit API refusals and identity changes stay visible. Only read
      // transport failures may be retried; this loop never issues a POST.
      if (error instanceof ApiError || error instanceof CliContractError) throw error;
    }
    if (observed?.ready && Date.now() < target.deadline) return recordReady(journal, observed.session);
    const remaining = target.deadline - Date.now();
    if (remaining <= 0) return journal.markUnknown("DEV_APPLY_OUTCOME_UNKNOWN");
    await new Promise(resolve => setTimeout(resolve, Math.min(2_000, remaining)));
  }
}

function targetFromCheckpoint(checkpoint: SafeMutationCheckpoint, appId: string, localDigest: string): Pending {
  if (checkpoint.artifactSha256 !== localDigest || !checkpoint.serverArtifactSha256 || !checkpoint.draftId || !checkpoint.sessionId ||
      !checkpoint.revision || checkpoint.baseDeploymentId === undefined || !checkpoint.devApplyDeadline) {
    return mismatch("The retained development apply lacks exact recovery coordinates; no apply was repeated");
  }
  const deadline = Date.parse(checkpoint.devApplyDeadline);
  if (!Number.isFinite(deadline) || deadline > Date.now() + developmentReadinessTimeoutMs) {
    return mismatch("The retained development deadline is invalid; no apply was repeated");
  }
  return { appId, draftId: checkpoint.draftId, sessionId: checkpoint.sessionId, revision: checkpoint.revision,
    artifactSha256: localDigest, serverArtifactSha256: checkpoint.serverArtifactSha256, baseDeploymentId: checkpoint.baseDeploymentId, deadline };
}

/** Must run before validation or any checkpoint write on a resumed workflow. */
export async function resumeDevApply(control: OpenCloudClient, journal: Journal, input: {
  appId: string; artifactSha256: string; sessionId?: string; draftId?: string;
} & DevApplyContext): Promise<Session | null> {
  const checkpoint = journal.checkpoint;
  if (!checkpoint || !stages.has(checkpoint.stage)) return null;
  const target = targetFromCheckpoint(checkpoint, input.appId, input.artifactSha256);
  if ((input.sessionId && input.sessionId !== target.sessionId) || (input.draftId && input.draftId !== target.draftId)) {
    return mismatch("Local development state differs from the retained apply; no request was repeated");
  }
  if (checkpoint.stage === "dev_apply_ready") {
    // This result was already confirmed before its deadline. Replaying that
    // receipt permits one fresh read, never another pending wait or apply.
    const observed = await readExact(control, journal, { ...target, deadline: Date.now() + 30_000 }, input, true);
    if (!observed.ready || observed.session.activeRevision?.id !== checkpoint.activeRevisionId) {
      return mismatch("The previously confirmed development revision is no longer active");
    }
    return observed.session;
  }
  return reconcile(control, journal, target, input);
}

/** One explicit apply, with an immutable recovery coordinate saved first. */
export async function applyDevRevisionOnce(control: OpenCloudClient, journal: Journal, target: Target, idempotencyKey: string,
  context: DevApplyContext = {}): Promise<Session> {
  if (journal.checkpoint && stages.has(journal.checkpoint.stage)) return mismatch("A development apply was already dispatched; reconcile it before any new effect");
  const pending = { ...target, deadline: Date.now() + developmentReadinessTimeoutMs };
  await readExact(control, journal, pending, context, false);
  await journal.checkpointStage({ stage: "dev_apply_dispatched", artifactSha256: target.artifactSha256,
    serverArtifactSha256: target.serverArtifactSha256, draftId: target.draftId, sessionId: target.sessionId,
    revision: target.revision, baseDeploymentId: target.baseDeploymentId, devApplyDeadline: new Date(pending.deadline).toISOString() });
  await journal.markAttempted();
  if (Date.now() >= pending.deadline) return journal.markUnknown("DEV_APPLY_OUTCOME_UNKNOWN");
  let session;
  try {
    session = await control.call("applyDevRevision", { appId: target.appId, sessionId: target.sessionId },
      { idempotencyKey, timeoutMs: Math.max(1, pending.deadline - Date.now()) });
  } catch (error) {
    if (!(error instanceof ApiError)) return reconcile(control, journal, pending, context);
    if (refusedApply(error)) {
      // A definite refusal is recorded as such, so running the command again
      // sends a new apply instead of waiting out this one's deadline.
      await settle(journal, "dev_apply_refused");
      const details = error.details && typeof error.details === "object" ? (error.details as Record<string, unknown>) : {};
      if (typeof details.suggestedFix !== "string" && context.command) {
        // OpenCloud's own next step, when it names one, says more than this.
        const again = error.retryable ? "run" : "fix what the message names, then run";
        withHint(error, context.command === "start"
          ? `Nothing was applied, and the development session is kept: ${again} ${dev("start", context)} again to retry with it, or ${dev("stop", context)} to end it.`
          : `Nothing was applied: the development session keeps its earlier revision. ${again.charAt(0).toUpperCase()}${again.slice(1)} ${dev("sync", context)} again.`);
      }
    }
    throw error;
  }
  if (!checkSession(session, target)) return mismatch("OpenCloud did not return the applied development revision");
  return reconcile(control, journal, pending, context);
}
