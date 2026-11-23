import { z } from "zod";

export const AGENT_PROTOCOL_VERSION = 1 as const;

const canonicalUuidSchema = z.uuid().transform((value) => value.toLowerCase());

export const userIdSchema = canonicalUuidSchema;
export const appIdSchema = canonicalUuidSchema;
export const threadIdSchema = canonicalUuidSchema;
export const runIdSchema = canonicalUuidSchema;
export const commandIdSchema = canonicalUuidSchema;
export const eventIdSchema = canonicalUuidSchema;
export const incidentIdSchema = canonicalUuidSchema;
export const usageEventIdSchema = canonicalUuidSchema;
export const leaseIdSchema = canonicalUuidSchema;
export const correlationIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const opaqueRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export const isoTimestampSchema = z.iso.datetime();

export const protocolEnvelopeSchema = z.object({
  protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
});
