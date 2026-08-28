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

test("one builder feeds every consumer", () => {
  // Two assemblies of the same idea drifted apart once: different caps, different
  // contents, and the merge seeing words the recogniser was never given.
  //
  // The builder now takes a limit, because providers genuinely differ in how many terms
  // they accept — Azure's phrase list takes 200 here, Gemini takes 1000, and passing the
  // lowest common number would throw away 800 terms of the speaker's own vocabulary. So
  // what has to hold is *one builder*, not one call shape: this counts definitions and
  // consumers separately rather than matching bare `getDictationVocabulary()`, which
  // used to include the definition and broke as soon as it took a parameter.
  const definitions = audioManager.match(/^\s*async getDictationVocabulary\(/gm) ?? [];
  assert.equal(definitions.length, 1, "there must be exactly one builder");

  // Checked by its body, not only its name: a second builder called something else
  // would pass the name check above while being exactly the duplicate assembly this
  // test exists to prevent. The dictionary-then-screen-terms merge is the signature.
  const assemblies = audioManager.match(/for \(const term of \[\.\.\.dictionary,/g) ?? [];
  assert.equal(assemblies.length, 1, "the vocabulary must be assembled in exactly one place");

  // Consumers now reach it through getProviderTerms, which applies the provider's own
  // ceiling — one generator, one shaper, rather than each lane naming a limit. The merge
  // still calls the generator directly because it wants no provider's shape.
  const consumers = audioManager.match(/this\.getDictationVocabulary\(/g) ?? [];
  assert.ok(consumers.length >= 2, `expected the shaper and the merge, saw ${consumers.length}`);
  assert.match(
    audioManager,
    /const terms = await this\.getDictationVocabulary\(shape\.limit\)/,
    "the shaper must build from the one generator"
  );
  assert.match(
    audioManager,
    /phrases: await this\.getProviderTerms\("azure-speech"\)/,
    "Azure gets its terms from the shaper"
  );
  assert.match(
    audioManager,
    /DICTATION_VOCABULARY_LIMIT = 200/,
    "the shared default cap must stay a single constant"
  );
  assert.doesNotMatch(
    audioManager,
    /RECONCILE_SCREEN_TERM_LIMIT/,
    "the merge must not keep a separate cap"
  );
});

test("no consumer trims the vocabulary itself", () => {
  // The drift the builder exists to prevent: a caller slicing or de-duplicating the
  // list again would produce a different vocabulary from the same source, which is how
  // the recogniser and the merge stopped agreeing last time.
  assert.doesNotMatch(
    audioManager,
    /getDictationVocabulary\([^)]*\)\s*\)?\s*\.(slice|filter|map)\(/,
    "a consumer is re-trimming the shared vocabulary"
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
  // Capped inside the builder against its own parameter, so a consumer cannot end up
  // with a longer list than it asked for or apply a cap of its own.
  assert.match(audioManager, /vocabulary\.length >= limit/, "the cap must be inside the builder");
  // And the parameter defaults to the shared constant, so a caller that says nothing
  // gets the conservative cap rather than an unbounded list.
  assert.match(
    audioManager,
    /async getDictationVocabulary\(limit = DICTATION_VOCABULARY_LIMIT\)/,
    "the default must be the shared cap"
  );
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
