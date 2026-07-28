// xAI STT supports 25 languages. Anything outside this set must be omitted from
// the request so the server auto-detects instead of rejecting it — the REST path
// also uses membership here to decide whether to enable ITN via format=true.
const XAI_STT_LANGUAGES = new Set([
  "ar",
  "cs",
  "da",
  "de",
  "en",
  "es",
  "fa",
  "fil",
  "fr",
  "hi",
  "id",
  "it",
  "ja",
  "ko",
  "mk",
  "ms",
  "nl",
  "pl",
  "pt",
  "ro",
  "ru",
  "sv",
  "th",
  "tr",
  "vi",
]);

// Resolves a UI language code to one xAI accepts, falling back to the base code
// (e.g. "pt-BR" → "pt"). Returns null for "auto" and unsupported languages.
function resolveXaiSttLanguage(language) {
  if (!language || language === "auto") return null;
  if (XAI_STT_LANGUAGES.has(language)) return language;
  const base = language.split("-")[0].toLowerCase();
  return XAI_STT_LANGUAGES.has(base) ? base : null;
}

module.exports = { XAI_STT_LANGUAGES, resolveXaiSttLanguage };
