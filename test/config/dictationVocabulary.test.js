const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// The screen vocabulary reaches the merge through a runtime suffix, not the stored
// template — so reading the prompt file shows no sign of it and the wiring has to be
// checked at the seams instead.
//
// It was broken exactly there. The merge read this._screenContext directly, and that
// field is only populated as a side effect of something else asking for it: the Azure
// lane's phrase list, or the post-transcription matcher, which runs after the merge. So
// the terms arrived only when an Azure lane happened to fetch them first, and never at
// all on an xAI/OpenAI/Groq setup — while the code read as though it always worked.

const ROOT = path.join(__dirname, "..", "..");
const audioManager = fs.readFileSync(path.join(ROOT, "src", "helpers", "audioManager.js"), "utf8");
const resolver = fs.readFileSync(path.join(ROOT, "src", "config", "prompts", "index.ts"), "utf8");
const promptsApi = fs.readFileSync(path.join(ROOT, "src", "config", "prompts.ts"), "utf8");

test("the merge builds its vocabulary the same way the recogniser's is built", () => {
  const merge = audioManager.slice(
    audioManager.indexOf("const reconcileBudgetMs"),
    audioManager.indexOf("const trimmed = typeof outcome")
  );

  assert.match(
    merge,
    /await this\.getDictationVocabulary\(\)/,
    "the merge must use the shared builder, not assemble its own list"
  );
  assert.doesNotMatch(
    merge,
    /this\._screenContext\?\.terms/,
    "reading the field directly is the bug: it is empty unless something else asked first"
  );
});

test("one builder feeds both the recogniser and the merge", () => {
  // Two assemblies of the same idea drifted apart once: different caps, different
  // contents, and the merge seeing words the recogniser was never given.
  const calls = audioManager.match(/getDictationVocabulary\(\)/g) ?? [];
  assert.ok(calls.length >= 3, "expected the definition plus both consumers");
  assert.match(audioManager, /phrases: await this\.getDictationVocabulary\(\)/, "Azure uses it");
  assert.match(audioManager, /DICTATION_VOCABULARY_LIMIT = 200/, "one cap, not one per consumer");
  assert.doesNotMatch(
    audioManager,
    /RECONCILE_SCREEN_TERM_LIMIT/,
    "the merge must not keep a separate cap"
  );
});

test("the dictionary is not sent twice to the merge", () => {
  // It is the head of the vocabulary already; passing it as the dictionary argument too
  // would list every curated word in both blocks.
  const merge = audioManager.slice(
    audioManager.indexOf("systemPrompt: getReconcileSystemPrompt("),
    audioManager.indexOf("temperature: 0")
  );
  assert.doesNotMatch(merge, /getCustomDictionaryArray\(\)/);
});

test("the vocabulary is capped where it is built, once", () => {
  assert.match(audioManager, /vocabulary\.length >= DICTATION_VOCABULARY_LIMIT/);
});

test("the prompt getter forwards them to the resolver", () => {
  assert.match(promptsApi, /vocabulary\?: string\[\]/, "getReconcileSystemPrompt must accept it");
  assert.match(promptsApi, /vocabulary,/, "and pass them through to resolvePrompt");
});

test("the resolver appends them to every prompt it builds", () => {
  assert.match(
    resolver,
    /return appendVocabularySuffix\(withDictionary, opts\.vocabulary, opts\.uiLanguage\)/,
    "applySubstitutions must append the vocabulary"
  );
  // Empty means absent, not an empty heading — a suffix with nothing after it would
  // tell the model there was vocabulary on screen and then show it none.
  assert.match(resolver, /if \(!vocabulary\?\.length\) return prompt;/);
});

test("every locale has the suffix the resolver falls back to", () => {
  const locales = fs
    .readdirSync(path.join(ROOT, "src", "locales"))
    .filter((d) => fs.statSync(path.join(ROOT, "src", "locales", d)).isDirectory());

  for (const lang of locales) {
    const prompts = JSON.parse(
      fs.readFileSync(path.join(ROOT, "src", "locales", lang, "prompts.json"), "utf8")
    );
    assert.ok(prompts.vocabularySuffix?.trim(), `${lang} has no vocabularySuffix`);
    assert.ok(
      prompts.vocabularySuffix.startsWith("\n\n"),
      `${lang}'s suffix must start a new block, or it runs into the previous line`
    );
  }
});
