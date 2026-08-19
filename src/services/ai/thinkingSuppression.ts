import type { ReasoningConfig } from "../BaseReasoningService";
import { getCloudModel, getLocalModel } from "../../models/ModelRegistry";
import { detectEndpointDialect, suppressThinking } from "./thinkingSuppressionDialects";

export function applyThinkingSuppression(
  requestBody: Record<string, unknown>,
  model: string,
  provider: string,
  config: ReasoningConfig,
  baseUrl?: string
): void {
  // A known endpoint host wins over the generic provider dialect.
  const providerKey = detectEndpointDialect(baseUrl)?.key ?? provider.toLowerCase();
  // Scoped to the provider actually being called: openai/gpt-oss-120b exists under both
  // groq and openrouter with different reasoning behaviour, and an id-only lookup
  // returns whichever the JSON lists first (groq), so an OpenRouter call would read the
  // wrong entry's flags.
  const cloudModel = getCloudModel(model, provider);

  if (cloudModel?.disableThinking && providerKey === "groq") {
    suppressThinking(requestBody, providerKey, model);
    return;
  }

  if (config.disableThinking !== true) return;

  const localModel = getLocalModel(model);
  const knownModel = cloudModel || localModel;
  if (knownModel && !knownModel.supportsThinking) return;

  // The registry is the single place that records which models refuse a hard disable;
  // the dialect table takes it as an argument so it keeps no runtime imports.
  suppressThinking(requestBody, providerKey, model, cloudModel?.reasoningMandatory);
}
