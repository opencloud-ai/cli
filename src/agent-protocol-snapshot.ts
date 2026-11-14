// CLI-owned facade: expose only the credential-free public Contracts dependencies.
// The referenced vendor files remain exact platform snapshots.
export {
  aiAutomaticSourceSchema, aiModelPriceSchema, aiQualifiedModelIdSchema,
  aiAutomaticStatusSchema, aiChoiceLabelSchema, aiModelChoiceSchema, aiModelPickerGroupSchema,
} from "../vendor/agent-protocol/src/model-choices.js";
export { runtimeTaskPreparationSchema } from "../vendor/agent-protocol/src/task-preparation.js";
export { platformAiModelPricingCatalog } from "../vendor/agent-protocol/src/platform-ai.js";
