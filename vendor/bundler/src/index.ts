import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseManifest,
  validateMigrationIdConvention,
  type OpenCloudManifest,
} from "@opencloud/contracts";
import { OPEN_CLOUD_SDK_VERSION } from "@opencloud/js";
import * as tar from "tar";
import YAML from "yaml";

interface AuthorManifest {
  schemaVersion?: number;
  appId?: string;
  version?: string;
  frontend?: {
    directory?: string;
    spa?: boolean;
    build?: { script?: string };
  };
  runtime?: {
    sdk?: {
      version?: string;
    };
  };
  files?: unknown;
  migrations?: Array<{
    id?: string;
    file?: string;
    sha256?: string;
  }>;
  functions?: unknown[];
  queues?: unknown[];
  cron?: unknown[];
  email?: unknown;
  health?: unknown;
  secrets?: Record<string, unknown>;
  integrations?: Record<string, unknown>;
}

export interface BuiltBundle {
  manifest: OpenCloudManifest;
  archive: Buffer;
  sha256: string;
  files: string[];
  sourceManifest: string;
  sourceFiles: string[];
  e2eTest?: BuiltE2eTest;
  warnings: BundleWarning[];
}

export interface BuiltE2eTest {
  path: typeof OPEN_CLOUD_E2E_TEST_PATH;
  source: string;
  sha256: string;
}

export interface BundleWarning {
  code:
    | "UNDECLARED_MIGRATION_FILE"
    | "UNDECLARED_FUNCTION_ENTRYPOINT"
    | "FRONTEND_SDK_NOT_REFERENCED"
    | "FRONTEND_BUILT_BY_PLATFORM";
  path: string;
  message: string;
}

export interface BundleOptions {
  /** Legacy schema-2 compatibility override. Schema 3 is publisher-versioned. */
  version?: string;
  /**
   * For a manifest with `frontend.build`, leave the frontend out: OpenCloud
   * builds it during validation, so a local bundle checks only the rest.
   */
  platformFrontend?: boolean;
}

interface BundleSelection {
  files: Map<string, string>;
  directories: Set<string>;
}

const manifestNames = [
  "opencloud.yaml",
  "opencloud.yml",
  "opencloud.json",
] as const;

export const OPEN_CLOUD_E2E_TEST_PATH = "tests/opencloud.e2e.js" as const;
export const OPEN_CLOUD_E2E_TEST_MAX_BYTES = 64 * 1024;

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isManifestName(value: string): boolean {
  return (manifestNames as readonly string[]).includes(value);
}

export async function buildBundle(
  directory: string,
  options: BundleOptions = {},
): Promise<BuiltBundle> {
  const root = path.resolve(directory);
  await assertDirectory(root, "App bundle root");
  const manifestFile = await findManifest(root);
  const sourceManifest = bundleRelativePath(root, manifestFile);
  const source = await readFile(manifestFile, "utf8");
  const raw = (
    manifestFile.endsWith(".json") ? JSON.parse(source) : YAML.parse(source)
  ) as AuthorManifest;
  raw.schemaVersion ??= (raw.version || options.version) ? 2 : 3;
  if (raw.schemaVersion === 3 && raw.version !== undefined) {
    throw new Error(
      "Manifest schema 3 removes the top-level version; OpenCloud assigns the release version during promotion",
    );
  }
  if (options.version) {
    if (raw.schemaVersion !== 2) {
      throw new Error(
        "A version override is supported only for legacy schema-2 manifests",
      );
    }
    raw.version = options.version;
  }
  raw.runtime ??= {};
  raw.runtime.sdk ??= {};
  raw.runtime.sdk.version ??= OPEN_CLOUD_SDK_VERSION;
  raw.migrations ??= [];
  for (const migration of raw.migrations) {
    if (!migration.file) throw new Error("Every migration needs a file");
    const migrationFile = resolveBundlePath(
      root,
      migration.file,
      "Migration file",
    );
    assertNotAuthorManifestInput(
      root,
      migrationFile,
      `Migration file ${migration.file}`,
    );
    await assertNoSymlinkComponents(
      root,
      migrationFile,
      `Migration file ${migration.file}`,
    );
    await assertFile(migrationFile, `Migration file ${migration.file}`);
    try {
      validateMigrationIdConvention(await readFile(migrationFile, "utf8"));
    } catch (error) {
      throw new Error(
        `Migration file ${migration.file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    migration.sha256 = await sha256File(migrationFile);
  }
  const manifest = parseManifest(raw);
  const staticFrontend = "directory" in manifest.frontend ? manifest.frontend : null;
  const platformFrontend =
    options.platformFrontend === true && staticFrontend?.build !== undefined;
  const selection = await selectBundleFiles(
    root,
    manifest,
    manifestFile,
    platformFrontend,
  );
  if (!platformFrontend) await validateAppRouteAssets(root, manifest);
  const e2eTest = await selectE2eTest(root, selection, manifestFile);
  if (e2eTest && staticFrontend) {
    assertE2eTestOutsideFrontend(staticFrontend.directory);
  }
  const functionWarnings = await inspectFunctionEntrypoints(
    manifest,
    selection,
  );
  await assertSelfContainedFunctions(manifest, selection);
  const warnings = [
    ...(await findUndeclaredConventionalFiles(root, manifest)),
    ...(platformFrontend && staticFrontend
      ? [
          {
            code: "FRONTEND_BUILT_BY_PLATFORM" as const,
            path: staticFrontend.directory,
            message: `OpenCloud builds ${staticFrontend.directory} with npm run ${staticFrontend.build!.script} during validation; this local bundle leaves it out.`,
          },
        ]
      : await findFrontendSdkWarnings(manifest, selection)),
    ...functionWarnings,
  ].sort((left, right) => comparePaths(left.path, right.path));
  const sourceFiles = [sourceManifest, ...selection.files.keys()].sort(
    comparePaths,
  );

  const temporary = await mkdtemp(path.join(os.tmpdir(), "opencloud-bundle-"));
  const staging = path.join(temporary, "root");
  const archiveFile = path.join(temporary, "bundle.tgz");
  try {
    await mkdir(staging);
    for (const directoryName of [...selection.directories].sort(comparePaths)) {
      const destination = path.join(staging, ...directoryName.split("/"));
      await mkdir(destination, { recursive: true });
      await chmod(destination, 0o755);
    }
    for (const [fileName, sourceFile] of [...selection.files].sort(([a], [b]) =>
      comparePaths(a, b),
    )) {
      const destination = path.join(staging, ...fileName.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(sourceFile, destination);
      await chmod(destination, 0o644);
    }
    await writeFile(
      path.join(staging, "opencloud.json"),
      serializeArchiveManifest(manifest),
      { flag: "wx", mode: 0o644 },
    );

    const files = ["opencloud.json", ...selection.files.keys()].sort(
      comparePaths,
    );
    const archiveEntries = [...selection.directories, ...files].sort(
      comparePaths,
    );
    await tar.create(
      {
        cwd: staging,
        file: archiveFile,
        gzip: true,
        portable: true,
        noMtime: true,
        noDirRecurse: true,
        strict: true,
      },
      archiveEntries,
    );
    const archive = await readFile(archiveFile);
    return {
      manifest,
      archive,
      sha256: createHash("sha256").update(archive).digest("hex"),
      files,
      sourceManifest,
      sourceFiles,
      ...(e2eTest ? { e2eTest } : {}),
      warnings,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function validateAppRouteAssets(
  root: string,
  manifest: OpenCloudManifest,
): Promise<void> {
  if (!("directory" in manifest.frontend)) return;
  const frontend = resolveBundlePath(
    root,
    manifest.frontend.directory,
    "Frontend directory",
  );
  for (const route of manifest.schemaVersion === 3 ? manifest.routes ?? [] : []) {
    if (!("asset" in route)) continue;
    const label = `Route ${route.id} asset ${route.asset}`;
    const target = resolveBundlePath(frontend, route.asset, label);
    assertNotLocalMetadataPath(root, target, label);
    assertNotAuthorManifestInput(root, target, label);
    await assertNoSymlinkComponents(root, target, label);
    await assertFile(target, label);
  }
}

function serializeArchiveManifest(manifest: OpenCloudManifest): string {
  const serialized: Record<string, unknown> = { ...manifest };
  // CLI v3.1.0 predates integrations. Preserve its canonical archive shape
  // for apps that do not declare any so server-side revalidation does not
  // change an otherwise identical bundle digest.
  if (Object.keys(manifest.integrations).length === 0) {
    delete serialized.integrations;
  }
  // Background queues were added after the original schema 2 archive shape.
  // Keep queue-free apps byte-compatible with older public CLI releases.
  if (manifest.queues.length === 0) {
    delete serialized.queues;
  }
  return `${JSON.stringify(serialized, null, 2)}\n`;
}

export function assertE2eTestOutsideFrontend(
  frontendDirectory: string,
): void {
  const relative = path.posix.relative(
    frontendDirectory,
    OPEN_CLOUD_E2E_TEST_PATH,
  );
  const overlaps =
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith("../") &&
      !path.posix.isAbsolute(relative));
  if (overlaps) {
    throw new Error(
      `${OPEN_CLOUD_E2E_TEST_PATH} must stay outside frontend.directory so verification source is never served publicly`,
    );
  }
}

async function selectE2eTest(
  root: string,
  selection: BundleSelection,
  manifestFile: string,
): Promise<BuiltE2eTest | undefined> {
  const absoluteFile = resolveBundlePath(
    root,
    OPEN_CLOUD_E2E_TEST_PATH,
    "OpenCloud E2E test",
  );
  let info;
  try {
    info = await lstat(absoluteFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  await assertNoSymlinkComponents(root, absoluteFile, "OpenCloud E2E test");
  if (info.isSymbolicLink()) {
    throw new Error("OpenCloud E2E test cannot be a symlink");
  }
  if (!info.isFile()) {
    throw new Error("OpenCloud E2E test is not a regular file");
  }
  if (info.size > OPEN_CLOUD_E2E_TEST_MAX_BYTES) {
    throw new Error(
      `OpenCloud E2E test exceeds ${OPEN_CLOUD_E2E_TEST_MAX_BYTES} bytes: ${OPEN_CLOUD_E2E_TEST_PATH}`,
    );
  }

  const bytes = await readFile(absoluteFile);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  validateE2eTestSource(source);
  addSelectedFile(root, absoluteFile, selection, manifestFile);
  return {
    path: OPEN_CLOUD_E2E_TEST_PATH,
    source,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function validateE2eTestSource(source: string): void {
  const { code, problem } = maskJavaScriptCommentsAndLiterals(source);
  const imports = [
    ...source.matchAll(
      /\bimport\s*\{([\s\S]*?)\}\s*from\s*(["'])([^"']+)\2\s*;?/g,
    ),
  ].filter((match) => {
    const index = match.index ?? -1;
    return index >= 0 && code.slice(index, index + 6) === "import";
  });
  const importTokenCount = code.match(/\bimport\b/g)?.length ?? 0;
  if (
    imports.length !== 1 ||
    importTokenCount !== 1 ||
    imports[0]?.[3] !== "@opencloud/test"
  ) {
    throw new Error(
      `OpenCloud E2E test must have exactly one named import from "@opencloud/test": ${OPEN_CLOUD_E2E_TEST_PATH}`,
    );
  }
  const importedNames = (imports[0]?.[1] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    importedNames.length !== 2 ||
    !importedNames.includes("test") ||
    !importedNames.includes("expect")
  ) {
    throw new Error(
      `OpenCloud E2E test must import exactly test and expect from "@opencloud/test": ${OPEN_CLOUD_E2E_TEST_PATH}`,
    );
  }
  if (!/\btest\s*\(/.test(code)) {
    throw new Error(
      `OpenCloud E2E test must declare at least one test(...): ${OPEN_CLOUD_E2E_TEST_PATH}`,
    );
  }
  if (
    /\b(?:test|describe)(?:\s*[.]\s*[A-Za-z_$][\w$]*)*\s*[.]\s*(?:skip|only)\s*\(/.test(
      code,
    )
  ) {
    throw new Error(
      `OpenCloud E2E test cannot use skip or only: ${OPEN_CLOUD_E2E_TEST_PATH}`,
    );
  }
  if (/\bimport\s*\(/.test(code)) {
    throw new Error(
      `OpenCloud E2E test cannot use dynamic imports: ${OPEN_CLOUD_E2E_TEST_PATH}`,
    );
  }

  // `$1` in a label names what matched.
  const forbiddenPatterns: Array<[RegExp, string]> = [
    [/\bfetch\s*\(/, "fetch"],
    [/\b(XMLHttpRequest|WebSocket|EventSource)\b/, "$1, a direct network API"],
    [/\bnavigator\s*[.]\s*sendBeacon\s*\(/, "sendBeacon"],
    [
      /[.]\s*(?:evaluate|evaluateAll|evaluateHandle|\$eval|\$\$eval)\s*\(/,
      "browser evaluation",
    ],
    [/[.]\s*(?:route|unroute|routeFromHAR)\s*\(/, "network routing"],
    [
      /[.]\s*(?:goto|setContent|addInitScript|addScriptTag|exposeBinding|exposeFunction)\s*\(/,
      "direct page or script injection",
    ],
    [
      /\brequest\s*[.]\s*(?:delete|fetch|get|head|patch|post|put)\s*\(/,
      "direct request access",
    ],
  ];
  for (const [pattern, label] of forbiddenPatterns) {
    const match = pattern.exec(code);
    if (match) {
      throw new Error(
        `OpenCloud E2E test cannot use ${label.replace("$1", match[1] ?? "")}; drive the app through the bounded @opencloud/test UI fixtures: ${OPEN_CLOUD_E2E_TEST_PATH}`,
      );
    }
  }
  // Checked after the named refusals, which stay the clearer message when
  // they match anyway.
  if (problem) {
    throw new Error(
      `OpenCloud E2E test cannot be checked: ${problem}: ${OPEN_CLOUD_E2E_TEST_PATH}`,
    );
  }
  if (/\/(?:rest|storage|functions)\/v1(?:\/|\b)/.test(source)) {
    throw new Error(
      `OpenCloud E2E test cannot access platform backend routes directly; drive the app through the bounded @opencloud/test UI fixtures: ${OPEN_CLOUD_E2E_TEST_PATH}`,
    );
  }
}

// How far a `for (...)` header has got: still expecting its binding or
// assignment target, just after one (so an `of` here is the for-of keyword),
// or past the point where an `of` keyword could come.
type ForHeadState = "target" | "afterTarget" | "done";

type LexerScope =
  | {
      kind: "paren";
      regexAfter: boolean;
      // Set only on a `for` statement's header.
      forHead: ForHeadState | null;
      ternaryDepth: number;
    }
  | { kind: "bracket"; ternaryDepth: number }
  | {
      kind: "brace";
      regexAfter: boolean;
      // An object literal, where `key:` is followed by a value; other braces
      // with `regexAfter: false` are function or class expression bodies,
      // where `label:` starts a statement.
      objectLiteral: boolean;
      ternaryDepth: number;
    }
  | { kind: "template"; ternaryDepth: number };

// Keywords after which a `/` starts a regular expression literal rather than division.
// The runner compiles an E2E test as a strict-mode function body, so `yield`
// is reserved. `await` is a keyword only inside async functions; the masker
// reads it as one and reports the uses it can't read either way.
const REGULAR_EXPRESSION_KEYWORDS = new Set([
  "await",
  "case",
  "default",
  "delete",
  "do",
  "else",
  "extends",
  "in",
  "instanceof",
  "new",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

// Keywords after which `{` opens an object literal rather than a statement block.
const EXPRESSION_BRACE_KEYWORDS = new Set([
  "await",
  "case",
  "default",
  "delete",
  "extends",
  "in",
  "instanceof",
  "new",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

// Statement-header keywords whose closing `)` can be followed directly by a
// statement (and therefore a regular expression literal).
const STATEMENT_HEADER_KEYWORDS = new Set(["if", "while", "for", "with"]);

// In a `for (...)` header, words after which the binding or target that an
// `of` keyword follows is still to come: `for (const of of items)` and
// `for (new Box().value of items)`.
const FOR_HEAD_TARGET_PREFIX_WORDS = new Set([
  "class",
  "const",
  "extends",
  "function",
  "let",
  "new",
  "var",
]);

// In a `for (...)` header, operator and statement words after which no `of`
// keyword can come, so a later `of` is a name: `for (k in of / 2)`.
const FOR_HEAD_ENDING_WORDS = new Set([
  "case",
  "default",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

// Words that can't continue an expression across a line break, so the next
// line starts a statement: after `async` a `function` there is a declaration,
// and after `return` or `yield` a `{` there opens a block.
const LINE_BREAK_ENDS_EXPRESSION_WORDS = new Set(["async", "return", "yield"]);

type MaskedJavaScript = {
  /**
   * The source with the text of comments and of string, template and regular
   * expression literals blanked, position for position. A template's `${...}`
   * stays code.
   */
  code: string;
  /** Why the masker can't vouch for `code`, if it can't. */
  problem: string | null;
};

// `await` is a keyword only inside async functions and a name elsewhere, and
// each reading takes what follows differently.
const AMBIGUOUS_AWAIT_PROBLEM =
  'a "/" straight after await, or a line ending in await followed by "{", function, class or async, reads two ways; don\'t name anything await, and keep what await waits for on its line';
// A quoted string can't contain a line break, so one that seems to means the
// test doesn't parse or the masker took something else for its opening quote.
const UNTERMINATED_STRING_PROBLEM = "a quoted string runs past the end of its line";

/**
 * Blanks comments and literal text so checks read only code. Reads a `/` as a
 * regular expression or a division from the tokens before it, the way the
 * JavaScript grammar does, so neither can hide code from the checks.
 */
function maskJavaScriptCommentsAndLiterals(source: string): MaskedJavaScript {
  let output = "";
  let index = 0;
  let state:
    | "code"
    | "line-comment"
    | "block-comment"
    | "single-quote"
    | "double-quote"
    | "template" = "code";
  const scopes: LexerScope[] = [];
  let topTernaryDepth = 0;
  let regexAllowed = true;
  let expectObjectBrace = false;
  let afterMemberAccess = false;
  // Straight after `=>`, where `function` and `class` start expressions.
  let afterArrow = false;
  let prevWord: string | null = null;
  let prevPrevWord: string | null = null;
  // Scope depths at which expression-position `function`s and `class`es await
  // their `{` bodies, innermost last: `function (a = function () {}) {}`.
  const pendingExpressionBodies: number[] = [];
  let awaitBeforeLineBreak = false;
  // No token yet on this line. The runner puts the test on a line of its own.
  let atLineStart = true;
  let problem: string | null = null;

  // A body that didn't open in its own scope never will (the code isn't what
  // the masker took it for), so it can't claim a later brace.
  const dropUnopenedBodies = (): void => {
    while ((pendingExpressionBodies.at(-1) ?? -1) > scopes.length) {
      pendingExpressionBodies.pop();
    }
  };
  const closedScope = (): void => {
    dropUnopenedBodies();
    // A group closing in a for header completes (part of) its target:
    // `for ([a, b] of pairs)`.
    const top = scopes.at(-1);
    if (top?.kind === "paren" && top.forHead !== null && top.forHead !== "done") {
      top.forHead = "afterTarget";
    }
  };
  const lineBreak = (): void => {
    atLineStart = true;
    if (prevWord !== null && LINE_BREAK_ENDS_EXPRESSION_WORDS.has(prevWord)) {
      expectObjectBrace = false;
      afterArrow = false;
    }
    if (prevWord === "await") awaitBeforeLineBreak = true;
  };

  const incrementTernary = (): void => {
    const top = scopes.at(-1);
    if (top) top.ternaryDepth += 1;
    else topTernaryDepth += 1;
  };
  const consumeTernary = (): boolean => {
    const top = scopes.at(-1);
    if (top) {
      if (top.ternaryDepth > 0) {
        top.ternaryDepth -= 1;
        return true;
      }
      return false;
    }
    if (topTernaryDepth > 0) {
      topTernaryDepth -= 1;
      return true;
    }
    return false;
  };

  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === "code") {
      if (/\s/.test(character)) {
        if (isLineTerminator(character)) lineBreak();
        output += character;
        index += 1;
        continue;
      }
      if (character === "/" && next === "/") {
        output += "  ";
        index += 2;
        state = "line-comment";
        continue;
      }
      if (character === "/" && next === "*") {
        output += "  ";
        index += 2;
        state = "block-comment";
        continue;
      }
      // Outside modules JavaScript also reads `<!--`, and `-->` that starts a
      // line, as the start of a line comment.
      const htmlComment = source.startsWith("<!--", index)
        ? 4
        : atLineStart && source.startsWith("-->", index)
          ? 3
          : 0;
      if (htmlComment) {
        output += " ".repeat(htmlComment);
        index += htmlComment;
        state = "line-comment";
        continue;
      }

      // A token starts here.
      atLineStart = false;
      const tokenFollowsArrow: boolean = afterArrow;
      afterArrow = false;
      const afterAwait = prevWord === "await";
      const awaitLineBreak = awaitBeforeLineBreak;
      awaitBeforeLineBreak = false;
      const top = scopes.at(-1);
      // In a for header, a token ends the stretch where an `of` keyword can
      // come unless it belongs to the binding or target; those set it back.
      const forHead =
        top?.kind === "paren" && top.forHead !== null ? top : undefined;
      const forHeadBefore = forHead?.forHead ?? "done";
      if (forHead) forHead.forHead = "done";
      const inForTarget = forHeadBefore !== "done";

      if (character === "/") {
        if (afterAwait) problem ??= AMBIGUOUS_AWAIT_PROBLEM;
        if (regexAllowed) {
          const end = regularExpressionLiteralEnd(source, index);
          if (end > index) {
            output += " ".repeat(end - index);
            index = end;
            if (forHead && inForTarget) forHead.forHead = "afterTarget";
            regexAllowed = false;
            expectObjectBrace = false;
            afterMemberAccess = false;
            prevWord = null;
            prevPrevWord = null;
            continue;
          }
        }
        if (next === "=") {
          output += "/=";
          index += 2;
        } else {
          output += "/";
          index += 1;
        }
        regexAllowed = true;
        expectObjectBrace = true;
        afterMemberAccess = false;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        // A literal can start a target: `for ("".length of items)`.
        if (forHead && inForTarget) forHead.forHead = "afterTarget";
        state =
          character === "'"
            ? "single-quote"
            : character === '"'
              ? "double-quote"
              : "template";
        output += " ";
        index += 1;
        continue;
      }
      if (character === "}") {
        if (top?.kind === "template") {
          scopes.pop();
          dropUnopenedBodies();
          output += " ";
          index += 1;
          state = "template";
          continue;
        }
        const popped = top?.kind === "brace" ? scopes.pop() : undefined;
        closedScope();
        output += "}";
        index += 1;
        regexAllowed = popped?.kind === "brace" ? popped.regexAfter : true;
        expectObjectBrace = false;
        afterMemberAccess = false;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      if (character === "{") {
        if (afterAwait && awaitLineBreak) problem ??= AMBIGUOUS_AWAIT_PROBLEM;
        if (forHead) forHead.forHead = forHeadBefore;
        // An expression-position `function` or `class` opens its body here,
        // unless this brace is an object literal in the class heritage:
        // `class extends {}.constructor {}`.
        const opensExpressionBody =
          !expectObjectBrace &&
          pendingExpressionBodies.at(-1) === scopes.length;
        if (opensExpressionBody) pendingExpressionBodies.pop();
        scopes.push({
          kind: "brace",
          regexAfter: !expectObjectBrace && !opensExpressionBody,
          objectLiteral: expectObjectBrace,
          ternaryDepth: 0,
        });
        output += "{";
        index += 1;
        regexAllowed = true;
        expectObjectBrace = false;
        afterMemberAccess = false;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      if (character === "(") {
        if (forHead) forHead.forHead = forHeadBefore;
        const isForHeader =
          prevWord === "for" || (prevWord === "await" && prevPrevWord === "for");
        const isStatementHeader =
          isForHeader ||
          (prevWord !== null && STATEMENT_HEADER_KEYWORDS.has(prevWord));
        scopes.push({
          kind: "paren",
          regexAfter: isStatementHeader,
          forHead: isForHeader ? "target" : null,
          ternaryDepth: 0,
        });
        output += "(";
        index += 1;
        regexAllowed = true;
        expectObjectBrace = true;
        afterMemberAccess = false;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      if (character === ")") {
        const popped = top?.kind === "paren" ? scopes.pop() : undefined;
        closedScope();
        output += ")";
        index += 1;
        regexAllowed = popped?.kind === "paren" ? popped.regexAfter : false;
        expectObjectBrace = false;
        afterMemberAccess = false;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      if (character === "[") {
        if (forHead) forHead.forHead = forHeadBefore;
        scopes.push({ kind: "bracket", ternaryDepth: 0 });
        output += "[";
        index += 1;
        regexAllowed = true;
        expectObjectBrace = true;
        afterMemberAccess = false;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      if (character === "]") {
        if (top?.kind === "bracket") scopes.pop();
        closedScope();
        output += "]";
        index += 1;
        regexAllowed = false;
        expectObjectBrace = false;
        afterMemberAccess = false;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      if (character === "=" && next === ">") {
        output += "=>";
        index += 2;
        regexAllowed = true;
        // A `{` here opens the arrow's body, but `function` and `class`
        // start an expression: `() => function () {} / 2`.
        expectObjectBrace = false;
        afterArrow = true;
        afterMemberAccess = false;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      if ((character === "+" || character === "-") && next === character) {
        output += character + next;
        index += 2;
        regexAllowed = false;
        expectObjectBrace = false;
        afterMemberAccess = false;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      // Before a digit, `?.` is a conditional and a number: `ok ?.5 : 1`.
      if (character === "?" && next === "." && !/[0-9]/.test(source[index + 2] ?? "")) {
        if (forHead && inForTarget) forHead.forHead = "target";
        output += "?.";
        index += 2;
        regexAllowed = false;
        expectObjectBrace = false;
        afterMemberAccess = true;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      if (character === "?" && next === "?") {
        output += "??";
        index += 2;
        regexAllowed = true;
        expectObjectBrace = true;
        afterMemberAccess = false;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      if (character === "?") {
        output += "?";
        index += 1;
        incrementTernary();
        regexAllowed = true;
        expectObjectBrace = true;
        afterMemberAccess = false;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      if (character === ":") {
        output += ":";
        index += 1;
        const inTernary = consumeTernary();
        const inObject = top?.kind === "brace" && top.objectLiteral;
        regexAllowed = true;
        expectObjectBrace = inTernary || inObject;
        afterMemberAccess = false;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      if (character === "." && next === "." && source[index + 2] === ".") {
        output += "...";
        index += 3;
        regexAllowed = true;
        expectObjectBrace = true;
        afterMemberAccess = false;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      // A number, including one that starts with its decimal point: `.5`.
      if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(next))) {
        let end = index + 1;
        while (end < source.length && /[0-9A-Za-z_]/.test(source[end] ?? "")) {
          end += 1;
        }
        if (forHead && inForTarget) forHead.forHead = "afterTarget";
        output += source.slice(index, end);
        index = end;
        regexAllowed = false;
        expectObjectBrace = false;
        afterMemberAccess = false;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      if (character === "." || character === "#") {
        if (forHead && inForTarget) forHead.forHead = "target";
        output += character;
        index += 1;
        regexAllowed = false;
        expectObjectBrace = false;
        afterMemberAccess = true;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      if (character === ";") {
        while (pendingExpressionBodies.at(-1) === scopes.length) {
          pendingExpressionBodies.pop();
        }
        output += ";";
        index += 1;
        regexAllowed = true;
        // In a for header an expression follows: `for (; {}.done; )`.
        expectObjectBrace = forHead !== undefined;
        afterMemberAccess = false;
        prevWord = null;
        prevPrevWord = null;
        continue;
      }
      if (/[A-Za-z_$\\]|[^\x00-\x7f]/.test(character)) {
        let end = index + 1;
        // Non-ASCII spaces and line terminators (U+00A0, U+2028) end a word.
        while (
          end < source.length &&
          /[A-Za-z0-9_$\\]|[^\x00-\x7f\s]/.test(source[end] ?? "")
        ) {
          end += 1;
        }
        const word = source.slice(index, end);
        output += word;
        index = end;
        const asciiWord = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(word);
        const keyword = !afterMemberAccess && asciiWord;
        // `of` is the for-of keyword only straight after the binding or
        // target; elsewhere in the header it can be a name: `for (i = of / 2;`.
        const isForOf =
          keyword && word === "of" && forHeadBefore === "afterTarget";
        if (forHead && inForTarget && !isForOf) {
          forHead.forHead = !keyword
            ? "afterTarget"
            : FOR_HEAD_ENDING_WORDS.has(word)
              ? "done"
              : FOR_HEAD_TARGET_PREFIX_WORDS.has(word)
                ? "target"
                : "afterTarget";
        }
        const startsDeclaration =
          keyword &&
          (word === "function" || word === "class" || word === "async");
        if (afterAwait && awaitLineBreak && startsDeclaration) {
          problem ??= AMBIGUOUS_AWAIT_PROBLEM;
        }
        if (
          keyword &&
          (word === "function" || word === "class") &&
          (expectObjectBrace || tokenFollowsArrow) &&
          prevWord !== "default"
        ) {
          pendingExpressionBodies.push(scopes.length);
        }
        regexAllowed =
          keyword && (REGULAR_EXPRESSION_KEYWORDS.has(word) || isForOf);
        if (keyword && word === "async") {
          // Preserve expression position across `async function() {}`.
          afterArrow = tokenFollowsArrow;
        } else {
          expectObjectBrace =
            keyword && (EXPRESSION_BRACE_KEYWORDS.has(word) || isForOf);
        }
        prevPrevWord = keyword ? prevWord : null;
        prevWord = keyword ? word : null;
        afterMemberAccess = false;
        continue;
      }
      output += character;
      index += 1;
      const isOperator = ",=!&|+-*%<>~^".includes(character);
      regexAllowed = isOperator;
      expectObjectBrace = isOperator;
      afterMemberAccess = false;
      prevWord = null;
      prevPrevWord = null;
      continue;
    }
    if (state === "line-comment") {
      if (isLineTerminator(character)) {
        lineBreak();
        output += "\n";
        state = "code";
      } else output += " ";
      index += 1;
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 2;
        state = "code";
      } else {
        if (isLineTerminator(character)) lineBreak();
        output += character === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    const terminator =
      state === "single-quote" ? "'" : state === "double-quote" ? '"' : "`";
    if (character === "\\") {
      output += " ";
      if (index + 1 < source.length) output += next === "\n" ? "\n" : " ";
      index += 2;
      // A line continuation may end with CR LF.
      if (next === "\r" && source[index] === "\n") {
        output += "\n";
        index += 1;
      }
      continue;
    }
    if (state !== "template" && (character === "\n" || character === "\r")) {
      // Read code again from the line break, so the checks still see the
      // lines after it.
      problem ??= UNTERMINATED_STRING_PROBLEM;
      state = "code";
      continue;
    }
    if (state === "template" && character === "$" && next === "{") {
      // `{` opens an expression, so a `/` straight after it starts a regular expression.
      output += " {";
      index += 2;
      scopes.push({ kind: "template", ternaryDepth: 0 });
      state = "code";
      regexAllowed = true;
      expectObjectBrace = true;
      afterMemberAccess = false;
      prevWord = null;
      prevPrevWord = null;
      continue;
    }
    output += character === "\n" ? "\n" : " ";
    index += 1;
    if (character === terminator) {
      state = "code";
      regexAllowed = false;
      expectObjectBrace = false;
      afterMemberAccess = false;
      prevWord = null;
      prevPrevWord = null;
    }
  }
  return { code: output, problem };
}

// A longer literal stays code, which keeps the scan linear in the source.
const MAX_REGULAR_EXPRESSION_LITERAL = 1_024;

/** JavaScript's line terminators, which a regular expression literal can't contain. */
function isLineTerminator(character: string): boolean {
  const code = character.charCodeAt(0);
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

/**
 * The index just after a one-line regular expression literal (including any
 * trailing flag letters) at `start`, or `start` if none closes within the line
 * and the length limit.
 */
function regularExpressionLiteralEnd(source: string, start: number): number {
  let inClass = false;
  const limit = Math.min(source.length, start + MAX_REGULAR_EXPRESSION_LITERAL);
  for (let index = start + 1; index < limit; index += 1) {
    const character = source[index] ?? "";
    if (isLineTerminator(character)) return start;
    if (character === "\\") {
      index += 1;
      if (index >= source.length || isLineTerminator(source[index] ?? "")) return start;
      continue;
    }
    if (inClass) {
      if (character === "]") inClass = false;
    } else if (character === "[") inClass = true;
    else if (character === "/") {
      let end = index + 1;
      while (end < source.length && /[A-Za-z]/.test(source[end] ?? "")) {
        end += 1;
      }
      return end;
    }
  }
  return start;
}

async function inspectFunctionEntrypoints(
  manifest: OpenCloudManifest,
  selection: BundleSelection,
): Promise<BundleWarning[]> {
  const warnings: BundleWarning[] = [];
  for (const definition of manifest.functions) {
    const sourceFile = selection.files.get(definition.entrypoint);
    if (!sourceFile) continue;
    const content = await readFile(sourceFile, "utf8");
    if (
      /\bDeno[.]env[.]get\s*\(\s*["'](?:SUPABASE_|OPEN_CLOUD_API_URL)/.test(
        content,
      ) ||
      /["'`]\/rest\/v1\//.test(content)
    ) {
      throw new Error(
        `Function entrypoint ${definition.entrypoint} uses unsupported direct platform backend access. Use defineFunction from @opencloud/server and its data, files, ai, email, jobs, job, integrations, secrets, log, requestId, and environment context instead of guessed SUPABASE_* or backend URL environment variables and direct /rest/v1 fetches.`,
      );
    }
    const usesServerBoundary =
      /\bfrom\s*["']@opencloud\/server["']/.test(content) &&
      /\bdefineFunction\s*\(/.test(content);
    if (!usesServerBoundary) {
      throw new Error(
        `Function entrypoint ${definition.entrypoint} uses the removed legacy Function boundary. Export default defineFunction({ input: schema.*, handler }) from @opencloud/server.`,
      );
    }
  }
  return warnings;
}

const FUNCTION_SOURCE_PATTERN = /[.](?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const RELATIVE_IMPORT_PATTERNS = [
  /\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g,
  /\bimport\s*["'](\.{1,2}\/[^"']+)["']/g,
  /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
];

/**
 * Each Function is deployed on its own with only its entrypoint's directory,
 * so a relative import must stay inside that directory and name an existing
 * file (the runtime resolves exact file names, including the extension).
 */
async function assertSelfContainedFunctions(
  manifest: OpenCloudManifest,
  selection: BundleSelection,
): Promise<void> {
  for (const definition of manifest.functions) {
    const directory = path.posix.dirname(definition.entrypoint);
    const sources = [...selection.files.entries()].filter(
      ([relative]) =>
        relative.startsWith(`${directory}/`) && FUNCTION_SOURCE_PATTERN.test(relative),
    );
    for (const [relative, sourceFile] of sources) {
      const content = (await readFile(sourceFile, "utf8"))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const pattern of RELATIVE_IMPORT_PATTERNS) {
        for (const [, specifier] of content.matchAll(pattern)) {
          const target = path.posix.normalize(
            path.posix.join(path.posix.dirname(relative), specifier!),
          );
          if (!target.startsWith(`${directory}/`)) {
            throw new Error(
              `Function ${definition.name} imports ${specifier} from ${relative}, which is outside its directory ${directory}/. Each Function is deployed on its own with only that directory, so keep helper modules inside it (copy a shared helper into each Function that uses it).`,
            );
          }
          if (!selection.files.has(target)) {
            throw new Error(
              `Function ${definition.name} imports ${specifier} from ${relative}, but ${target} does not exist. Import the exact file name, including its extension.`,
            );
          }
        }
      }
    }
  }
}

async function findFrontendSdkWarnings(
  manifest: OpenCloudManifest,
  selection: BundleSelection,
): Promise<BundleWarning[]> {
  if (!("directory" in manifest.frontend)) return [];
  const frontendPrefix = manifest.frontend.directory + "/";
  const candidates = [...selection.files.entries()].filter(
    ([relative]) =>
      relative.startsWith(frontendPrefix) &&
      /[.](?:html|js|mjs|cjs|ts|tsx|jsx)$/.test(relative),
  );
  let sdkReferenced = false;
  for (const [relative, sourceFile] of candidates) {
    const content = await readFile(sourceFile, "utf8");
    if (
      /\bcreateOpenCloudClient\b/.test(content) ||
      /\bjavascriptSdk[.]module\b/.test(content) ||
      /[.]\s*(?:rest|storage)\s*[.]\s*request\s*\(/.test(content) ||
      /fetch\s*\(\s*["'`]\/(?:rest|storage)\/v1(?:\/|["'`])/.test(content)
    ) {
      throw new Error(
        `Frontend source ${relative} uses a removed or raw OpenCloud interface. Import { opencloud } from "/_opencloud/sdk.js" and use opencloud.data, opencloud.files, opencloud.functions, and opencloud.realtime instead of client construction, raw REST or Storage requests, buckets, or object paths.`,
      );
    }
    if (
      content.includes("/_opencloud/sdk.js") &&
      /\bopencloud\b/.test(content)
    ) {
      sdkReferenced = true;
    }
  }
  if (sdkReferenced) return [];
  return [
    {
      code: "FRONTEND_SDK_NOT_REFERENCED",
      path: manifest.frontend.directory,
      message:
        'Frontend source does not import the deployment-pinned OpenCloud SDK. Import { opencloud } from "/_opencloud/sdk.js".',
    },
  ];
}
async function findUndeclaredConventionalFiles(
  root: string,
  manifest: OpenCloudManifest,
): Promise<BundleWarning[]> {
  const declaredMigrations = new Set(
    manifest.migrations.map((item) => item.file),
  );
  const declaredFunctions = new Set(
    manifest.functions.map((item) => item.entrypoint),
  );
  const warnings: BundleWarning[] = [];
  for (const relative of await conventionalFiles(root, "migrations")) {
    if (relative.endsWith(".sql") && !declaredMigrations.has(relative)) {
      warnings.push({
        code: "UNDECLARED_MIGRATION_FILE",
        path: relative,
        message: `${relative} exists but is not declared in opencloud.yaml migrations.`,
      });
    }
  }
  for (const relative of await conventionalFiles(root, "functions")) {
    if (
      /^functions\/[^/]+\/index\.(?:ts|js|mjs)$/.test(relative) &&
      !declaredFunctions.has(relative)
    ) {
      warnings.push({
        code: "UNDECLARED_FUNCTION_ENTRYPOINT",
        path: relative,
        message: `${relative} looks like a Function entrypoint but is not declared in opencloud.yaml functions.`,
      });
    }
  }
  return warnings.sort((left, right) => comparePaths(left.path, right.path));
}

async function conventionalFiles(
  root: string,
  directoryName: string,
): Promise<string[]> {
  const start = path.join(root, directoryName);
  try {
    const info = await lstat(start);
    if (!info.isDirectory() || info.isSymbolicLink()) return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await visit(target);
      else if (info.isFile()) output.push(bundleRelativePath(root, target));
    }
  };
  await visit(start);
  return output;
}

async function findManifest(root: string): Promise<string> {
  for (const name of manifestNames) {
    const candidate = path.join(root, name);
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) {
        throw new Error(`Author manifest cannot be a symlink: ${name}`);
      }
      if (info.isFile()) return candidate;
      throw new Error(`Author manifest is not a regular file: ${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("No opencloud.yaml, opencloud.yml, or opencloud.json found");
}

async function selectBundleFiles(
  root: string,
  manifest: OpenCloudManifest,
  manifestFile: string,
  platformFrontend = false,
): Promise<BundleSelection> {
  const selection: BundleSelection = {
    files: new Map(),
    directories: new Set(),
  };
  const addDirectoryTree = async (
    relativeDirectory: string,
    label: string,
  ): Promise<void> => {
    const absoluteDirectory = resolveBundlePath(root, relativeDirectory, label);
    assertNotLocalMetadataPath(root, absoluteDirectory, label);
    await assertNoSymlinkComponents(root, absoluteDirectory, label);
    await assertDirectory(absoluteDirectory, label);
    await walkDirectory(root, absoluteDirectory, selection, manifestFile);
  };

  if (!platformFrontend && "directory" in manifest.frontend) {
    await addDirectoryTree(
      manifest.frontend.directory,
      `Frontend directory ${manifest.frontend.directory}`,
    );
  }

  for (const migration of manifest.migrations) {
    const absoluteFile = resolveBundlePath(
      root,
      migration.file,
      `Migration file ${migration.file}`,
    );
    assertNotLocalMetadataPath(
      root,
      absoluteFile,
      `Migration file ${migration.file}`,
    );
    assertNotAuthorManifestInput(
      root,
      absoluteFile,
      `Migration file ${migration.file}`,
    );
    await assertNoSymlinkComponents(
      root,
      absoluteFile,
      `Migration file ${migration.file}`,
    );
    await assertFile(absoluteFile, `Migration file ${migration.file}`);
    addSelectedFile(root, absoluteFile, selection, manifestFile);
  }

  const functionDirectories = new Set(
    manifest.functions.map((definition) =>
      path.posix.dirname(definition.entrypoint),
    ),
  );
  for (const functionDirectory of [...functionDirectories].sort(comparePaths)) {
    await addDirectoryTree(
      functionDirectory,
      `Function source directory ${functionDirectory}`,
    );
  }
  for (const definition of manifest.functions) {
    const entrypoint = resolveBundlePath(
      root,
      definition.entrypoint,
      `Function entrypoint ${definition.entrypoint}`,
    );
    assertNotLocalMetadataPath(
      root,
      entrypoint,
      `Function entrypoint ${definition.entrypoint}`,
    );
    assertNotAuthorManifestInput(
      root,
      entrypoint,
      `Function entrypoint ${definition.entrypoint}`,
    );
    await assertNoSymlinkComponents(
      root,
      entrypoint,
      `Function entrypoint ${definition.entrypoint}`,
    );
    await assertFile(
      entrypoint,
      `Function entrypoint ${definition.entrypoint}`,
    );
  }

  return selection;
}

async function walkDirectory(
  root: string,
  directory: string,
  selection: BundleSelection,
  manifestFile: string,
): Promise<void> {
  // Draft transport is file-only. Parent directories are added by
  // addSelectedFile so empty directories cannot change the artifact digest.
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => comparePaths(a.name, b.name));
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const info = await lstat(target);
    const relative = bundleRelativePath(root, target);
    if (relative === ".opencloud" || relative.startsWith(".opencloud/")) {
      continue;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`App bundles cannot contain symlinks: ${relative}`);
    }
    if (info.isDirectory()) {
      await walkDirectory(root, target, selection, manifestFile);
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`App bundles only support regular files: ${relative}`);
    }
    addSelectedFile(root, target, selection, manifestFile);
  }
}

function assertNotLocalMetadataPath(
  root: string,
  target: string,
  label: string,
): void {
  const relative = bundleRelativePath(root, target);
  if (relative === ".opencloud" || relative.startsWith(".opencloud/")) {
    throw new Error(
      `${label} cannot use the reserved .opencloud metadata directory`,
    );
  }
}

function addSelectedFile(
  root: string,
  file: string,
  selection: BundleSelection,
  manifestFile: string,
): void {
  const relative = bundleRelativePath(root, file);
  if (
    file === manifestFile ||
    (path.posix.dirname(relative) === "." && isManifestName(relative))
  )
    return;
  selection.files.set(relative, file);
  addParentDirectories(relative, selection.directories);
}

function addParentDirectories(
  relativeFile: string,
  directories: Set<string>,
): void {
  let current = path.posix.dirname(relativeFile);
  while (current !== ".") {
    directories.add(current);
    current = path.posix.dirname(current);
  }
}

function resolveBundlePath(
  root: string,
  relative: string,
  label: string,
): string {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.posix.isAbsolute(relative) ||
    relative.includes("\\")
  ) {
    throw new Error(`${label} must be a relative path using forward slashes`);
  }
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "..")) {
    throw new Error(`${label} cannot escape the app bundle`);
  }
  const resolved = path.resolve(root, ...parts);
  const withinRoot = path.relative(root, resolved);
  if (
    withinRoot === ".." ||
    withinRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(withinRoot)
  ) {
    throw new Error(`${label} cannot escape the app bundle`);
  }
  return resolved;
}

function bundleRelativePath(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Selected path escapes the app bundle: ${target}`);
  }
  return relative.split(path.sep).join("/");
}

function assertNotAuthorManifestInput(
  root: string,
  target: string,
  label: string,
): void {
  const relative = bundleRelativePath(root, target);
  if (path.posix.dirname(relative) === "." && isManifestName(relative)) {
    throw new Error(`${label} conflicts with the canonical opencloud.json`);
  }
}

async function assertNoSymlinkComponents(
  root: string,
  target: string,
  label: string,
): Promise<void> {
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(
        `${label} cannot traverse a symlink: ${bundleRelativePath(root, current)}`,
      );
    }
  }
}

async function assertDirectory(target: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} does not exist`);
    }
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`${label} cannot be a symlink`);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory`);
}

async function assertFile(target: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} does not exist`);
    }
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`${label} cannot be a symlink`);
  if (!info.isFile()) throw new Error(`${label} is not a regular file`);
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
