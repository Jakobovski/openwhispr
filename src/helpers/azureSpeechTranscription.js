const debugLogger = require("./debugLogger");

// Azure Speech transcription, used for MAI-Transcribe.
//
// Not an OpenAI-shaped endpoint: the audio field is `audio` rather than `file`, the
// options travel as a JSON `definition` part rather than flat form fields, auth is
// Ocp-Apim-Subscription-Key rather than a bearer token, and the transcript comes back
// under combinedPhrases rather than `text`. So it gets its own client instead of an
// entry in the OpenAI-compatible table.
//
// It runs in the main process for the same reason the xAI path does: the renderer's
// fetch is subject to CORS, and this endpoint is not documented as sending the headers
// that would satisfy it.
//
// Why bother, when OpenRouter also serves mai-transcribe-1.5: the phrase list. Going
// direct is the only way to bias recognition, and OpenRouter silently drops the
// parameter (verified — identical transcripts with and without). Biasing fixes a class
// of error nothing downstream can: "openwhispr" comes back as "a pen whisper", three
// tokens where one word was said, which no after-the-fact word matcher can reassemble.

const API_VERSION = "2025-10-15";

// Microsoft documents no limit on the phrase list, so this is a self-imposed bound
// rather than a documented one. 200, matching the cap on the merge prompt: the two
// receive the same frequency-ordered vocabulary, and keeping them equal means a term
// that biased the recogniser is also a term the merge saw. The cap exists at all
// because an unbounded list would grow with whatever happens to be on screen.
const MAX_PHRASES = 200;

// Phrases are matched as whole entries, so a very long one is not a phrase — it is a
// sentence that will never match. Trimmed rather than dropped, in case it starts with
// the term that mattered.
const MAX_PHRASE_LENGTH = 100;

/**
 * The `definition` part of the request.
 *
 * Exported for tests: this is the part with all the rules in it, and it is far easier
 * to get wrong than the transport around it.
 */
function buildDefinition({ locale, phrases = [], model = "mai-transcribe-1.5" } = {}) {
  const definition = {
    enhancedMode: { enabled: true, model },
  };

  // "en" is rejected; Azure wants a full locale. An absent or "auto" language means
  // multilingual mode, which is the model's default, so the key is omitted entirely
  // rather than guessed at.
  if (locale) definition.locales = [locale];

  const cleaned = [];
  const seen = new Set();
  for (const phrase of phrases) {
    if (typeof phrase !== "string") continue;
    const trimmed = phrase.trim().slice(0, MAX_PHRASE_LENGTH);
    if (!trimmed) continue;
    // Case-insensitive dedupe: the same term routinely arrives from both the custom
    // dictionary and the screen, and a duplicate spends the budget twice.
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(trimmed);
    if (cleaned.length >= MAX_PHRASES) break;
  }

  if (cleaned.length > 0) definition.phraseList = { phrases: cleaned };
  return definition;
}

/** Full transcription URL for a resource host. */
function buildUrl(endpoint) {
  const host = String(endpoint || "")
    .trim()
    .replace(/\/+$/, "");
  if (!host) return null;
  return `${host}/speechtotext/transcriptions:transcribe?api-version=${API_VERSION}`;
}

/**
 * Normalises the resource host from whatever the user pasted.
 *
 * The Azure portal shows a Foundry *project* URL — services.ai.azure.com/api/projects/…
 * — which is not where the Speech REST API lives. The transcription endpoint is the
 * resource's cognitiveservices.azure.com host, so a project URL is converted rather
 * than rejected: pasting the thing the portal displays should work.
 */
function normalizeEndpoint(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";

  let url;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    return "";
  }

  const host = url.hostname;
  const foundry = host.match(/^(.+?)\.services\.ai\.azure\.com$/i);
  if (foundry) return `https://${foundry[1]}.cognitiveservices.azure.com`;
  return `https://${host}`;
}

async function transcribeWithAzureSpeech({
  apiKey,
  endpoint,
  audio,
  mimeType,
  locale,
  phrases,
  model,
  signal,
} = {}) {
  if (!apiKey) throw new Error("No Azure Speech key configured");
  const url = buildUrl(normalizeEndpoint(endpoint));
  if (!url) throw new Error("No Azure Speech endpoint configured");

  const definition = buildDefinition({ locale, phrases, model });
  const form = new FormData();
  form.append("audio", new Blob([audio], { type: mimeType || "audio/wav" }), "audio.wav");
  form.append("definition", JSON.stringify(definition));

  const started = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": apiKey },
    body: form,
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Azure Speech transcription failed: ${response.status} ${detail.slice(0, 300)}`
    );
  }

  const payload = await response.json();
  // combinedPhrases holds the whole transcript; `phrases` is the per-segment breakdown,
  // which nothing here needs.
  const text = payload?.combinedPhrases?.[0]?.text ?? "";

  debugLogger.debug(
    "Azure Speech transcription",
    {
      ms: Date.now() - started,
      chars: text.length,
      phraseCount: definition.phraseList?.phrases?.length ?? 0,
      locale: definition.locales?.[0] ?? "multilingual",
    },
    "transcription"
  );

  return { text };
}

module.exports = {
  transcribeWithAzureSpeech,
  buildDefinition,
  buildUrl,
  normalizeEndpoint,
  MAX_PHRASES,
  MAX_PHRASE_LENGTH,
};
