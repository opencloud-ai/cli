import { describe, expect, it } from "vitest";
import { dataSearchDeclarationSchema, dataSearchDeclarationsSchema, dataSearchRequestSchema,
  dataSearchHitSchema, dataSearchResponseSchema, dataSearchRuntimeBindingSchema } from "./data-search.js";

const declaration = {
  name: "document-chunks", table: "document_chunks", select: ["id", "content"],
  fullText: { column: "search_text", language: "english" },
  vector: { column: "embedding", dimensions: 128, metric: "cosine", model: "potion" },
};
const hit = {
  record: { id: "chunk-1", content: "Some evidence" },
  fullTextScore: 0.5, fullTextRank: 1, vectorDistance: 0.25,
  vectorSimilarity: 0.75, vectorRank: 2, fusionScore: 1 / 61 + 1 / 62,
};

describe("data search declarations", () => {
  it("accepts bounded lexical/vector declarations with default filters", () => {
    expect(dataSearchDeclarationSchema.parse(declaration).filterColumns).toEqual([]);
    expect(dataSearchDeclarationSchema.parse({ ...declaration, vector: undefined }).fullText).toEqual(declaration.fullText);
    expect(dataSearchDeclarationsSchema.parse([])).toEqual([]);
  });
  it.each([
    { ...declaration, name: "Unsafe Name" },
    { ...declaration, table: "other.table" },
    { ...declaration, table: "a".repeat(64) },
    { ...declaration, select: ["content"] },
    { ...declaration, select: ["id", "id"] },
    { ...declaration, select: ["id", ...Array.from({ length: 16 }, (_, i) => `field_${i}`)] },
    { ...declaration, filterColumns: Array.from({ length: 9 }, (_, i) => `field_${i}`) },
    { ...declaration, fullText: undefined, vector: undefined },
    { ...declaration, fullText: { column: "search_text", language: "invented" } },
    { ...declaration, vector: { ...declaration.vector, dimensions: 2001 } },
    { ...declaration, vector: { ...declaration.vector, model: " " } },
    { ...declaration, vector: { ...declaration.vector, metric: "l2" } },
    { ...declaration, sql: "select *" },
  ])("rejects invalid declaration %#", (value) => {
    expect(dataSearchDeclarationSchema.safeParse(value).success).toBe(false);
  });
  it("rejects duplicate and excessive declaration names", () => {
    expect(dataSearchDeclarationsSchema.safeParse([declaration, declaration]).success).toBe(false);
    expect(dataSearchDeclarationsSchema.safeParse(Array.from({ length: 17 }, (_, i) => ({ ...declaration, name: `index-${i}` }))).success).toBe(false);
  });
});

describe("data search request", () => {
  it("normalizes query/defaults without changing model identity or null equality", () => {
    expect(dataSearchRequestSchema.parse({ mode: "fullText", query: "  terms  " })).toEqual({ mode: "fullText", query: "terms", where: {}, limit: 10 });
    expect(dataSearchRequestSchema.parse({ mode: "hybrid", query: "terms", vector: [0.1, 0], model: "Model:v1", where: { parent_id: null } })).toMatchObject({ model: "Model:v1", where: { parent_id: null } });
  });
  it.each([
    { mode: "fullText", query: " " }, { mode: "fullText", query: "x".repeat(2049) },
    { mode: "fullText", query: "terms", vector: [1] },
    { mode: "vector", vector: [1], model: "m", query: "terms" },
    { mode: "hybrid", vector: [1], model: "m" },
    { mode: "vector", vector: [1] },
    ...[[], [0, 0], [1e-50], [Infinity], [NaN], [1e100], Array(2001).fill(1)].map((vector) => ({ mode: "vector", vector, model: "m" })),
    ...[0, 51, 1.5].map((limit) => ({ mode: "fullText", query: "terms", limit })),
    { mode: "fullText", query: "terms", where: { id: { gt: 1 } } },
    { mode: "fullText", query: "terms", where: { id: Infinity } },
    { mode: "fullText", query: "terms", where: { "id;drop": "x" } },
    { mode: "fullText", query: "terms", where: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`field_${i}`, i])) },
  ])("rejects unsupported or unbounded request %#", (value) => {
    expect(dataSearchRequestSchema.safeParse(value).success).toBe(false);
  });
});

describe("data search results and bindings", () => {
  it("accepts evidence and null missing components", () => {
    expect(dataSearchResponseSchema.parse({ hits: [hit] })).toEqual({ hits: [hit] });
    expect(dataSearchHitSchema.parse({ ...hit, fullTextScore: null, fullTextRank: null })).toMatchObject({ fullTextRank: null });
  });
  it("rejects invalid evidence and excessive UTF-8 output", () => {
    for (const value of [
      { ...hit, vectorDistance: Infinity }, { ...hit, vectorRank: 0 },
      { ...hit, record: { content: "missing id" } },
      { ...hit, record: { id: "large", content: "文".repeat(5500) } },
      { ...hit, extra: true },
    ]) expect(dataSearchHitSchema.safeParse(value).success).toBe(false);
    expect(dataSearchResponseSchema.safeParse({ hits: Array(51).fill(hit) }).success).toBe(false);
  });
  it("defaults old runtime configurations and rejects forged mapping structure", () => {
    expect(dataSearchRuntimeBindingSchema.parse(undefined)).toEqual([]);
    const binding = { name: declaration.name, rpcName: `oc_search_${"a".repeat(48)}`, declaration };
    expect(dataSearchRuntimeBindingSchema.parse([binding])).toHaveLength(1);
    for (const value of [[{ ...binding, rpcName: "rpc/arbitrary" }], [{ ...binding, name: "mismatch" }], [binding, binding]]) {
      expect(dataSearchRuntimeBindingSchema.safeParse(value).success).toBe(false);
    }
  });
});
