import { z } from "zod";

/**
 * Installation capability switches projected to clients. They describe
 * behaviour, never a brand. A missing value means the original installation
 * behaviour, so older servers and clients stay compatible.
 */
export const installationCapabilitiesSchema = z
  .object({
    /** Every builder belongs to an organisation, and accounts without one
     * create or join one before building. When false, accounts are personal
     * and nobody can create or join an organisation. */
    organisations: z.boolean().default(true),
    /** The installation itself funds AI for Agent work and app AI. */
    platformAi: z.boolean().default(false),
    /** App AI may use subscription sign-ins, not only provider API keys. */
    appAiSubscriptionConnections: z.boolean().default(true),
  })
  .strip();

export type InstallationCapabilities = z.infer<
  typeof installationCapabilitiesSchema
>;

export const installationViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    capabilities: installationCapabilitiesSchema,
  })
  .strip();

export type InstallationView = z.infer<typeof installationViewSchema>;
