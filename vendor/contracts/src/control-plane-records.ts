import { z } from "zod";
import {
  appAiCredentialSourceSchema,
  appStateSchema,
  appVisibilitySchema,
  deploymentStateSchema,
  operationStateSchema,
} from "./api-core.js";

const uuid = z.uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const jsonObject = z.record(z.string(), z.unknown());

/** Shared records without either application or administration registries. */
export const controlPlaneAppSchema = z
  .object({
    id: uuid,
    identityStatus: z.enum(["pending", "assigned"]),
    name: z.string().nullable(),
    slug: z.string().nullable(),
    appUrl: z.url().nullable(),
    authUrl: z.url(),
    apiUrl: z.url(),
    visibility: appVisibilitySchema,
    aiCredentialSource: appAiCredentialSourceSchema.default("owner"),
    state: appStateSchema,
    backupSchedule: z.enum(["none", "daily", "weekly"]).optional(),
    ownerUserId: uuid,
    organisationId: uuid.optional(),
    workspaceId: uuid.optional(),
    placementVersion: z.string().regex(/^(0|[1-9][0-9]{0,39})$/).optional(),
    creatorUserId: uuid.optional(),
    desiredDeploymentId: uuid.nullable(),
    activeDeploymentId: uuid.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const controlPlaneAppDeploymentTruthSchema = z
  .object({
    schemaVersion: z.literal(1),
    appId: uuid,
    appState: appStateSchema,
    canonicalUrl: z.url().nullable(),
    activeDeployment: z
      .object({
        id: uuid,
        version: z.string(),
        artifactSha256: sha256,
        state: deploymentStateSchema,
        activatedAt: z.string().nullable(),
        activationOperationId: uuid.nullable(),
        activatedByAgentRootRunId: uuid.nullable(),
      })
      .refine(
        (deployment) =>
          deployment.activatedByAgentRootRunId === null ||
          deployment.activationOperationId !== null,
        {
          message: "Agent activation attribution requires an operation",
          path: ["activatedByAgentRootRunId"],
        },
      )
      .passthrough()
      .nullable(),
  })
  .passthrough();

export const controlPlaneOperationSchema = z
  .object({
    id: uuid,
    appId: uuid.nullable(),
    deploymentId: uuid.nullable(),
    type: z.string(),
    state: operationStateSchema,
    actorType: z.string(),
    actorId: z.string(),
    idempotencyKey: z.string(),
    error: jsonObject.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    steps: z
      .array(
        z
          .object({
            id: uuid,
            name: z.string(),
            state: operationStateSchema,
            attempt: z.number().int(),
            startedAt: z.string().nullable(),
            finishedAt: z.string().nullable(),
            output: jsonObject.nullable(),
            error: jsonObject.nullable(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
