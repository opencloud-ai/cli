/**
 * Agent- and developer-facing Markdown (SKILL.md and the docs) is written once
 * for every installation. Text that applies to only some installations sits
 * between marker lines:
 *
 *     <!-- installation: personal -->
 *     Confirmed owners build in their own account.
 *     <!-- /installation -->
 *
 * `renderInstallationSections` keeps the blocks whose condition holds, drops
 * the others, and always removes the marker lines, so served text never
 * contains a marker. Blocks do not nest. `docs/site/.vitepress/installation-sections.mjs`
 * is the docs build's dependency-free copy; a test keeps the two identical.
 */
export interface InstallationTextFeatures {
  /** Organisation installation (`ORGANISATIONS_ENABLED`); otherwise personal accounts. */
  readonly organisations: boolean;
  /** The brand publishes the `opencloud-ai/agent-plugins` client plugin. */
  readonly clientPlugin: boolean;
}

/** The features the canonical OpenCloud sources describe. */
export const CANONICAL_INSTALLATION_FEATURES: InstallationTextFeatures =
  Object.freeze({ organisations: true, clientPlugin: true });

const CONDITIONS: Readonly<
  Record<string, (features: InstallationTextFeatures) => boolean>
> = Object.freeze({
  organisations: (features) => features.organisations,
  personal: (features) => !features.organisations,
  "client-plugin": (features) => features.clientPlugin,
  "no-client-plugin": (features) => !features.clientPlugin,
});

const START = /^[ \t]*<!-- installation: ([a-z-]+) -->[ \t]*$/;
const END = /^[ \t]*<!-- \/installation -->[ \t]*$/;

export function renderInstallationSections(
  source: string,
  features: InstallationTextFeatures,
): string {
  const lines = source.split(/(?<=\n)/);
  const output: string[] = [];
  let open: { condition: string; keep: boolean; line: number } | null = null;
  for (const [index, line] of lines.entries()) {
    const text = line.replace(/\r?\n$/, "");
    const start = START.exec(text);
    if (start) {
      const condition = start[1]!;
      const holds = Object.hasOwn(CONDITIONS, condition)
        ? CONDITIONS[condition]
        : undefined;
      if (!holds) {
        throw new Error(
          `Unknown installation section "${condition}" on line ${index + 1}`,
        );
      }
      if (open) {
        throw new Error(
          `Installation section on line ${index + 1} opens inside the section from line ${open.line}`,
        );
      }
      open = { condition, keep: holds(features), line: index + 1 };
      continue;
    }
    if (END.test(text)) {
      if (!open) {
        throw new Error(
          `Installation section end on line ${index + 1} has no opening marker`,
        );
      }
      open = null;
      continue;
    }
    if (!open || open.keep) output.push(line);
  }
  if (open) {
    throw new Error(
      `Installation section "${open.condition}" from line ${open.line} is never closed`,
    );
  }
  return output.join("");
}
