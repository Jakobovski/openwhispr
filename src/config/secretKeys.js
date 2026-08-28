// Single source of truth for the uniform BYOK cloud-LLM API-key secrets:
// environment.js, ipcHandlers.js and the settings store all derive their
// per-key plumbing from this list, so adding a provider is one entry.
// CommonJS + pure data so both the main process and the Vite renderer share it.
// `base` yields the IPC channels `get-<base>-key` / `save-<base>-key`.
// preload.js can't require local modules under sandbox, so it mirrors the
// {base, get, save} tuples inline — keep BYOK_KEY_BRIDGES there in sync
// (guarded by test/helpers/secretKeys.test.js).
const BYOK_API_KEYS = [
  {
    base: "openai",
    env: "OPENAI_API_KEY",
    get: "getOpenAIKey",
    save: "saveOpenAIKey",
    storeKey: "openaiApiKey",
  },
  {
    base: "anthropic",
    env: "ANTHROPIC_API_KEY",
    get: "getAnthropicKey",
    save: "saveAnthropicKey",
    storeKey: "anthropicApiKey",
  },
  {
    base: "gemini",
    env: "GEMINI_API_KEY",
    get: "getGeminiKey",
    save: "saveGeminiKey",
    storeKey: "geminiApiKey",
  },
  {
    base: "groq",
    env: "GROQ_API_KEY",
    get: "getGroqKey",
    save: "saveGroqKey",
    storeKey: "groqApiKey",
  },
  { base: "xai", env: "XAI_API_KEY", get: "getXaiKey", save: "saveXaiKey", storeKey: "xaiApiKey" },
  {
    base: "mistral",
    env: "MISTRAL_API_KEY",
    get: "getMistralKey",
    save: "saveMistralKey",
    storeKey: "mistralApiKey",
  },
  {
    base: "openrouter",
    env: "OPENROUTER_API_KEY",
    get: "getOpenrouterKey",
    save: "saveOpenrouterKey",
    storeKey: "openrouterApiKey",
  },
  {
    // Azure Speech, for MAI-Transcribe. Its key is used only in the main process — the
    // renderer never sends the request — but it still needs a store field, because
    // isMultiTranscriptionEnabled counts a lane as unusable when its key field is empty.
    base: "azurespeech",
    env: "AZURE_SPEECH_API_KEY",
    get: "getAzurespeechKey",
    save: "saveAzurespeechKey",
    storeKey: "azureSpeechApiKey",
  },
  {
    base: "tinfoil",
    env: "TINFOIL_API_KEY",
    get: "getTinfoilKey",
    save: "saveTinfoilKey",
    storeKey: "tinfoilApiKey",
  },
  {
    base: "corti",
    env: "CORTI_API_KEY",
    get: "getCortiKey",
    save: "saveCortiKey",
    storeKey: "cortiApiKey",
  },
  {
    base: "soniox",
    env: "SONIOX_API_KEY",
    get: "getSonioxKey",
    save: "saveSonioxKey",
    storeKey: "sonioxApiKey",
  },
];

module.exports = { BYOK_API_KEYS };
