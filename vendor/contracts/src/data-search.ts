import { z } from "zod";

const identifier = z.string().max(63).regex(/^[a-z_][a-z0-9_]*$/);
const name = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const model = z.string().min(1).max(128).refine((value) => value.trim().length > 0, {
  message: "model must identify a nonempty embedding space",
});
const uniqueIdentifiers = (maximum: number) => z.array(identifier).max(maximum).refine(
  (values) => new Set(values).size === values.length,
  { message: "column names must be unique" },
);

export const dataSearchDeclarationSchema = z.object({
  name,
  table: identifier,
  select: uniqueIdentifiers(16).refine((values) => values.includes("id"), {
    message: "selected columns must include id",
  }),
  filterColumns: uniqueIdentifiers(8).default([]),
  fullText: z.object({
    column: identifier,
    language: z.enum(["english", "simple"]),
  }).strict().optional(),
  vector: z.object({
    column: identifier,
    dimensions: z.number().int().min(1).max(2000),
    metric: z.literal("cosine"),
    model,
  }).strict().optional(),
}).strict().refine((value) => value.fullText !== undefined || value.vector !== undefined, {
  message: "search requires fullText or vector configuration",
});

export const dataSearchDeclarationsSchema = z.array(dataSearchDeclarationSchema).max(16).refine(
  (values) => new Set(values.map((value) => value.name)).size === values.length,
  { message: "search names must be unique" },
);

const query = z.string().trim().min(1).max(2048);
const vector = z.array(z.number().finite().refine((value) => Number.isFinite(Math.fround(value)), {
  message: "vector entries must be finite float32 values",
})).min(1).max(2000).refine((values) => values.some((value) => Math.fround(value) !== 0), {
  message: "cosine vectors must have nonzero norm",
});
const requestFields = {
  where: z.record(identifier, z.union([z.string().max(2048), z.number().finite(), z.boolean(), z.null()]))
    .refine((value) => Object.keys(value).length <= 8, { message: "at most eight equality filters are allowed" })
    .default({}),
  limit: z.number().int().min(1).max(50).default(10),
};

/** Declaration-specific dimensions, model, modes and filter membership are checked by consumers. */
export const dataSearchRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("fullText"), query, ...requestFields }).strict(),
  z.object({ mode: z.literal("vector"), vector, model, ...requestFields }).strict(),
  z.object({ mode: z.literal("hybrid"), query, vector, model, ...requestFields }).strict(),
]);

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

const evidence = z.number().finite().nullable();
export const dataSearchHitSchema = z.object({
  record: z.record(identifier, z.json()).refine((value) => Object.hasOwn(value, "id"), {
    message: "search records must include id",
  }).refine((value) => Object.keys(value).length <= 16, {
    message: "search records may contain at most sixteen selected columns",
  }).refine((value) => jsonBytes(value) <= 16 * 1024, {
    message: "search record exceeds 16 KiB",
  }),
  fullTextScore: evidence,
  fullTextRank: z.number().int().min(1).max(100).nullable(),
  vectorDistance: evidence,
  vectorSimilarity: evidence,
  vectorRank: z.number().int().min(1).max(100).nullable(),
  fusionScore: evidence,
}).strict();

export const dataSearchResponseSchema = z.object({
  hits: z.array(dataSearchHitSchema).max(50),
}).strict().refine((value) => jsonBytes(value) <= 1024 * 1024, {
  message: "search response exceeds 1 MiB",
});

/** Complete runtime binding array, not an individual entry; absent on older deployments. */
export const dataSearchRuntimeBindingSchema = z.array(z.object({
  name,
  rpcName: z.string().regex(/^oc_search_[a-f0-9]{48}$/),
  declaration: dataSearchDeclarationSchema,
}).strict().refine((value) => value.name === value.declaration.name, {
  message: "runtime search name must match its declaration",
})).max(16).refine((values) => new Set(values.map((value) => value.name)).size === values.length, {
  message: "runtime search names must be unique",
}).default([]);

export type DataSearchDeclaration = z.infer<typeof dataSearchDeclarationSchema>;
export type DataSearchDeclarations = z.infer<typeof dataSearchDeclarationsSchema>;
export type DataSearchRequest = z.infer<typeof dataSearchRequestSchema>;
export type DataSearchHit = z.infer<typeof dataSearchHitSchema>;
export type DataSearchResponse = z.infer<typeof dataSearchResponseSchema>;
export type DataSearchRuntimeBinding = z.infer<typeof dataSearchRuntimeBindingSchema>;
