const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// The merge is an LLM reading labelled candidate transcripts, so the rules that
// decide the winner live in prose rather than in code. That makes two things
// silently breakable, and both have broken:
//
//   - The slot count grew from two to three, and the prompt kept describing its
//     input as exactly two versions while three were being passed.
//   - The per-provider tie-break was written into the English prompt only, so
//     every other UI language merged with no tie-break rule at all.
//
// These checks are text scans over the shipped prompts for that reason: they are
// the only thing standing between a config change and a prompt that quietly
// stops describing reality.

const ROOT = path.join(__dirname, "..", "..");
const LOCALES = path.join(ROOT, "src", "locales");
const {
  MULTI_TRANSCRIPTION_SLOTS,
  TRANSCRIPTION_QUALITY_ORDER,
} = require("../../src/config/multiTranscription.ts");

const languages = fs
  .readdirSync(LOCALES)
  .filter((entry) => fs.statSync(path.join(LOCALES, entry)).isDirectory())
  .sort();

// The name each provider is called in the prompt, which is also the label
// wrapReconcileVersions tags its version block with.
const PROVIDER_NAMES = {
  "azure-speech": "Azure Speech",
  xai: "xAI",
  openai: "OpenAI",
  groq: "Groq",
  openrouter: "OpenRouter",
};

const prompts = new Map(
  languages.map((lang) => [
    lang,
    JSON.parse(fs.readFileSync(path.join(LOCALES, lang, "prompts.json"), "utf8")).reconcilePrompt,
  ])
);

test("every locale has a reconcile prompt", () => {
  const missing = languages.filter((lang) => !prompts.get(lang)?.trim());
  assert.deepEqual(missing, []);
});

test("the prompt names a version tag for every slot a dictation can fill", () => {
  // wrapReconcileVersions tags versions a, b, c… one per answering lane. A prompt
  // that only mentions version_a and version_b is describing a two-lane dictation
  // to a model that has just been handed three.
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const expected = MULTI_TRANSCRIPTION_SLOTS.map((_, index) => `version_${letters[index]}`);

  const gaps = [];
  for (const [lang, prompt] of prompts) {
    for (const tag of expected) {
      if (!prompt.includes(tag)) gaps.push(`${lang}: no mention of <${tag}>`);
    }
  }

  assert.deepEqual(gaps, []);
});

test("the prompt does not claim the input is exactly two transcripts", () => {
  // "two independent transcripts" was literally true when it was written and is
  // now wrong in the default configuration. Any locale still asserting a pair is
  // describing an input it no longer receives.
  const pairClaims = {
    en: "two independent",
    es: "Entrada: dos transcripciones",
    fr: "deux transcriptions indépendantes du",
    de: "Eingabe: zwei unabhängige",
    pt: "Entrada: duas transcrições",
    it: "Input: due trascrizioni",
    ru: "два независимых транскрипта ОДНОГО",
    ja: "2つの音声認識エンジンが",
    "zh-CN": "的两份独立语音识别转录",
    "zh-TW": "的兩份獨立語音辨識轉錄",
  };

  const stale = [];
  for (const [lang, claim] of Object.entries(pairClaims)) {
    const prompt = prompts.get(lang);
    if (prompt && prompt.includes(claim)) stale.push(`${lang}: still says "${claim}"`);
  }

  assert.deepEqual(stale, []);
});

test("every locale carries the provider tie-break, subordinated to a majority", () => {
  // The rule the user relies on: two recognisers agreeing beats the one recogniser
  // with the best track record. A locale that names the preferred provider without
  // the majority rule ranks xAI above two providers contradicting it.
  const missingOrder = [];
  const missingMajority = [];

  for (const [lang, prompt] of prompts) {
    for (const provider of TRANSCRIPTION_QUALITY_ORDER) {
      // Provider names are untranslated brand names in every locale. An explicit map,
      // not a fallback: this previously ended in `: "Groq"`, so a provider added to the
      // order matched a name already in the prompt and the check passed without the new
      // one ever being mentioned.
      const name = PROVIDER_NAMES[provider];
      assert.ok(name, `no prompt name known for "${provider}" — add it to PROVIDER_NAMES`);
      if (!prompt.includes(name)) missingOrder.push(`${lang}: no mention of ${name}`);
    }

    const majorityWords = {
      en: "majority",
      es: "mayoría",
      fr: "majorité",
      de: "Mehrheit",
      pt: "maioria",
      it: "maggioranza",
      ru: "большинств",
      ja: "多数派",
      "zh-CN": "多数",
      "zh-TW": "多數",
    };
    const word = majorityWords[lang];
    if (word && !prompt.includes(word)) missingMajority.push(`${lang}: no majority rule`);
  }

  assert.deepEqual(missingOrder, []);
  assert.deepEqual(missingMajority, []);
});
