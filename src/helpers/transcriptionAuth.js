import { isSelfHostedTranscription } from "./selfHostedTranscription.js";

// These providers validate and use their own key inside their provider-specific request.
// Running the generic preflight first falls through to OpenAI and rejects a perfectly
// configured provider because an unrelated OpenAI key is absent.
const PROVIDER_OWNED_AUTH = new Set(["gemini", "soniox", "meta"]);

export function shouldSkipTranscriptionApiKey(settings) {
  return (
    isSelfHostedTranscription(settings) ||
    PROVIDER_OWNED_AUTH.has(settings?.cloudTranscriptionProvider)
  );
}
