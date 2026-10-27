/** Global options that take a value, which is never a command name. */
const VALUED_GLOBAL_OPTIONS = new Set([
  "--api-url",
  "--token",
  "--session-file",
  "--workspace-file",
]);

/**
 * Whether the arguments ask for the CLI version before naming a command, as
 * in `opencloud --version` or `opencloud -v`. Commander can't own --version:
 * after a command it belongs to that command, such as `init --version`.
 */
export function asksForVersion(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--version" || argument === "-v") return true;
    if (VALUED_GLOBAL_OPTIONS.has(argument)) index += 1;
    else if (!argument.startsWith("-")) return false;
  }
  return false;
}
