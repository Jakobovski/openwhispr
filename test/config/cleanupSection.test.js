const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// The Cleanup section: the merge model, its deadline, and the prompt it runs.
//
// It replaced Language Models -> Dictation Cleanup, which configured a model a
// multi-provider dictation never calls — the merge reads the candidate transcripts and
// cleans the result in the same request, so the merge prompt *is* the cleanup prompt.
//
// Three failures are worth catching, and all three are silent:
//
//  - A section id with no sidebar entry. Settings sections are sidebar destinations now,
//    so an id nothing links to is a panel that exists and cannot be opened. Deep links
//    still reach it, which is what makes it easy to miss.
//  - A missing translation. i18next falls back to the key, so a locale without the new
//    strings renders "settingsPage.cleanup.title" rather than failing.
//  - The merge request assembled twice. The panel's test button exists so a prompt can be
//    tried before it is trusted with real dictation; a test that built the request itself
//    would be free to drift from the dictation path and reassure about a call the app
//    never makes.

const ROOT = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

// Read as text rather than imported: settingsSections.ts and the prompt registry both
// import extensionless modules, which node cannot resolve outside the bundler.
const sectionsSource = read("src", "components", "settingsSections.ts");
const promptRegistry = read("src", "config", "prompts", "registry.ts");

const SETTINGS_SECTION_IDS = (() => {
  const block = sectionsSource.slice(
    sectionsSource.indexOf("export const SETTINGS_SECTION_IDS = ["),
    sectionsSource.indexOf("]", sectionsSource.indexOf("export const SETTINGS_SECTION_IDS = ["))
  );
  const ids = [...block.matchAll(/"([a-zA-Z]+)"/g)].map((match) => match[1]);
  assert.ok(ids.length > 3, "could not read the section ids — has the declaration moved?");
  return ids;
})();

const sidebar = read("src", "components", "ControlPanelSidebar.tsx");
const settingsPage = read("src", "components", "SettingsPage.tsx");
const cleanupPanel = read("src", "components", "settings", "CleanupSettings.tsx");
const promptStudio = read("src", "components", "ui", "PromptStudio.tsx");
const audioManager = read("src", "helpers", "audioManager.js");

const LOCALES = fs
  .readdirSync(path.join(ROOT, "src", "locales"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const lookup = (obj, dotted) =>
  dotted.split(".").reduce((node, key) => (node == null ? undefined : node[key]), obj);

test("cleanup is a registered section with a sidebar entry", () => {
  assert.ok(SETTINGS_SECTION_IDS.includes("cleanup"));
  assert.match(
    sidebar,
    /id: "cleanup"/,
    "cleanup is registered but nothing in the sidebar opens it"
  );
  assert.match(
    settingsPage,
    /case "cleanup":\s*\n\s*return <CleanupSettings \/>;/,
    "the cleanup section has no panel to render"
  );
});

// "llms" is the one deliberate exception: this app is multi-transcription only, and
// Language Models configured the single-provider features (Voice Agent, Translation,
// Note Formatting, Chat). It stays a valid section — the same way "personal-notes"
// stays a valid view without a sidebar entry — so legacy aliases still resolve to
// something real, but there is no button that finds it. See settingsSections.ts.
const SECTIONS_WITHOUT_SIDEBAR_ENTRY = new Set(["llms"]);

test("every settings section is reachable from the sidebar, except the documented exceptions", () => {
  // The general form of the check above: a section only the URL can reach is a panel
  // the user cannot find. Anything exempted has to be listed and explained, or a
  // section could quietly lose its sidebar entry with nothing catching it.
  for (const id of SETTINGS_SECTION_IDS) {
    if (SECTIONS_WITHOUT_SIDEBAR_ENTRY.has(id)) continue;
    assert.match(
      sidebar,
      new RegExp(`id: "${id}"`),
      `the "${id}" section has no sidebar entry, so only a deep link can open it`
    );
  }
});

test("language models is gone from the sidebar on purpose", () => {
  // The inverse of the check above, for the one section that is meant to be missing:
  // this fails the moment someone re-adds the button without meaning to, the same way
  // the positive check fails when one goes missing by accident.
  assert.doesNotMatch(
    sidebar,
    /id: "llms"/,
    'the "llms" sidebar entry is back — Language Models was deliberately removed'
  );
});

test("the merge prompt is editable, and only from here", () => {
  assert.match(promptRegistry, /\n {2}reconcile: \{/, "there is no reconcile prompt kind to edit");
  assert.match(
    cleanupPanel,
    /<PromptStudio kind="reconcile" \/>/,
    "the Cleanup panel must render the prompt editor for the merge prompt"
  );

  // Exactly one home for it. Two editors for one prompt is how the settings page ended
  // up with three separate ideas of which providers were missing a key.
  const editors = [settingsPage, cleanupPanel, promptStudio].join("\n");
  const mounts = editors.match(/<PromptStudio kind="reconcile"/g) ?? [];
  assert.equal(mounts.length, 1, "the merge prompt should be editable in one place");
});

test("the dictation cleanup tab is gone, so its model has no second home", () => {
  // Deliberate removal, not an oversight: it configured a cleanup pass that a
  // multi-provider dictation does not run. Restoring the tab means two panels claiming
  // to own cleanup, which is the state this section exists to end.
  // Sliced from the opening bracket of the array, not from the declaration: the type
  // annotation contains "[]", so searching for the closing bracket from the start of the
  // line finds that one and the slice is empty — which made this check pass with the tab
  // restored, the exact vacuous guard it exists to avoid.
  const open =
    settingsPage.indexOf("const LLM_TABS: LlmTab[] = [") + "const LLM_TABS: LlmTab[] = [".length;
  const tabs = settingsPage.slice(open, settingsPage.indexOf("]", open));
  assert.match(tabs, /dictationAgent/, "could not read LLM_TABS — has the declaration moved?");
  assert.doesNotMatch(tabs, /dictationCleanup/, "the dictationCleanup tab is back");
});

test("the merge request is assembled in one place", () => {
  for (const [name, source] of [
    ["audioManager", audioManager],
    ["PromptStudio", promptStudio],
  ]) {
    assert.match(
      source,
      /buildReconcileRequest\(/,
      `${name} must build the merge request with the shared builder`
    );
    assert.doesNotMatch(
      source,
      /getReconcileSystemPrompt\(/,
      `${name} assembles the merge prompt itself, so it can drift from the other caller`
    );
  }
});

test("the merge model shown is the one that will be sent", () => {
  // A stored model the provider no longer serves is substituted at call time. Reading
  // the raw setting would display a model no request ever carries — the failure mode
  // resolveUsableModel exists to prevent, made visible in the UI.
  assert.match(
    promptStudio,
    /useSettingsStore\(selectEffectiveReconcileModel\)/,
    "the panel must display the healed model id, not the stored one"
  );
});

test("dual cleanup mode races two lanes, each carrying its own provider and model", () => {
  // Sliced from the reconcile lanes' construction to the race call: the whole point of
  // racing two merge models is comparing them, so slot B must reach the request builder
  // with its own settings, not slot A's. A version that hardcoded slot A onto both lanes
  // would still "work" — one model would just always answer for both — silently, since
  // nothing about the race would look broken. Sliced from a stable anchor rather than
  // matching the whole block verbatim, so unrelated edits in between don't rot this test.
  const start = audioManager.indexOf("const reconcileLanes = [");
  const end = audioManager.indexOf("awaitLanesWithBudget(", start);
  assert.ok(start > -1 && end > start, "could not find the reconcile race — has it moved?");
  const section = audioManager.slice(start, end);

  assert.match(section, /provider:\s*lane\.provider/, "each lane must send its own provider");
  assert.match(section, /model:\s*lane\.model/, "each lane must send its own model");
  assert.match(
    section,
    /getEffectiveReconcileModelB\(\)/,
    "slot B must read its own effective model, not slot A's"
  );
  assert.match(
    section,
    /if \(settings\.multiCleanupEnabled\)/,
    "slot B must only join the race when dual cleanup mode is on"
  );
});

test("the second model picker only renders when dual cleanup mode is on", () => {
  // A picker that always rendered would let the user set a slot B model that never
  // races anything while the toggle is off — a setting with no effect, and no visible
  // sign that it has none. There are two <ReconcileSlotPicker> uses in this file: the
  // first is slot A, always on screen; this pins that the second one — the one with
  // secondProvider/secondModel labels — is the one gated behind the toggle.
  assert.match(
    cleanupPanel,
    /\{multiCleanupEnabled && \(\s*<ReconcileSlotPicker[\s\S]{0,200}secondProvider/,
    "the second slot picker must be gated behind multiCleanupEnabled"
  );
});

test("a reconcile lane's real latency is still recorded after it loses the race", () => {
  // The loser is dropped from the paste path but must not be dropped from the stats —
  // that is the entire reason dual cleanup mode is worth measuring. This has to be a
  // continuation attached at lane creation, not code that runs after the race: code
  // after the race only sees lanes that already settled, and a lane that finishes after
  // its lane was dropped would never be recorded at all.
  assert.match(
    audioManager,
    /reconcileTracked\[index\]\.then\(\(\) => \{[\s\S]{0,200}recordModelLatency\(\s*"reconcile"/,
    "each reconcile lane must record its own latency independently of the race outcome"
  );
});

test("every locale has the section's strings", () => {
  const keys = [
    "settingsModal.sections.cleanup.label",
    "settingsPage.cleanup.title",
    "settingsPage.cleanup.description",
    "settingsPage.cleanup.multiDisabled",
    "settingsPage.transcription.multiMergeConfiguredInCleanup",
    "promptStudio.reconcile.versionLabel",
    "promptStudio.reconcile.defaultVersionA",
    "promptStudio.reconcile.defaultVersionB",
    "promptStudio.reconcile.needsTwoVersions",
    "promptStudio.reconcile.testHint",
    "promptStudio.reconcile.appendedAtDictation",
    "promptStudio.reconcile.noVocabulary",
    "promptStudio.reconcile.screenTermsNote",
  ];

  assert.ok(LOCALES.length > 1, "no locales found — the path must have moved");
  for (const locale of LOCALES) {
    const bundle = JSON.parse(read("src", "locales", locale, "translation.json"));
    for (const key of keys) {
      const value = lookup(bundle, key);
      assert.equal(typeof value, "string", `${locale} is missing ${key}`);
      assert.ok(value.trim(), `${locale}'s ${key} is empty`);
    }
    // The interpolation the version label depends on: without it the recogniser name
    // silently disappears from the label rather than failing.
    assert.match(
      lookup(bundle, "promptStudio.reconcile.versionLabel"),
      /\{\{recogniser\}\}/,
      `${locale}'s versionLabel drops the {{recogniser}} placeholder`
    );
  }
});
