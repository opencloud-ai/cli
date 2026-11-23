/**
 * Zod reports every problem as a nested JSON issue tree, which is hard to read
 * in a terminal. These helpers turn it into one short line per problem: where
 * it is (`containers[0].resources.cpu`) and what is expected there.
 */

export interface ReadableIssue {
  /** Where the problem is, such as `containers[0].resources.cpu`; empty at the top level. */
  path: string;
  /** What is expected there, such as `must be one of 1, 2, 4, 8`. */
  message: string;
}

interface Issue {
  code?: unknown;
  path?: unknown;
  message?: unknown;
  values?: unknown;
  options?: unknown;
  note?: unknown;
  errors?: unknown;
  keys?: unknown;
  expected?: unknown;
  origin?: unknown;
  maximum?: unknown;
  minimum?: unknown;
  inclusive?: unknown;
}

const MAX_SHOWN = 10;

/** A Zod validation error, by shape: bundled copies need not share a class. */
export function isZodError(error: unknown): error is Error & { issues: unknown[] } {
  return error instanceof Error && error.name === "ZodError" && Array.isArray((error as { issues?: unknown }).issues);
}

function segments(value: unknown): Array<string | number> {
  return Array.isArray(value)
    ? value.filter((part): part is string | number => typeof part === "string" || typeof part === "number")
    : [];
}

export function issuePath(parts: ReadonlyArray<string | number>): string {
  return parts.reduce<string>((text, part) => {
    if (typeof part === "number") return `${text}[${part}]`;
    if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(part)) return text ? `${text}.${part}` : part;
    return `${text}[${JSON.stringify(part)}]`;
  }, "");
}

function literal(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function oneOf(values: unknown[]): string {
  const unique = [...new Set(values.map(literal))];
  return unique.length === 1 ? `must be ${unique[0]}` : `must be one of ${unique.join(", ")}`;
}

function issues(value: unknown): Issue[] {
  return Array.isArray(value) ? value.filter((item): item is Issue => Boolean(item) && typeof item === "object") : [];
}

function missing(issue: Issue): boolean {
  return issue.code === "invalid_type" && typeof issue.message === "string" && issue.message.endsWith("received undefined");
}

function bound(issue: Issue, word: "most" | "least"): string {
  const limit = word === "most" ? issue.maximum : issue.minimum;
  const exclusive = issue.inclusive === false;
  const relation = exclusive ? (word === "most" ? "less than" : "more than") : `at ${word}`;
  if (issue.origin === "array" || issue.origin === "set") return `must have ${relation} ${String(limit)} item${limit === 1 ? "" : "s"}`;
  if (issue.origin === "string") return `must be ${relation} ${String(limit)} character${limit === 1 ? "" : "s"} long`;
  return `must be ${relation} ${String(limit)}`;
}

function plain(message: unknown): string {
  return String(message ?? "is invalid").replace(/^Invalid (?:input|option|string): /, "");
}

/** The readable problems one issue stands for; unions may expand to their closest form. */
function describe(issue: Issue, prefix: Array<string | number>): ReadableIssue[] {
  const parts = [...prefix, ...segments(issue.path)];
  const at = (message: string): ReadableIssue[] => [{ path: issuePath(parts), message }];
  switch (issue.code) {
    case "invalid_value":
      return at(Array.isArray(issue.values) && issue.values.length ? oneOf(issue.values) : plain(issue.message));
    case "invalid_type":
      if (missing(issue)) return at("is required");
      if (issue.expected === "int") return at("must be a whole number");
      return at(plain(issue.message));
    case "unrecognized_keys": {
      const keys = Array.isArray(issue.keys) ? issue.keys.map(literal) : [];
      return at(keys.length === 1 ? `has unknown key ${keys[0]}` : `has unknown keys ${keys.join(", ")}`);
    }
    case "too_big":
      return at(bound(issue, "most"));
    case "too_small":
      return at(bound(issue, "least"));
    case "invalid_union": {
      if (issue.note === "No matching discriminator" && Array.isArray(issue.options) && issue.options.length) {
        return at(oneOf(issue.options));
      }
      const branches = Array.isArray(issue.errors) ? issue.errors.map(issues) : [];
      if (!branches.length) return at(plain(issue.message));
      const single = branches.every((branch) => branch.length === 1 && segments(branch[0]!.path).length === 0);
      if (single && branches.every((branch) => branch[0]!.code === "invalid_value" && Array.isArray(branch[0]!.values))) {
        return at(oneOf(branches.flatMap((branch) => branch[0]!.values as unknown[])));
      }
      if (single && branches.every((branch) => missing(branch[0]!))) return at("is required");
      // Forms told apart only by the keys each requires, such as a route's
      // target: name them all rather than guess which one was meant.
      if (branches.every((branch) => branch.every((nested) => missing(nested) && segments(nested.path).length === 1))) {
        const forms = branches.map((branch) => branch.map((nested) => String(segments(nested.path)[0])).join(" and "));
        return at(`needs one of: ${forms.join("; ")}`);
      }
      // Otherwise the form that needs the fewest changes is most likely the one meant.
      const fewest = Math.min(...branches.map((branch) => branch.length));
      const closest = branches.filter((branch) => branch.length === fewest);
      if (closest.length === 1) return closest[0]!.flatMap((nested) => describe(nested, parts));
      return at("does not match any allowed form");
    }
    default:
      return at(plain(issue.message));
  }
}

/** One readable line per problem, in the order Zod found them. */
export function readableIssues(raw: unknown[]): ReadableIssue[] {
  return issues(raw).flatMap((issue) => describe(issue, []));
}

/** `subject has N problems: path: what is expected; …`, listing at most ten. */
export function issueSummary(subject: string, problems: ReadableIssue[]): string {
  const shown = problems.slice(0, MAX_SHOWN).map((problem) => `${problem.path || "top level"}: ${problem.message}`);
  const more = problems.length > MAX_SHOWN ? `; and ${problems.length - MAX_SHOWN} more` : "";
  return `${subject} has ${problems.length} problem${problems.length === 1 ? "" : "s"}: ${shown.join("; ")}${more}`;
}
