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

test("the merge collects the screen context rather than reading a field", () => {
  const merge = audioManager.slice(
    audioManager.indexOf("const reconcileBudgetMs"),
    audioManager.indexOf("const trimmed = typeof outcome")
  );

  assert.match(
    merge,
    /await this\.ensureScreenContext\(\)/,
    "the merge must fetch the screen context itself, not depend on another caller"
  );
  assert.doesNotMatch(
    merge,
    /this\._screenContext\?\.terms/,
    "reading the field directly is the bug: it is empty unless something else asked first"
  );
});

test("the terms are passed to the reconcile prompt, capped", () => {
  assert.match(
    audioManager,
    /screenContext\?\.terms \?\? \[\]\)\.slice\(0, RECONCILE_SCREEN_TERM_LIMIT\)/,
    "the merge must pass a capped slice of the terms"
  );
  assert.match(audioManager, /RECONCILE_SCREEN_TERM_LIMIT = 200/);
});

test("the prompt getter forwards them to the resolver", () => {
  assert.match(
    promptsApi,
    /screenTerms\?: string\[\]/,
    "getReconcileSystemPrompt must accept them"
  );
  assert.match(promptsApi, /screenTerms,/, "and pass them through to resolvePrompt");
});

test("the resolver appends them to every prompt it builds", () => {
  assert.match(
    resolver,
    /return appendScreenTermsSuffix\(withDictionary, opts\.screenTerms, opts\.uiLanguage\)/,
    "applySubstitutions must append the screen terms after the dictionary"
  );
  // Empty means absent, not an empty heading — a suffix with nothing after it would
  // tell the model there was vocabulary on screen and then show it none.
  assert.match(resolver, /if \(!screenTerms\?\.length\) return prompt;/);
});

test("every locale has the suffix the resolver falls back to", () => {
  const locales = fs
    .readdirSync(path.join(ROOT, "src", "locales"))
    .filter((d) => fs.statSync(path.join(ROOT, "src", "locales", d)).isDirectory());

  for (const lang of locales) {
    const prompts = JSON.parse(
      fs.readFileSync(path.join(ROOT, "src", "locales", lang, "prompts.json"), "utf8")
    );
    assert.ok(prompts.screenTermsSuffix?.trim(), `${lang} has no screenTermsSuffix`);
    assert.ok(
      prompts.screenTermsSuffix.startsWith("\n\n"),
      `${lang}'s suffix must start a new block, or it runs into the previous line`
    );
  }
});
