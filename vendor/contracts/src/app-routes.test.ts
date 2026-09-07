import { describe, expect, it } from "vitest";
import {
  AppRouteError, appRouteSchema, appRoutesSchema, appRouteInvocationSchema,
  compileAppRoutes, matchAppRoute, parseAppRouteRequest,
} from "./app-routes.js";
import { parseManifest } from "./manifest.js";

const route = (path: string, id = "test") => appRouteSchema.parse({ id, path, function: "handler", methods: ["GET"] });
const resolve = (patterns: string[], uri: string, method = "GET") => matchAppRoute(
  compileAppRoutes(patterns.map((path, index) => route(path, `route-${index}`))),
  parseAppRouteRequest(uri, method),
);
const manifest = {
  schemaVersion: 3, appId: "11111111-1111-4111-8111-111111111111",
  frontend: { directory: "frontend" }, runtime: { sdk: { version: "2.3.0" } },
  functions: [{ name: "handler", entrypoint: "functions/handler/index.ts", access: "public" }],
};

describe("app route matching", () => {
  it.each([
    ["/reports/:year{/:month}", "/reports/2026", { year: "2026" }],
    ["/reports/:year{/:month}", "/reports/2026/09", { year: "2026", month: "09" }],
    ["/reports{/edit}/:year", "/reports/edit/2026", { year: "2026" }],
    ["/reports{/edit}/:year", "/reports/2026", { year: "2026" }],
    ["/files/*path", "/files/images/icons/logo.png", { path: ["images", "icons", "logo.png"] }],
    ["/pixel{.:ext}", "/pixel", {}],
    ["/pixel{.:ext}", "/pixel.jpg", { ext: "jpg" }],
    ["/:id{.:ext}", "/one.two.three", { id: "one.two", ext: "three" }],
    ["/:id{.:ext}", "/one", { id: "one" }],
    ["/café/:name", "/caf%C3%A9/%E2%9C%93", { name: "✓" }],
    ["/literal/:name", "/literal/%252F", { name: "%2F" }],
  ])("matches %s at %s", (pattern, uri, params) => {
    expect(resolve([pattern], uri)).toMatchObject({ kind: "matched", params });
  });

  it("normalizes literal and capture segments once, independently of query", () => {
    const request = parseAppRouteRequest("/users/%6Eew?tag=&tag=summer&value=a+b&bad=%FF&slash=%2F", "GET");
    expect(request.pathname).toBe("/users/%6Eew");
    expect(request.normalizedPathname).toBe("/users/new");
    expect(request.query).toEqual([["tag", ""], ["tag", "summer"], ["value", "a b"], ["bad", "�"], ["slash", "/"]]);
    expect(resolve(["/users/:id", "/users/new"], request.uri)).toMatchObject({ kind: "matched", route: { id: "route-1" }, params: {} });
    expect(resolve(["/users/%6Eew"], "/users/new")).toMatchObject({ kind: "matched" });
    expect(resolve(["/literal/%252F"], "/literal/%252F")).toMatchObject({ kind: "matched" });
  });

  it("gives specific routes precedence independently of declaration order", () => {
    for (const patterns of [["/:name", "/pixel{.:ext}", "/pixel.jpg"], ["/pixel.jpg", "/pixel{.:ext}", "/:name"]]) {
      expect(resolve(patterns, "/pixel.jpg")).toMatchObject({ kind: "matched", route: { path: "/pixel.jpg" } });
      expect(resolve(patterns, "/pixel.png")).toMatchObject({ kind: "matched", route: { path: "/pixel{.:ext}" } });
    }
    expect(resolve(["/users{/:id}", "/users"], "/users")).toMatchObject({ kind: "matched", route: { path: "/users" } });
    expect(resolve(["/files/*path", "/files/:name"], "/files/readme")).toMatchObject({ kind: "matched", route: { path: "/files/:name" } });
  });

  it("selects pathname before methods and does not implicitly add HEAD", () => {
    const table = compileAppRoutes([
      appRouteSchema.parse({ id: "generic", path: "/users/:id", function: "handler", methods: ["POST", "HEAD"] }),
      route("/users/new", "literal"),
    ]);
    expect(matchAppRoute(table, parseAppRouteRequest("/users/new", "POST"))).toMatchObject({ kind: "method-not-allowed", route: { id: "literal" }, allow: ["GET"] });
    expect(matchAppRoute(table, parseAppRouteRequest("/users/new", "HEAD"))).toMatchObject({ kind: "method-not-allowed" });
    expect(matchAppRoute(table, parseAppRouteRequest("/users/a", "HEAD"))).toMatchObject({ kind: "matched" });
  });

  it("preserves exact case and trailing slash; wildcards require nonempty segments", () => {
    expect(resolve(["/files/*path"], "/files")).toEqual({ kind: "none" });
    expect(resolve(["/files/*path"], "/files/a/")).toEqual({ kind: "none" });
    expect(resolve(["/users/:id"], "/users/a/")).toEqual({ kind: "none" });
    expect(resolve(["/users/:id/"], "/users/a/")).toMatchObject({ kind: "matched" });
    expect(resolve(["/Users/:id"], "/users/a")).toEqual({ kind: "none" });
  });

  it.each(["/_opencloud", "/_opencloud/sdk.js", "/auth/v1", "/rest/v1/items", "/functions/v1/handler", "/storage/v1/object", "/realtime/v1/socket", "/.well-known/acme-challenge/token", "/%5Fopencloud/sdk.js"])("keeps %s reserved before a catch-all", (uri) => {
    expect(resolve(["/*path"], uri)).toEqual({ kind: "reserved" });
  });

  it("freezes captured arrays, query pairs and request metadata", () => {
    const request = parseAppRouteRequest("/files/a/b?x=1", "GET");
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.query[0])).toBe(true);
    const result = resolve(["/files/*path"], request.uri);
    if (result.kind !== "matched") throw new Error("Expected match");
    expect(Object.isFrozen(result.params)).toBe(true);
    expect(Object.isFrozen(result.params.path)).toBe(true);
  });
});

describe("route validation", () => {
  it.each([
    "/", "/{:id}", "/users/:id?", "/files/*", "/x/:id(\\d+)", "/x/:id+",
    "/x{/:id{/:other}}", "/x{/*path}", "/x/*path/end", "/x/:id/:id", "/:constructor", "/:__proto__", "/:toString",
    "/x/:\"quoted\"", "/x{/edit}suffix", "/x{.:ext}/tail", "/user-:id", "/:a:b", "/:a.:b",
    "/x/..", "/x/%2e", "/x/%2f", "/x/%5c", "/x/%00", "/x/%FF", "/x/%", "/x//y", "//host/path",
    "/_opencloud/:name", "/%5Fopencloud/:name", "/auth/v1/*path", "/x{/:a}{/:b}{/:c}{/:d}{/:e}",
  ])("rejects unsupported or unsafe pattern %s", (path) => {
    expect(() => route(path)).toThrow();
  });

  it.each([
    ["/users/:id", "/users/:name"],
    ["/:x/edit", "/users/:y"],
    ["/x/:a{/:b}", "/x/:b{/:c}"],
    ["/users/new", "/users/%6Eew"],
    ["/x{/a}{/a}"],
    ["/x{/:a}{/:b}"],
  ])("rejects unresolved overlapping alternatives %j", (...patterns) => {
    expect(() => compileAppRoutes(patterns.map((path, index) => route(path, `r-${index}`)))).toThrow();
  });

  it("allows disjoint routes even with matching specificity", () => {
    expect(() => compileAppRoutes([route("/users/:id", "users"), route("/posts/:id", "posts")])).not.toThrow();
  });

  it("bounds route count, pattern size, parameters and IDs", () => {
    expect(() => appRoutesSchema.parse(Array.from({ length: 101 }, (_, index) => route(`/x/${index}`, `r-${index}`)))).toThrow();
    expect(() => route(`/${"x".repeat(512)}`)).toThrow();
    expect(() => route(Array.from({ length: 17 }, (_, index) => `/:p${index}`).join(""))).toThrow();
    expect(() => compileAppRoutes([route("/a"), route("/b")])).toThrow(/IDs must be unique/);
  });

  it("accepts only exact public static aliases and fixed GET/HEAD methods", () => {
    const asset = appRouteSchema.parse({ id: "icon", path: "/favicon.png", asset: "icons/app.png", access: "public" });
    expect(asset.methods).toEqual(["GET", "HEAD"]);
    expect(matchAppRoute(compileAppRoutes([asset]), parseAppRouteRequest("/favicon.png", "HEAD"))).toMatchObject({ kind: "matched" });
    for (const change of [
      { path: "/:icon" }, { path: "/favicon{.:ext}" }, { path: "/" }, { asset: "../outside" }, { asset: "/outside" },
      { asset: "https://example.test/icon" }, { asset: "icons/./app.png" }, { methods: ["GET", "POST"] },
      { function: "handler" },
    ]) expect(() => appRouteSchema.parse({ ...asset, ...change })).toThrow();
    expect(() => appRouteSchema.parse({ id: "fn", path: "/fn", function: "handler", access: "public", methods: ["GET"] })).toThrow();
  });

  it.each(["/x/%2F", "/x/%5C", "/x/%00", "/x/%1f", "/x/%7f", "/x/%FF", "/x/%", "/x/.", "/x/%2e%2e", "/x//y", "//attacker.test/x", "https://attacker.test/x", "/x#fragment"])("rejects invalid request %s", (uri) => {
    expect(() => parseAppRouteRequest(uri, "GET")).toThrow(AppRouteError);
  });

  it("uses UTF-8 byte bounds and limits query pairs without truncation", () => {
    expect(() => parseAppRouteRequest(`/${"a".repeat(4095)}`, "GET")).not.toThrow();
    expect(() => parseAppRouteRequest(`/${"é".repeat(2048)}`, "GET")).toThrow(/4096 UTF-8 bytes/);
    expect(parseAppRouteRequest(`/x?${Array(100).fill("x=1").join("&")}`, "GET").query).toHaveLength(100);
    expect(() => parseAppRouteRequest(`/x?${Array(101).fill("x=1").join("&")}`, "GET")).toThrow(/100 query pairs/);
  });
});

describe("route manifest compatibility", () => {
  it("adds optional routes only to schema 3 without changing absent fields", () => {
    expect(parseManifest(manifest)).not.toHaveProperty("routes");
    const legacy = { ...manifest, schemaVersion: 2, version: "1.0.0", runtime: { sdk: { version: "2.0.0" } } };
    expect(parseManifest(legacy)).not.toHaveProperty("routes");
    expect(() => parseManifest({ ...legacy, routes: [] })).toThrow();
    expect(() => parseManifest({ ...manifest, routes: [route("/pixels/:id")] })).not.toThrow();
  });

  it("gates Function routes on SDK 2.3 while static aliases support old SDKs", () => {
    for (const version of ["2.0.0", "2.1.0", "2.2.0"]) {
      const runtime = { sdk: { version } };
      expect(() => parseManifest({ ...manifest, runtime, routes: [route("/pixel")] })).toThrow(/2.3.0/);
      expect(() => parseManifest({ ...manifest, runtime, routes: [{ id: "icon", path: "/favicon.png", asset: "icon.png" }] })).not.toThrow();
    }
  });

  it("rejects undeclared/system Function targets with indexed issues", () => {
    for (const functions of [[], [{ ...manifest.functions[0], access: "system" }]]) {
      try {
        parseManifest({ ...manifest, functions, routes: [route("/pixel")] });
        throw new Error("Expected invalid route");
      } catch (error) {
        expect(error).toHaveProperty("issues", expect.arrayContaining([expect.objectContaining({ path: ["routes", 0, "function"] })]));
      }
    }
  });

  it("protects health paths regardless of method, retaining old direct Function health", () => {
    for (const path of ["/health?deep=1", "/h/../health", "/%68ealth"]) {
      expect(() => parseManifest({ ...manifest, health: { path }, routes: [{ ...route("/health"), methods: ["POST"] }] })).toThrow(/health path/);
    }
    expect(() => parseManifest({ ...manifest, health: { path: "/health" }, routes: [{ id: "health", path: "/health", asset: "ok.txt" }] })).not.toThrow();
    expect(() => parseManifest({ ...manifest, health: { path: "/functions/v1/health" }, routes: [route("/*path")] })).not.toThrow();
  });
});

describe("route invocation wire schema", () => {
  const intent = { v: 1, appId: manifest.appId, deploymentId: manifest.appId, devSessionId: null, environment: "production", routeId: "pixel", functionName: "handler", method: "GET", uri: "/pixel.jpg?id=a&id=b", issuedAt: 1_000, expiresAt: 31_000, requestId: "request-1" };
  it("validates deterministic wire values without owning wall-clock or signatures", () => {
    expect(appRouteInvocationSchema.parse(intent)).toEqual(intent);
    expect(appRouteInvocationSchema.parse({ ...intent, environment: "dev", devSessionId: manifest.appId })).toHaveProperty("devSessionId", manifest.appId);
  });
  it.each([
    { expiresAt: 31_001 }, { expiresAt: 1_000 }, { issuedAt: 0.1 }, { environment: "dev" },
    { devSessionId: manifest.appId }, { uri: "/x/%2F" }, { method: "OPTIONS" }, { requestId: "bad\nheader" },
    { params: { secret: "not permitted" } }, { appId: "not-a-uuid" },
  ])("rejects invalid intent %j", (change) => {
    expect(() => appRouteInvocationSchema.parse({ ...intent, ...change })).toThrow();
  });
});
