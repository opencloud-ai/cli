/**
 * Sentences that tell a person or agent what to run next. They name exact
 * commands with the values the user gave, so they can be copied as they are.
 * Callers pass them through brandText, which renames `opencloud`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A value as a POSIX shell word: unchanged when safe, otherwise single-quoted. */
export function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The command line `opencloud <route> <arguments…>`, quoted for a shell. */
export function commandLine(route: readonly string[], args: readonly string[] = []): string {
  return ["opencloud", ...route, ...args.map(shellArgument)].join(" ");
}

/** The unresolved journal entry an error names; see PendingMutation. */
export interface PendingView {
  command: string;
  idempotencyKey: string;
  /** Whether the CLI chose the key because none was given. */
  generatedKey?: boolean | undefined;
  state: string;
  unknownCode?: string | undefined;
  appId: string;
  operationId?: string | undefined;
  draftId?: string | undefined;
  revision?: number | undefined;
  sessionId?: string | undefined;
}

/** The command that failed: its route below the program and its arguments in order. */
export interface RunningCommandView {
  route: readonly string[];
  args: ReadonlyMap<string, string>;
}

const quoted = (command: string) => `\`${command}\``;

/** How to see what a journaled request did: its session, operation or draft. */
function checkCommand(pending: PendingView, running: RunningCommandView): string {
  const directory = running.args.get("directory");
  if (pending.command.startsWith("opencloud app dev ") && directory !== undefined) {
    return quoted(commandLine(["app", "dev", "status"], [directory]));
  }
  if (pending.operationId) return quoted(commandLine(["operation", "get"], [pending.operationId]));
  if (pending.draftId) return quoted(commandLine(["draft", "get"], [pending.appId, pending.draftId]));
  return quoted(commandLine(["operation", "list"], [pending.appId]));
}

/**
 * What to run after the mutation journal stopped a command: resume the
 * unresolved request with its own key, check what it did, or send a new one.
 * The resume command repeats the failed command's arguments when it is the
 * same command; its other input (files, options) must match the original.
 */
export function journalHint(code: string, pending: PendingView, running: RunningCommandView): string | undefined {
  const current = commandLine(running.route);
  const same = pending.command === current;
  const resume = same
    ? quoted(`${commandLine(running.route, [...running.args.values()])} --idempotency-key ${pending.idempotencyKey}`)
    : quoted(`${pending.command} … --idempotency-key ${pending.idempotencyKey}`);
  const check = checkCommand(pending, running);
  if (code === "IDEMPOTENCY_KEY_REUSED") {
    // The key is taken whatever happened to its request: this one needs a new key.
    if (pending.state === "completed") return "Use a new --idempotency-key for this request.";
    if (pending.state === "unknown") {
      return `Check whether that request took effect with ${check}. Use a new --idempotency-key for this request.`;
    }
    return `To finish that request, run it again with the input it had: ${resume}. Use a new --idempotency-key for this request.`;
  }
  if (code === "MUTATION_IN_PROGRESS") {
    if (pending.state === "completed") return "Run the command again.";
    if (pending.state === "unknown") {
      return `Check whether the earlier request took effect with ${check}. If it did not, add a new --idempotency-key to send this request.`;
    }
    return `To finish the earlier request, run it again with the input it had: ${resume}. To see what it has done so far, run ${check}. To send this request separately, add a new --idempotency-key.`;
  }
  if (code === "DEV_APPLY_OUTCOME_UNKNOWN") {
    const again = same ? quoted(`${commandLine(running.route, [...running.args.values()])} --idempotency-key <new-key>`) : "the command with a new --idempotency-key";
    const revision = pending.revision === undefined ? "" : `: it did if session.activeRevision.draftRevision is ${pending.revision}`;
    return `OpenCloud did not confirm the development apply in time, and it was not repeated. Check with ${check}${revision}. If it did not take effect, run ${again} to apply again.`;
  }
  if (code === "DRAFT_VALIDATION_WAIT_TIMEOUT") {
    // A generated key rejoins without being named; a given one must be given again.
    const again = same
      ? quoted(`${commandLine(running.route, [...running.args.values()])}${pending.generatedKey ? "" : ` --idempotency-key ${pending.idempotencyKey}`}`)
      : quoted(`${pending.command} … --idempotency-key ${pending.idempotencyKey}`);
    const draft = pending.draftId ? quoted(commandLine(["draft", "get"], [pending.appId, pending.draftId])) : check;
    return `To keep waiting, run ${again} again with the same input: it rejoins that validation instead of starting another. To see the draft's status, run ${draft}. A changed request starts afresh.`;
  }
  if (code === "DRAFT_VALIDATION_OUTCOME_UNKNOWN") {
    const draft = pending.draftId ? quoted(commandLine(["draft", "get"], [pending.appId, pending.draftId])) : check;
    return `The validation may still be running and was not repeated. Check with ${draft}; run the command again with a new --idempotency-key only if you still need it.`;
  }
  if (code.endsWith("_OUTCOME_UNKNOWN")) {
    return `It was not repeated. Check whether it took effect with ${check}. If it did not, run the command again with a new --idempotency-key.`;
  }
  return undefined;
}

export interface NotConnectedContext {
  /** Whether an account login is stored; null when that could not be read. */
  signedIn: boolean | null;
  /** The app ID the command was given, if any. */
  appId?: string | undefined;
  /** The directory argument the command was given, if any. */
  directory?: string | undefined;
}

/**
 * What an app command needs when no credential applies: the folder's app
 * connection, and a login only when there is none.
 */
export function notConnectedMessage(context: NotConnectedContext): string {
  const connect = `opencloud app connect ${context.appId && UUID.test(context.appId) ? context.appId.toLowerCase() : "<app-id>"}`;
  const folder = context.directory === undefined ? "this folder" : `the folder ${shellArgument(context.directory)}`;
  const Folder = folder.charAt(0).toUpperCase() + folder.slice(1);
  const where = context.directory === undefined ? "here" : "in that folder";
  if (context.signedIn === false) {
    return `You are not signed in, and ${folder} is not connected to an app. Run opencloud login, then ${connect} ${where}.`;
  }
  const elsewhere = context.directory === undefined ? ", or run this command in a folder connected to the app" : "";
  if (context.signedIn === true) {
    return `${Folder} is not connected to an app. You are signed in, so run ${connect} ${where}${elsewhere}.`;
  }
  return `${Folder} is not connected to an app. Run ${connect} ${where} (after opencloud login if you are not signed in)${elsewhere}.`;
}
