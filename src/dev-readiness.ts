import { developmentReadinessTimeoutMs, type ControlPlaneOperationOutput } from "@opencloud/contracts/control-plane";
import { ApiError, type OpenCloudClient } from "./api-client.js";
import type { MutationRun, SafeMutationCheckpoint } from "./mutation-journal.js";
import { CliContractError } from "./owner-parity.js";

type Session = ControlPlaneOperationOutput<"getDevSession">;
type Journal = Pick<MutationRun, "checkpoint" | "checkpointStage" | "markAttempted" | "markUnknown">;
type Target = {
  appId: string; draftId: string; sessionId: string; revision: number;
  artifactSha256: string; serverArtifactSha256: string; baseDeploymentId: string | null;
};
type Pending = Target & { deadline: number };
const stages = new Set(["dev_apply_dispatched", "dev_apply_ready"]);

function mismatch(message: string): never {
  throw new CliContractError("MUTATION_REPLAY_MISMATCH", message);
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

async function readExact(control: OpenCloudClient, target: Pending): Promise<{ session: Session; ready: boolean }> {
  const options = () => {
    const remaining = target.deadline - Date.now();
    if (remaining <= 0) throw new Error("Development readiness deadline elapsed");
    return { timeoutMs: Math.min(30_000, remaining) };
  };
  const session = await control.call("getDevSession", { appId: target.appId, sessionId: target.sessionId }, options());
  const ready = checkSession(session, target);
  const draft = await control.call("getDraft", { appId: target.appId, draftId: target.draftId }, options());
  if (draft.revision !== target.revision || draft.id !== target.draftId || draft.appId !== target.appId) {
    return mismatch("The development draft revision changed; no apply was repeated");
  }
  const app = await control.call("getApp", { appId: target.appId }, options());
  if (app.id !== target.appId || app.activeDeploymentId !== target.baseDeploymentId || app.desiredDeploymentId !== target.baseDeploymentId) {
    return mismatch("The app's production base changed while development was preparing; no apply was repeated");
  }
  return { session, ready };
}

async function recordReady(journal: Journal, session: Session): Promise<Session> {
  await journal.checkpointStage({ ...journal.checkpoint!, stage: "dev_apply_ready", activeRevisionId: session.activeRevision!.id });
  return session;
}

async function reconcile(control: OpenCloudClient, journal: Journal, target: Pending): Promise<Session> {
  for (;;) {
    if (Date.now() >= target.deadline) return journal.markUnknown("DEV_APPLY_OUTCOME_UNKNOWN");
    let observed;
    try { observed = await readExact(control, target); }
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

/** Must run before validation or any checkpoint write on a resumed workflow. */
export async function resumeDevApply(control: OpenCloudClient, journal: Journal, input: {
  appId: string; artifactSha256: string; sessionId?: string; draftId?: string;
}): Promise<Session | null> {
  const checkpoint = journal.checkpoint;
  if (!checkpoint || !stages.has(checkpoint.stage)) return null;
  const target = targetFromCheckpoint(checkpoint, input.appId, input.artifactSha256);
  if ((input.sessionId && input.sessionId !== target.sessionId) || (input.draftId && input.draftId !== target.draftId)) {
    return mismatch("Local development state differs from the retained apply; no request was repeated");
  }
  if (checkpoint.stage === "dev_apply_ready") {
    // This result was already confirmed before its deadline. Replaying that
    // receipt permits one fresh read, never another pending wait or apply.
    const observed = await readExact(control, { ...target, deadline: Date.now() + 30_000 });
    if (!observed.ready || observed.session.activeRevision?.id !== checkpoint.activeRevisionId) {
      return mismatch("The previously confirmed development revision is no longer active");
    }
    return observed.session;
  }
  return reconcile(control, journal, target);
}

/** One explicit apply, with an immutable recovery coordinate saved first. */
export async function applyDevRevisionOnce(control: OpenCloudClient, journal: Journal, target: Target, idempotencyKey: string): Promise<Session> {
  if (journal.checkpoint && stages.has(journal.checkpoint.stage)) return mismatch("A development apply was already dispatched; reconcile it before any new effect");
  const pending = { ...target, deadline: Date.now() + developmentReadinessTimeoutMs };
  await readExact(control, pending);
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
    if (error instanceof ApiError) throw error;
    return reconcile(control, journal, pending);
  }
  if (!checkSession(session, target)) return mismatch("OpenCloud did not return the applied development revision");
  return reconcile(control, journal, pending);
}
