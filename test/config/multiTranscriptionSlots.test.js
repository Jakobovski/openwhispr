const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// The slot count lives in MULTI_TRANSCRIPTION_SLOTS, and three separate things have to
// agree with it: the fan-out that runs the lanes, the settings UI that configures them,
// and the reconcile prompt that names a <version_x> tag per lane.
//
// Only the fan-out reads the config directly. The UI needs a hook per store field, and
// hooks cannot be called by mapping over an array, so its bindings are written out by
// hand — which means a fourth slot would have transcribed without ever appearing in
// Settings. These checks turn that silence into a failure.

const ROOT = path.join(__dirname, "..", "..");
const { MULTI_TRANSCRIPTION_SLOTS } = require("../../src/config/multiTranscription.ts");
const settingsPage = fs.readFileSync(
  path.join(ROOT, "src", "components", "SettingsPage.tsx"),
  "utf8"
);

test("the settings UI iterates the config rather than repeating it", () => {
  assert.match(
    settingsPage,
    /const multiSlots = MULTI_TRANSCRIPTION_SLOTS\.map\(/,
    "the slot list must come from the config"
  );
});

test("every configured slot has a UI binding", () => {
  const bindings = settingsPage.slice(
    settingsPage.indexOf("const slotBindings:"),
    settingsPage.indexOf("const multiSlots =")
  );

  for (const { slot } of MULTI_TRANSCRIPTION_SLOTS) {
    assert.match(
      bindings,
      new RegExp(`^\\s*${slot}: \\{`, "m"),
      `slot ${slot} has no entry in slotBindings, so Settings cannot configure it`
    );
  }
});

test("every configured slot has store fields and setters", () => {
  const store = fs.readFileSync(path.join(ROOT, "src", "stores", "settingsStore.ts"), "utf8");

  for (const { slot, providerKey, modelKey } of MULTI_TRANSCRIPTION_SLOTS) {
    // The persisted keys keep their historical "dual" names on purpose; what matters is
    // that each one the config names actually exists in the store.
    assert.ok(store.includes(providerKey), `${slot}: the store has no ${providerKey}`);
    assert.ok(store.includes(modelKey), `${slot}: the store has no ${modelKey}`);
  }
});

test("the slot count matches what the reconcile prompt can label", () => {
  // wrapReconcileVersions tags versions a, b, c… one per answering lane, and the prompt
  // has to describe every tag it might be handed. reconcilePrompt.test.js checks the
  // prompts; this checks the alphabet does not run out first.
  assert.ok(
    MULTI_TRANSCRIPTION_SLOTS.length <= 26,
    "more slots than letters would produce version_undefined tags"
  );
});
