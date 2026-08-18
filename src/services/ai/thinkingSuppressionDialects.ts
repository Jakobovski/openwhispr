/**
 * Per-provider dialects for turning a model's thinking off. Kept free of runtime
 * imports so the dialect table stays unit-testable on its own.
 */
export interface EndpointDialect {
  key: "mistral";
  tokenParam: "max_tokens" | "max_completion_tokens";
  supportsTemperature: boolean;
}

/** Custom endpoints that need their own request shape, recognised by host. */
export function detectEndpointDialect(baseUrl: string | null | undefined): EndpointDialect | null {
  if (!baseUrl) return null;

  let host: string;
  try {
    const normalized = baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`;
    host = new URL(normalized).hostname.toLowerCase();
  } catch {
    return null;
  }

  if (host === "mistral.ai" || host.endsWith(".mistral.ai")) {
    return { key: "mistral", tokenParam: "max_tokens", supportsTemperature: true };
  }

  return null;
}

export function suppressThinking(
  requestBody: Record<string, unknown>,
  providerKey: string,
  model: string
): void {
  if (providerKey === "gemini") {
    requestBody.reasoning_effort = "minimal";
    return;
  }

  // OpenRouter forwards unknown params to upstream backends, which may reject
  // them — use its native reasoning control instead.
  //
  // Not `{ enabled: false }`: several reasoning-mandatory models (verified live —
  // Gemini 3.6/3.7 Flash, Meta's Muse Glimmer) reject that outright with "Reasoning
  // is mandatory for this endpoint and cannot be disabled," a 400 that propagates
  // as a thrown error with no retry — so the reconcile call for those models never
  // completed, and every merge silently fell back to picking a lane instead. Their
  // *effort* can still be turned down even when it can't be turned off: `minimal`
  // is accepted by all three and got Gemini's reasoning token count to zero in
  // testing (Muse Glimmer still spends a small amount, but far less than default).
  if (providerKey === "openrouter") {
    requestBody.reasoning = { effort: "minimal" };
    return;
  }

  // Groq rejects unknown fields outright and takes a different reasoning_effort
  // enum per model family, so send nothing unless the family is known.
  if (providerKey === "groq") {
    const groqModel = (model || "").toLowerCase();
    if (groqModel.includes("qwen")) {
      // qwen3 accepts none|default only.
      requestBody.reasoning_effort = "none";
    } else if (groqModel.includes("gpt-oss")) {
      // gpt-oss accepts low|medium|high only; it has no off switch.
      requestBody.reasoning_effort = "low";
    }
    return;
  }

  // xAI's reasoning_effort enum is low|medium|high (default high) — there is no
  // "none", and chat_template_kwargs is not a parameter it accepts, so the generic
  // branch below would be rejected. Low is the floor, the same compromise gpt-oss
  // gets. Models the registry marks as non-reasoning never reach here.
  if (providerKey === "xai") {
    requestBody.reasoning_effort = "low";
    return;
  }

  // Mistral rejects unknown fields with a 422; reasoning_effort is its native switch.
  if (providerKey === "mistral") {
    // Legacy magistral models reason natively and may reject reasoning_effort.
    if ((model || "").toLowerCase().includes("magistral")) return;
    requestBody.reasoning_effort = "none";
    return;
  }

  if (providerKey === "local") {
    requestBody.think = false;
  } else if (providerKey === "lan") {
    // `lan` always talks to an OpenAI-compat /v1 endpoint: the `reasoning` object
    // disables Ollama thinking; other backends drop it (flat reasoning_effort trips vLLM).
    requestBody.reasoning = { effort: "none" };
  } else {
    requestBody.reasoning_effort = "none";
  }
  requestBody.chat_template_kwargs = { enable_thinking: false };
}
