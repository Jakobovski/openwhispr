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
  model: string,
  /**
   * The model's `reasoningMandatory` flag from the registry, passed in rather than
   * looked up so this table keeps no runtime imports. Undefined for a model the
   * registry does not know, which is treated the same as false: probe with the hard
   * disable and let openai.ts's retry cover it.
   */
  reasoningMandatory?: boolean
): void {
  if (providerKey === "gemini") {
    requestBody.reasoning_effort = "minimal";
    return;
  }

  // OpenRouter forwards unknown params to upstream backends, which may reject
  // them — use its native reasoning control instead.
  //
  // A hard disable, not `effort: "minimal"`: verified live that `{ enabled: false }`
  // genuinely gets reasoning to zero tokens on well-behaved models (nvidia's
  // nemotron-3.5-lightning, for one), where `effort: "minimal"` is a request the
  // model is free to ignore — nemotron did, spending 1300+ reasoning tokens anyway
  // and blowing the completion budget before any content came out.
  //
  // Some models reject the hard disable outright instead of just ignoring it —
  // "Reasoning is mandatory for this endpoint and cannot be disabled," confirmed
  // live for openai/gpt-oss-120b, Gemini 3.6/3.7 Flash and Meta's Muse Glimmer.
  // Those carry reasoningMandatory in the registry and get the softer request up
  // front, because otherwise every single call to them spends a whole round trip
  // being rejected first — measured at 67ms of a 189ms merge for gpt-oss-120b,
  // which sits in the paste path.
  //
  // The flag is per model rather than a rule about the provider because the two
  // behaviours coexist under openrouter, and getting it wrong in either direction
  // has cost us: guessing "mandatory" for a model that actually accepts the hard
  // disable is the nemotron regression above. openai.ts still retries on the
  // rejection, so a missing or stale flag costs latency, never a failed merge.
  if (providerKey === "openrouter") {
    requestBody.reasoning = reasoningMandatory ? { effort: "minimal" } : { enabled: false };
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
