import { z } from "zod";
import { openCloudManifestSchema } from "./manifest.js";

export const appVisibilitySchema = z.enum(["public", "private"]);
const appSlugSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
  .refine((slug) => !["api", "auth", "www"].includes(slug), {
    message: "slug is reserved by OpenCloud",
  });
export const appStateSchema = z.enum([
  "draft",
  "provisioning",
  "deploying",
  "active",
  "failed",
  "rolling_back",
  "archived",
  "deleting",
  "deleted",
]);
export const deploymentStateSchema = z.enum([
  "queued",
  "validating",
  "deploying",
  "active",
  "superseded",
  "failed",
  "rolled_back",
  "deleted",
]);
export const operationStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const createAppRequestSchema = z.object({
  name: z.string().min(1).max(120),
  visibility: appVisibilitySchema.default("private"),
});

export const operatorCreateAppRequestSchema = createAppRequestSchema.extend({
  slug: appSlugSchema.optional(),
  ownerUserId: z.uuid().optional(),
});

export const createCredentialRequestSchema = z.object({
  name: z.string().min(1).max(120),
  expiresInHours: z.coerce.number().int().min(1).max(168).default(24),
  scopes: z
    .array(
      z.enum([
        "app:read",
        "app:deploy",
        "app:configure",
        "app:observe",
        "app:rollback",
        "app:restart",
      ]),
    )
    .min(1),
});

export const startAgentOnboardingRequestSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  projectName: z.string().trim().min(1).max(120),
  visibility: appVisibilitySchema.default("private"),
});

export const completeAgentOnboardingRequestSchema = z.object({
  completionToken: z.string().min(32).max(512),
});

export const deploymentSubmissionSchema = z.object({
  manifest: openCloudManifestSchema,
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type AppVisibility = z.infer<typeof appVisibilitySchema>;
export type AppState = z.infer<typeof appStateSchema>;
export type DeploymentState = z.infer<typeof deploymentStateSchema>;
export type OperationState = z.infer<typeof operationStateSchema>;
export type CreateAppRequest = z.infer<typeof createAppRequestSchema>;
export type CreateCredentialRequest = z.infer<
  typeof createCredentialRequestSchema
>;
export type StartAgentOnboardingRequest = z.infer<
  typeof startAgentOnboardingRequestSchema
>;
export type CompleteAgentOnboardingRequest = z.infer<
  typeof completeAgentOnboardingRequestSchema
>;

export type AgentOnboardingState =
  | "awaiting_email_verification"
  | "provisional_ready"
  | "ready";

export interface AgentOnboardingResponse {
  onboardingId: string;
  state: AgentOnboardingState;
  existingUser: boolean;
  verification: {
    required: true;
    status: "pending" | "verified";
    expiresAt: string;
    emailSent: boolean;
  };
  app: AppRecord | null;
  operation: OperationRecord | null;
  credential: {
    token: string;
    expiresAt: string;
  } | null;
  completionToken?: string;
}

export interface AppRecord {
  id: string;
  name: string;
  slug: string;
  appUrl: string;
  authUrl: string;
  apiUrl: string;
  visibility: AppVisibility;
  state: AppState;
  ownerUserId: string;
  desiredDeploymentId: string | null;
  activeDeploymentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CronInvocationRecord {
  id: string;
  appId: string;
  deploymentId: string;
  cronName: string;
  functionName: string;
  state: "running" | "succeeded" | "failed";
  scheduledAt: string;
  startedAt: string;
  finishedAt: string | null;
  responseStatus: number | null;
  error: Record<string, unknown> | null;
}

export interface DeploymentRecord {
  id: string;
  appId: string;
  version: string;
  artifactSha256: string;
  javascriptSdkVersion: string;
  manifest: unknown;
  state: DeploymentState;
  rollbackOfDeploymentId: string | null;
  error: Record<string, unknown> | null;
  createdAt: string;
  activatedAt: string | null;
}

export interface OperationStep {
  id: string;
  name: string;
  state: OperationState;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

export interface OperationRecord {
  id: string;
  appId: string | null;
  deploymentId: string | null;
  type: string;
  state: OperationState;
  actorType: string;
  actorId: string;
  idempotencyKey: string;
  error: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  steps?: OperationStep[];
}

export interface ErrorResponse {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}
