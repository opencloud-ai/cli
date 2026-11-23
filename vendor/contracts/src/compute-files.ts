import { z } from "zod";
import { computeIdSchema, computeIntegerSchema, computeSha256Schema, computeTimestampSchema } from "@opencloud/compute-protocol";
import { containerNameSchema } from "./containers.js";

const fileBytes = computeIntegerSchema.refine(value => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 10n * 1_073_741_824n, "File exceeds 10 GiB");
const safeText = z.string().min(1).max(255).refine(value => !/[\r\n\0]/.test(value));
/** Separate resumable interface; ordinary Files uploads retain their existing limit. */
export const computeInputUploadRequestSchema = z.object({
  workloadName: containerNameSchema, name: safeText, contentType: safeText,
  sizeBytes: fileBytes,
  sha256: computeSha256Schema, idempotencyKey: computeIdSchema,
}).strict();
export const computeUploadSessionSchema = z.object({
  uploadSessionId: computeIdSchema, fileId: computeIdSchema,
  path: z.string().min(1).max(1_024), sizeBytes: fileBytes, sha256: computeSha256Schema,
  offsetBytes: fileBytes, chunkBytes: z.number().int().min(1).max(8_388_608),
  state: z.enum(["uploading", "complete", "published", "aborted"]), expiresAt: computeTimestampSchema,
}).strict().superRefine((value, context) => {
  if ([value.offsetBytes, value.sizeBytes].every(bytes => /^(0|[1-9][0-9]*)$/.test(bytes)) && BigInt(value.offsetBytes) > BigInt(value.sizeBytes)) context.addIssue({ code: "custom", path: ["offsetBytes"], message: "Offset exceeds file length" });
});
/** Raw request bytes are streamed separately and must match both declared length and digest. */
export const computeUploadChunkHeadersSchema = z.object({
  "x-opencloud-upload-offset": fileBytes,
  "content-length": z.coerce.number().int().min(1).max(8_388_608),
  "x-opencloud-chunk-sha256": computeSha256Schema,
}).strict();
export const computeFileUploadOperations = {
  begin: { method: "POST", path: "/_opencloud/files/uploads", input: computeInputUploadRequestSchema, output: computeUploadSessionSchema },
  status: { method: "GET", path: "/_opencloud/files/uploads/{uploadSessionId}", output: computeUploadSessionSchema },
  chunk: { method: "PUT", path: "/_opencloud/files/uploads/{uploadSessionId}/chunks", headers: computeUploadChunkHeadersSchema, output: computeUploadSessionSchema },
  complete: { method: "POST", path: "/_opencloud/files/uploads/{uploadSessionId}/complete", output: computeUploadSessionSchema },
  abort: { method: "DELETE", path: "/_opencloud/files/uploads/{uploadSessionId}", output: computeUploadSessionSchema },
} as const;
export type ComputeInputUploadRequest = z.infer<typeof computeInputUploadRequestSchema>;
export type ComputeUploadSession = z.infer<typeof computeUploadSessionSchema>;
