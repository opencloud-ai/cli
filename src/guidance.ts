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
