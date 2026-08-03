import type { InferenceProvider } from "./types";
import { API_ENDPOINTS, buildApiUrl } from "../../../config/constants";
import logger from "../../../utils/logger";

// xAI speaks OpenAI's Chat Completions dialect at api.x.ai/v1, so this needs no
// request shaping of its own. The one xAI-specific detail lives in
// thinkingSuppressionDialects: its reasoning_effort enum is low|medium|high with
// no "none", so the generic off-switch would be rejected.
//
// The key is the same xaiApiKey the transcription side already stores — a user
// running Grok STT does not have to paste it a second time to clean with Grok.
export const xaiProvider: InferenceProvider = {
  id: "xai",
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("XAI_START", { model, agentName });
    const apiKey = await ctx.getApiKey("xai");
    const endpoint = buildApiUrl(API_ENDPOINTS.XAI_BASE, "/chat/completions");
    return ctx.callChatCompletionsApi(endpoint, apiKey, model, text, agentName, config, "xAI");
  },
};
