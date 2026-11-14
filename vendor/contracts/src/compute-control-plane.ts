import { z } from "zod";
import type { ControlPlaneOperation, McpOperationMetadata } from "./control-plane.js";
import {
  containerNameSchema, computeControlRequestSchema, computeEventsPageSchema,
  computeExecutionSchema, computeExecutionsPageSchema, computeJobSubmitRequestSchema,
  computeListQuerySchema, computeOperationReceiptSchema, computePayerSettingsSchema,
  computePayerSettingsUpdateSchema, computePayerUsageSchema, computeScaleRequestSchema,
  computeWorkloadSchema, computeWorkloadsPageSchema,
  computeWorkloadListQuerySchema, computeEventListQuerySchema, containerRegistryCreateSchema, containerRegistrySchema,
  computePriceVersionSchema,
} from "./containers.js";

function op<I extends z.ZodType, O extends z.ZodType>(definition: ControlPlaneOperation<I, O>) { return definition; }
function tool(name: string, title: string, readOnly: boolean): McpOperationMetadata {
  return { toolName: name, title, description: title, readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: !readOnly };
}
const app = z.object({ appId: z.uuid() }).strict();
const dev = app.extend({ sessionId: z.uuid() });

/** Production has no session selector. Development names the exact authorized session in its path. */
function workloadOperations<Shape extends z.ZodRawShape>(path: z.ZodObject<Shape>, prefix: string, toolPrefix: string) {
  const workload = path.extend({ name: containerNameSchema });
  const execution = path.extend({ executionId: z.uuid() });
  const read = { auth: "bearer" as const, scopes: ["app:observe"], idempotency: "none" as const };
  const write = { auth: "bearer" as const, scopes: ["app:configure"], idempotency: "required" as const };
  return {
    list: op({ ...read, method: "GET", path: `${prefix}/containers`, summary: "List container workloads", description: "Read a bounded page of immutable workload revisions, current controls, instances and ledger usage in this exact app environment.", input: path.extend({ query: computeWorkloadListQuerySchema.optional() }), queryKey: "query", output: computeWorkloadsPageSchema, mcp: tool(`list_${toolPrefix}containers`, "List container workloads", true) }),
    get: op({ ...read, method: "GET", path: `${prefix}/containers/{name}`, summary: "Inspect a container workload", description: "Read the active workload's revision, resource limits, current generation, instance states and safe diagnostics.", input: workload, output: computeWorkloadSchema, mcp: tool(`get_${toolPrefix}container`, "Inspect a container workload", true) }),
    submit: op({ ...write, method: "POST", path: `${prefix}/containers/{name}/executions`, summary: "Submit a container job", description: "Durably accept a declared job under the Idempotency-Key header. Replays return its current projection. Input cannot override image, command, resources or permissions. Acceptance does not mean the process started.", input: workload.extend({ body: computeJobSubmitRequestSchema }), bodyKey: "body", output: computeExecutionSchema, mcp: tool(`submit_${toolPrefix}container_job`, "Submit a container job", false) }),
    executions: op({ ...read, method: "GET", path: `${prefix}/container-executions`, summary: "List container executions", description: "Read bounded execution metadata and safe outcomes without inputs, credentials or hidden payer data. Cursors bind all normalized filters and this exact environment.", input: path.extend({ query: computeListQuerySchema.optional() }), queryKey: "query", output: computeExecutionsPageSchema, mcp: tool(`list_${toolPrefix}container_executions`, "List container executions", true) }),
    execution: op({ ...read, method: "GET", path: `${prefix}/container-executions/{executionId}`, summary: "Inspect a container execution", description: "A successful read returns HTTP 200 even when the stored execution failed. Completion delivery is independent of the compute result.", input: execution, output: computeExecutionSchema, mcp: tool(`get_${toolPrefix}container_execution`, "Inspect a container execution", true) }),
    cancel: op({ ...write, method: "POST", path: `${prefix}/container-executions/{executionId}/cancel`, summary: "Cancel a container execution", description: "Record cancellation intent idempotently. Running work becomes terminal only after stop confirmation; cancellation never submits another execution.", input: execution, output: computeExecutionSchema, mcp: tool(`cancel_${toolPrefix}container_execution`, "Cancel a container execution", false) }),
    pause: op({ ...write, method: "POST", path: `${prefix}/containers/{name}/pause`, summary: "Pause a container workload", description: "Compare the control generation and pause dispatch or desired instances. This changes no payer setting.", input: workload.extend({ body: computeControlRequestSchema }), bodyKey: "body", output: computeOperationReceiptSchema, mcp: tool(`pause_${toolPrefix}container`, "Pause a container workload", false) }),
    resume: op({ ...write, method: "POST", path: `${prefix}/containers/{name}/resume`, summary: "Resume a container workload", description: "Compare the control generation and resume within current app authority, payer funding and resource ceilings. This does not replay an uncertain job.", input: workload.extend({ body: computeControlRequestSchema }), bodyKey: "body", output: computeOperationReceiptSchema, mcp: tool(`resume_${toolPrefix}container`, "Resume a container workload", false) }),
    restart: op({ ...write, method: "POST", path: `${prefix}/containers/{name}/restart`, summary: "Restart a service or worker", description: "Durably replace service or worker instances with the expected control generation. Jobs reject this action; job cancellation and explicit submission are separate.", input: workload.extend({ body: computeControlRequestSchema }), bodyKey: "body", output: computeOperationReceiptSchema, mcp: tool(`restart_${toolPrefix}container`, "Restart a service or worker", false) }),
    scale: op({ ...write, method: "PUT", path: `${prefix}/containers/{name}/scale`, summary: "Set a worker replica override", description: "Compare the control generation and set fixed worker replicas within the manifest ceiling. The visible override resets at the next deployment and never changes a budget.", input: workload.extend({ body: computeScaleRequestSchema }), bodyKey: "body", output: computeOperationReceiptSchema, mcp: tool(`scale_${toolPrefix}container`, "Set a worker replica override", false) }),
    events: op({ ...read, method: "GET", path: `${prefix}/containers/{name}/events`, summary: "Read container lifecycle events", description: "Read a bounded safe event timeline. Reads do not change state, acknowledge outcomes or resolve alerts.", input: workload.extend({ query: computeEventListQuerySchema.optional() }), queryKey: "query", output: computeEventsPageSchema, mcp: tool(`list_${toolPrefix}container_events`, "Read container lifecycle events", true) }),
  };
}
const production = workloadOperations(app, "/v1/apps/{appId}", "");
const development = workloadOperations(dev, "/v1/apps/{appId}/dev-sessions/{sessionId}", "dev_");
const payer = { auth: "user" as const, scopes: [] as string[] };
const payerRange = z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }).strict().refine(value => Date.parse(value.to) > Date.parse(value.from) && Date.parse(value.to) - Date.parse(value.from) <= 31 * 86_400_000, "Usage range must be positive and at most 31 days");
const checkout = z.object({ priceVersionId: z.uuid(), acceptedTerms: z.literal(true), returnUrl: z.url().max(2_048) }).strict();
const redirect = z.object({ url: z.url() }).strict();

export const computeControlPlaneOperations = {
  getComputePrices: op({ ...payer, method: "GET", path: "/v1/billing/compute/prices", summary: "Read available compute prices", description: "Read at most 100 current effective immutable price versions for explicit payer consent. Requires current payer administration; no app credential may select or consent to a price.", input: z.object({}).strict(), output: z.object({ prices: z.array(computePriceVersionSchema).max(100) }).strict(), idempotency: "none" }),
  listContainerRegistries: op({ auth: "bearer", scopes: ["app:configure"], method: "GET", path: "/v1/apps/{appId}/compute/registries", summary: "List container registry connections", description: "Read safe app-bound registry metadata without credentials. A connection does not authorize private or internal network destinations.", input: app, output: z.object({ connections: z.array(containerRegistrySchema).max(100) }).strict(), idempotency: "none" }),
  createContainerRegistry: op({ auth: "bearer", scopes: ["app:configure"], method: "POST", path: "/v1/apps/{appId}/compute/registries", summary: "Connect a container registry", description: "Encrypt an app-bound credential for one exact registry host. Trusted image fetching independently checks destination and redirect policy; credentials never enter a sandbox or response.", input: app.extend({ body: containerRegistryCreateSchema }), bodyKey: "body", output: containerRegistrySchema, idempotency: "required" }),
  deleteContainerRegistry: op({ auth: "bearer", scopes: ["app:configure"], method: "DELETE", path: "/v1/apps/{appId}/compute/registries/{connectionId}", summary: "Revoke a container registry connection", description: "Block future credential resolution while retaining already-pinned immutable mirrored images.", input: app.extend({ connectionId: z.uuid() }), output: z.object({ revoked: z.literal(true) }).strict(), idempotency: "required" }),
  listContainers: production.list,
  getContainer: production.get,
  submitContainerJob: production.submit,
  listContainerExecutions: production.executions,
  getContainerExecution: production.execution,
  cancelContainerExecution: production.cancel,
  pauseContainer: production.pause,
  resumeContainer: production.resume,
  restartContainer: production.restart,
  scaleContainer: production.scale,
  listContainerEvents: production.events,
  listDevContainers: development.list,
  getDevContainer: development.get,
  submitDevContainerJob: development.submit,
  listDevContainerExecutions: development.executions,
  getDevContainerExecution: development.execution,
  cancelDevContainerExecution: development.cancel,
  pauseDevContainer: development.pause,
  resumeDevContainer: development.resume,
  restartDevContainer: development.restart,
  scaleDevContainer: development.scale,
  listDevContainerEvents: development.events,
  getComputeSettings: op({ ...payer, method: "GET", path: "/v1/billing/compute", summary: "Read compute payer settings", description: "Resolve the signed-in person's current payer. Only the personal payer or organisation administrator may manage compute; app administration alone grants no billing authority.", input: z.object({}).strict(), output: computePayerSettingsSchema, idempotency: "none" }),
  updateComputeSettings: op({ ...payer, method: "PUT", path: "/v1/billing/compute", summary: "Update compute payer settings", description: "Enable or disable already-configured compute and update separate monthly/daily net spending limits under current payer administration. Prior usage and commitments remain.", input: z.object({ body: computePayerSettingsUpdateSchema }).strict(), bodyKey: "body", output: computePayerSettingsSchema, idempotency: "required" }),
  getComputePayerUsage: op({ ...payer, method: "GET", path: "/v1/billing/compute/usage", summary: "Read compute payer usage", description: "Read authoritative production and development quantities, costs, credits and outstanding reservations for the current authorized payer.", input: z.object({ query: payerRange }).strict(), queryKey: "query", output: computePayerUsageSchema, idempotency: "none" }),
  createComputeCheckout: op({ ...payer, method: "POST", path: "/v1/billing/compute/checkout-sessions", summary: "Start a separate compute subscription", description: "Capture explicit consent to the selected immutable compute price version. Unsupported payment modes fail closed without changing seat or personal-plan billing.", input: z.object({ body: checkout }).strict(), bodyKey: "body", output: redirect, idempotency: "required" }),
  createComputeBillingPortal: op({ ...payer, method: "POST", path: "/v1/billing/compute/portal-sessions", summary: "Manage the compute subscription", description: "Create an authorized payment-management redirect for the current payer's separate compute subscription.", input: z.object({}).strict(), output: redirect, idempotency: "required" }),
} as const;
