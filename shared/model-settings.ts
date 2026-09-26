/** Per-turn model choices. Credentials and provider endpoints never travel in this object. */
export type ModelSettings = { model?: string; effort?: string };

export type ModelOption = {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort?: string;
};

export type ModelCapabilities = {
  framework: string;
  defaultModel: string | null;
  models: ModelOption[];
  customModels: boolean;
};

export function parseModelSettings(value: unknown): ModelSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model settings must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "model" && key !== "effort")) {
    throw new Error("Unknown model setting.");
  }
  const result: ModelSettings = {};
  if (input.model !== undefined && input.model !== "") {
    if (
      typeof input.model !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/[\]-]{0,199}$/.test(input.model)
    ) {
      throw new Error("Enter a model identifier of at most 200 characters.");
    }
    result.model = input.model;
  }
  if (input.effort !== undefined && input.effort !== "") {
    if (
      typeof input.effort !== "string" ||
      !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        input.effort,
      )
    ) {
      throw new Error("Unknown reasoning effort.");
    }
    result.effort = input.effort;
  }
  return result;
}

export function validateModelChoice(
  settings: ModelSettings,
  capabilities: ModelCapabilities,
): void {
  const model = capabilities.models.find(
    (entry) => entry.id === (settings.model ?? capabilities.defaultModel),
  );
  if (settings.model && !model && !capabilities.customModels) {
    throw new Error("This agent does not offer that model.");
  }
  if (settings.effort && !model?.efforts.includes(settings.effort)) {
    throw new Error("This model does not expose that reasoning effort.");
  }
}
