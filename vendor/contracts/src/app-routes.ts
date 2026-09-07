import { z } from "zod";
import { match, parse, TokenData, type Token, type MatchFunction } from "path-to-regexp";

export const APP_ROUTE_MAX_URI_BYTES = 4_096;
export const APP_ROUTE_MAX_QUERY_PAIRS = 100;
export const APP_ROUTE_RESERVED_PREFIXES = Object.freeze([
  "/_opencloud", "/auth/v1", "/rest/v1", "/realtime/v1", "/storage/v1",
  "/functions/v1", "/.well-known/acme-challenge",
]);
const routeIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const functionNameSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(63);
const methodSchema = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
export type AppRouteMethod = z.infer<typeof methodSchema>;
export type AppRouteParams = Readonly<Record<string, string | readonly string[]>>;

export class AppRouteError extends Error {
  constructor(
    readonly code: "INVALID_ROUTE" | "INVALID_ROUTE_REQUEST" | "ROUTE_URI_TOO_LARGE",
    message: string,
    readonly path: readonly (string | number)[] = [],
  ) {
    super(message.slice(0, 240));
    this.name = "AppRouteError";
  }
}

const assetPathSchema = z.string().min(1).max(240).refine((value) =>
  !value.startsWith("/") && !/[\\\u0000-\u001f\u007f]/.test(value) &&
  !value.includes(":") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
"asset must be a regular-file path relative to frontend.directory");
const routeFields = {
  id: routeIdSchema,
  path: z.string().min(1).max(512),
};
const structuralRouteSchema = z.union([
  z.object({
    ...routeFields,
    asset: assetPathSchema,
    access: z.enum(["inherit", "public"]).default("inherit"),
    methods: z.tuple([z.literal("GET"), z.literal("HEAD")]).default(["GET", "HEAD"]),
  }).strict(),
  z.object({
    ...routeFields,
    function: functionNameSchema,
    access: z.literal("inherit").default("inherit"),
    methods: z.array(methodSchema).min(1).max(6).refine(
      (methods) => new Set(methods).size === methods.length, "route methods must be unique",
    ),
  }).strict(),
]);
export type AppRoute = z.infer<typeof structuralRouteSchema>;

function addRouteIssue(context: z.RefinementCtx, error: unknown): void {
  if (!(error instanceof AppRouteError)) throw error;
  context.addIssue({ code: "custom", path: [...error.path], message: error.message });
}

export const appRouteSchema = structuralRouteSchema.superRefine((route, context) => {
  try { compileOne(route); } catch (error) { addRouteIssue(context, error); }
});
export const appRoutesSchema = z.array(appRouteSchema).max(100).superRefine((routes, context) => {
  try { compileValidatedRoutes(routes); } catch (error) { addRouteIssue(context, error); }
});

export interface AppRouteRequest {
  readonly method: string;
  readonly uri: string;
  readonly pathname: string;
  readonly normalizedPathname: string;
  readonly query: readonly (readonly [string, string])[];
}

function decodedPiece(value: string, code: "INVALID_ROUTE" | "INVALID_ROUTE_REQUEST"): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); }
  catch { throw new AppRouteError(code, "Path contains invalid UTF-8 or percent encoding"); }
  if (/[\/\\\u0000-\u001f\u007f]/.test(decoded)) {
    throw new AppRouteError(code, "Path contains an encoded separator or control character");
  }
  return decoded;
}

function normalizePathname(pathname: string): string {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) {
    throw new AppRouteError("INVALID_ROUTE_REQUEST", "Route URI must have a same-origin absolute pathname");
  }
  const parts = pathname.split("/");
  return parts.map((part, index) => {
    const decoded = decodedPiece(part, "INVALID_ROUTE_REQUEST");
    if (decoded === "." || decoded === ".." || (decoded === "" && index > 0 && index < parts.length - 1)) {
      throw new AppRouteError("INVALID_ROUTE_REQUEST", "Path contains a dot or empty segment");
    }
    return decoded;
  }).join("/");
}

export function parseAppRouteRequest(uri: string, method: string): AppRouteRequest {
  if (new TextEncoder().encode(uri).byteLength > APP_ROUTE_MAX_URI_BYTES) {
    throw new AppRouteError("ROUTE_URI_TOO_LARGE", "Route URI exceeds 4096 UTF-8 bytes");
  }
  if (/[\u0000-\u001f\u007f#]/.test(uri) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/.test(method)) {
    throw new AppRouteError("INVALID_ROUTE_REQUEST", "Route URI or HTTP method is invalid");
  }
  const question = uri.indexOf("?");
  const pathname = question < 0 ? uri : uri.slice(0, question);
  const normalizedPathname = normalizePathname(pathname);
  const query: (readonly [string, string])[] = [];
  for (const pair of new URLSearchParams(question < 0 ? "" : uri.slice(question + 1))) {
    if (query.length === APP_ROUTE_MAX_QUERY_PAIRS) {
      throw new AppRouteError("INVALID_ROUTE_REQUEST", "Route URI exceeds 100 query pairs");
    }
    query.push(Object.freeze(pair));
  }
  return Object.freeze({ method, uri, pathname, normalizedPathname, query: Object.freeze(query) });
}

type Piece = { type: "text"; value: string } | { type: "param" | "wildcard"; name: string; extension?: true };
type Segment =
  | { kind: "literal"; value: string }
  | { kind: "param"; name: string }
  | { kind: "extension"; stem: string | null; stemName: string | null; name: string }
  | { kind: "wildcard"; name: string };
interface Alternative {
  route: AppRoute;
  segments: readonly Segment[];
  matcher: MatchFunction<Record<string, string | string[]>>;
  optional: boolean;
}
const compiledBrand: unique symbol = Symbol("CompiledAppRoutes");
export interface CompiledAppRoutes {
  readonly [compiledBrand]: true;
  readonly alternatives: readonly Alternative[];
}

function routeFailure(message: string): never {
  throw new AppRouteError("INVALID_ROUTE", message, ["path"]);
}
const unsafeNames = new Set(Object.getOwnPropertyNames(Object.prototype));

function patternAlternatives(pattern: string): { pieces: Piece[]; optional: boolean }[] {
  if (!pattern.startsWith("/") || pattern.startsWith("//") || /[\\?#\u0000-\u001f\u007f]/.test(pattern) || pattern.includes(':"')) {
    routeFailure("Route pattern must use the supported absolute-path syntax");
  }
  let tokens: Token[];
  try { tokens = parse(pattern).tokens; }
  catch { routeFailure("Route pattern contains unsupported or malformed syntax"); }
  let groups = 0;
  let parameters = 0;
  let wildcards = 0;
  const names = new Set<string>();
  const inspect = (token: Token): void => {
    if (token.type === "group") routeFailure("Nested optional route groups are unsupported");
    if (token.type === "text") return;
    parameters++;
    if (token.type === "wildcard") wildcards++;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(token.name) || unsafeNames.has(token.name) || names.has(token.name)) {
      routeFailure("Route parameter names must be unique safe identifiers");
    }
    names.add(token.name);
  };
  let alternatives: { pieces: Piece[]; optional: boolean }[] = [{ pieces: [], optional: false }];
  for (const [index, token] of tokens.entries()) {
    if (token.type !== "group") {
      inspect(token);
      alternatives = alternatives.map((alternative) => ({ ...alternative, pieces: [...alternative.pieces, token] }));
      continue;
    }
    groups++;
    if (groups > 4) routeFailure("Routes may contain at most four optional groups");
    for (const child of token.tokens) inspect(child);
    const [first, second] = token.tokens;
    const extension = token.tokens.length === 2 && first?.type === "text" && first.value === "." && second?.type === "param";
    const parameter = token.tokens.length === 2 && first?.type === "text" && first.value === "/" && second?.type === "param";
    const literal = token.tokens.length === 1 && first?.type === "text" && /^\/[^/]+$/.test(first.value);
    const next = tokens[index + 1];
    if ((!extension && !parameter && !literal) || (extension && index !== tokens.length - 1) ||
      (!extension && next?.type === "text" && !next.value.startsWith("/"))) {
      routeFailure("Optional groups must be one whole segment or a final extension");
    }
    const pieces = token.tokens.map((child) => {
      if (child.type === "group") return routeFailure("Nested optional route groups are unsupported");
      return extension && child.type === "param" ? { ...child, extension: true as const } : child;
    });
    alternatives = alternatives.flatMap((alternative) => [
      { pieces: [...alternative.pieces, ...pieces], optional: true },
      { ...alternative, optional: true },
    ]);
  }
  if (parameters > 16 || wildcards > 1) routeFailure("Routes allow at most 16 parameters and one wildcard");
  return alternatives;
}

function segmentsFor(pieces: Piece[]): Segment[] {
  const groups: Piece[][] = [[]];
  for (const piece of pieces) {
    if (piece.type !== "text") { groups[groups.length - 1]!.push(piece); continue; }
    for (const [index, text] of piece.value.split("/").entries()) {
      if (index) groups.push([]);
      if (text) {
        const value = decodedPiece(text, "INVALID_ROUTE");
        const current = groups[groups.length - 1]!;
        const previous = current.at(-1);
        if (previous?.type === "text") previous.value += value;
        else current.push({ type: "text", value });
      }
    }
  }
  groups.shift(); // Leading slash is structural, never a parameter segment.
  return groups.map((group, index): Segment => {
    const [first, second, third] = group;
    if (!first || (group.length === 1 && first.type === "text")) {
      const value = first?.type === "text" ? first.value : "";
      if (value === "." || value === ".." || (value === "" && index !== groups.length - 1)) routeFailure("Route pattern contains a dot or empty segment");
      return { kind: "literal", value };
    }
    if (group.length === 1 && first.type === "param" && !first.extension) return { kind: "param", name: first.name };
    if (group.length === 1 && first.type === "wildcard" && index === groups.length - 1) return { kind: "wildcard", name: first.name };
    if (group.length === 2 && first.type === "text" && first.value.endsWith(".") && second?.type === "param" && second.extension && first.value.length > 1) {
      return { kind: "extension", stem: first.value.slice(0, -1), stemName: null, name: second.name };
    }
    if (group.length === 3 && first.type === "param" && second?.type === "text" && second.value === "." && third?.type === "param" && third.extension) {
      return { kind: "extension", stem: null, stemName: first.name, name: third.name };
    }
    return routeFailure("Parameters occupy whole segments; only a final optional extension may mix literal and parameter text");
  });
}

function segmentTokens(segments: readonly Segment[]): Token[] {
  const tokens: Token[] = [];
  for (const segment of segments) {
    tokens.push({ type: "text", value: "/" });
    if (segment.kind === "literal") tokens.push({ type: "text", value: segment.value });
    else if (segment.kind === "extension") {
      if (segment.stem !== null) tokens.push({ type: "text", value: `${segment.stem}.` });
      else tokens.push({ type: "param", name: segment.stemName! }, { type: "text", value: "." });
      tokens.push({ type: "param", name: segment.name });
    } else tokens.push({ type: segment.kind, name: segment.name });
  }
  return tokens;
}

function reserved(pathname: string): boolean {
  return APP_ROUTE_RESERVED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function compileOne(route: AppRoute): Alternative[] {
  const parsed = patternAlternatives(route.path);
  if (route.access === "public" && (parsed.length !== 1 || parsed[0]!.pieces.some((piece) => piece.type !== "text"))) {
    throw new AppRouteError("INVALID_ROUTE", "Public access requires an exact literal static route", ["access"]);
  }
  return parsed.map(({ pieces, optional }) => {
    const segments = segmentsFor(pieces);
    if (segments.length === 1 && segments[0]?.kind === "literal" && segments[0].value === "") routeFailure("Routes must not match the canonical root document");
    let prefix = "";
    for (const segment of segments) {
      if (segment.kind !== "literal") break;
      prefix += `/${segment.value}`;
      if (reserved(prefix)) routeFailure("Route pattern explicitly targets a reserved platform namespace");
    }
    const matcher = match<Record<string, string | string[]>>(new TokenData(segmentTokens(segments)), {
      sensitive: true, trailing: false, end: true, decode: (value) => value,
    });
    return { route, segments, matcher, optional };
  });
}

function literalFits(value: string, segment: Segment): boolean {
  if (segment.kind === "literal") return value === segment.value;
  if (!value) return false;
  if (segment.kind !== "extension") return true;
  return segment.stem === null ? value.lastIndexOf(".") > 0 && !value.endsWith(".")
    : value.startsWith(`${segment.stem}.`) && value.length > segment.stem.length + 1;
}

// null means disjoint languages; zero means equal specificity. Ordering is a
// partial order across segments: crossed specificity is rejected, never settled
// by declaration order or by the length of unrelated literal segments.
function compareSegments(left: Segment, right: Segment): number | null {
  if (left.kind === "literal") return literalFits(left.value, right) ? (right.kind === "literal" ? 0 : 1) : null;
  if (right.kind === "literal") return literalFits(right.value, left) ? -1 : null;
  if (left.kind === "extension" && right.kind === "extension") {
    if (left.stem === null || right.stem === null) return left.stem === right.stem ? 0 : left.stem === null ? -1 : 1;
    const lp = `${left.stem}.`, rp = `${right.stem}.`;
    return lp === rp ? 0 : lp.startsWith(rp) ? 1 : rp.startsWith(lp) ? -1 : null;
  }
  const ranks = { extension: 3, param: 2, wildcard: 1 };
  return Math.sign(ranks[left.kind] - ranks[right.kind]);
}

function overlapOrder(left: Alternative, right: Alternative): "disjoint" | "ambiguous" | number {
  const l = left.segments, r = right.segments;
  const lw = l.at(-1)?.kind === "wildcard", rw = r.at(-1)?.kind === "wildcard";
  if ((!lw && !rw && l.length !== r.length) || (!lw && l.length < r.length) || (!rw && r.length < l.length)) return "disjoint";
  let greater = false, less = false;
  for (let index = 0; index < Math.max(l.length, r.length); index++) {
    const comparison = compareSegments(l[index] ?? l.at(-1)!, r[index] ?? r.at(-1)!);
    if (comparison === null) return "disjoint";
    greater ||= comparison > 0;
    less ||= comparison < 0;
  }
  if (greater && less) return "ambiguous";
  if (greater) return 1;
  if (less) return -1;
  return left.optional === right.optional ? 0 : left.optional ? -1 : 1;
}

function compileValidatedRoutes(routes: readonly AppRoute[]): CompiledAppRoutes {
  const alternatives: Alternative[] = [];
  const ids = new Set<string>();
  routes.forEach((route, index) => {
    Object.freeze(route.methods);
    Object.freeze(route);
    if (ids.has(route.id)) throw new AppRouteError("INVALID_ROUTE", "Route IDs must be unique", [index, "id"]);
    ids.add(route.id);
    let additions: Alternative[];
    try { additions = compileOne(route); }
    catch (error) {
      if (!(error instanceof AppRouteError)) throw error;
      throw new AppRouteError(error.code, error.message, [index, ...error.path]);
    }
    for (const addition of additions) {
      for (const existing of alternatives) {
        const order = overlapOrder(addition, existing);
        if (order === 0 || order === "ambiguous") {
          throw new AppRouteError("INVALID_ROUTE", "Route patterns have equivalent or unresolved overlapping alternatives", [index, "path"]);
        }
      }
      for (const segment of addition.segments) Object.freeze(segment);
      Object.freeze(addition.segments);
      alternatives.push(Object.freeze(addition));
    }
  });
  return Object.freeze({ [compiledBrand]: true as const, alternatives: Object.freeze(alternatives) });
}

export function compileAppRoutes(routes: readonly AppRoute[]): CompiledAppRoutes {
  const parsed = z.array(structuralRouteSchema).max(100).safeParse(routes);
  if (!parsed.success) {
    throw new AppRouteError("INVALID_ROUTE", "Invalid route definition", parsed.error.issues[0]?.path.filter((part): part is string | number => typeof part !== "symbol") ?? []);
  }
  return compileValidatedRoutes(parsed.data);
}

export type AppRouteMatch =
  | { kind: "none" }
  | { kind: "reserved" }
  | { kind: "method-not-allowed"; route: AppRoute; allow: readonly AppRouteMethod[] }
  | { kind: "matched"; route: AppRoute; params: AppRouteParams };

export function matchAppRoute(table: CompiledAppRoutes, request: AppRouteRequest): AppRouteMatch {
  if (reserved(request.normalizedPathname)) return { kind: "reserved" };
  let best: { alternative: Alternative; params: AppRouteParams } | undefined;
  for (const alternative of table.alternatives) {
    const result = alternative.matcher(request.normalizedPathname);
    if (!result || Object.values(result.params).some((value) => Array.isArray(value) && value.some((part) => !part))) continue;
    if (best && overlapOrder(alternative, best.alternative) !== 1) continue;
    const params: Record<string, string | readonly string[]> = Object.create(null);
    for (const [name, value] of Object.entries(result.params)) {
      if (value !== undefined) params[name] = Array.isArray(value) ? Object.freeze([...value]) : value;
    }
    best = { alternative, params: Object.freeze(params) };
  }
  if (!best) return { kind: "none" };
  const route = best.alternative.route;
  if (!route.methods.some((method) => method === request.method)) return { kind: "method-not-allowed", route, allow: Object.freeze([...route.methods]) };
  return { kind: "matched", route, params: best.params };
}

export const appRouteInvocationSchema = z.object({
  v: z.literal(1),
  appId: z.uuid(),
  deploymentId: z.uuid(),
  devSessionId: z.uuid().nullable(),
  environment: z.enum(["production", "dev"]),
  routeId: routeIdSchema,
  functionName: functionNameSchema,
  method: methodSchema,
  uri: z.string().min(1).max(APP_ROUTE_MAX_URI_BYTES),
  issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
}).strict().superRefine((intent, context) => {
  if ((intent.environment === "dev") !== (intent.devSessionId !== null)) context.addIssue({ code: "custom", path: ["devSessionId"], message: "Development route intents require a session; production intents require null" });
  if (intent.expiresAt <= intent.issuedAt || intent.expiresAt - intent.issuedAt > 30_000) context.addIssue({ code: "custom", path: ["expiresAt"], message: "Route intent lifetime must be positive and at most 30 seconds" });
  try { parseAppRouteRequest(intent.uri, intent.method); }
  catch (error) {
    if (!(error instanceof AppRouteError)) throw error;
    context.addIssue({ code: "custom", path: ["uri"], message: error.message });
  }
});
export type AppRouteInvocation = z.infer<typeof appRouteInvocationSchema>;
