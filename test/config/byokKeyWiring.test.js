const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Adding a BYOK provider should be one entry in BYOK_API_KEYS and nothing else. It is
// not quite, because the settings store still declares each key's field, setter and
// saver by hand — so these checks exist to make the remaining hand-written places fail
// loudly rather than silently.
//
// The failure they are written against actually shipped: Azure Speech was added to
// BYOK_API_KEYS with its key in the build, but the store's startup hydration was a
// hardcoded list of getters that did not mention it. The field stayed empty, and
// isMultiTranscriptionEnabled treats a lane with no key as unusable — so multi
// transcription turned itself off with no error anywhere, and the settings UI reported
// a missing key for a key that was present.
//
// Static scans because the wiring spans a preload sandbox, a zustand store and the main
// process; a unit test with any of those mocked would miss exactly this class of gap.

const ROOT = path.join(__dirname, "..", "..");
const { BYOK_API_KEYS } = require("../../src/config/secretKeys");

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const store = read("src", "stores", "settingsStore.ts");
const preload = read("preload.js");
const settingsTypes = read("src", "hooks", "useSettings.ts");
const electronTypes = read("src", "types", "electron.ts");

test("the table is not empty and every entry is fully specified", () => {
  assert.ok(BYOK_API_KEYS.length > 0);
  for (const entry of BYOK_API_KEYS) {
    for (const field of ["base", "env", "get", "save", "storeKey"]) {
      assert.ok(entry[field], `${entry.base ?? "?"} is missing "${field}"`);
    }
  }
});

test("startup hydration is derived from the table, not hand-listed", () => {
  // The specific regression: a hand-written list of getters that someone forgets to
  // extend. Deriving it means a new entry is loaded without anyone remembering to.
  assert.match(
    store,
    /BYOK_API_KEYS\.map\(\(entry\)\s*=>/,
    "the store must iterate BYOK_API_KEYS to fetch keys at startup"
  );
  assert.match(
    store,
    /BYOK_API_KEYS\.forEach\(\(entry, index\)\s*=>/,
    "the store must iterate BYOK_API_KEYS to apply the fetched values"
  );

  // And no leftover per-key getter calls, which would mean the list came back.
  for (const entry of BYOK_API_KEYS) {
    const call = new RegExp(`window\\.electronAPI\\.${entry.get}\\?\\.\\(\\)`);
    assert.doesNotMatch(
      store,
      call,
      `${entry.get} is still called by hand — hydration should come from the table`
    );
  }
});

test("every key has a store field, a setter and a saver", () => {
  for (const { base, storeKey, save } of BYOK_API_KEYS) {
    assert.ok(store.includes(`${storeKey}: ""`), `${storeKey} has no initial value in the store`);
    const setter = `set${storeKey[0].toUpperCase()}${storeKey.slice(1)}`;
    assert.ok(store.includes(setter), `${base} has no ${setter}`);
    // Checked by the save function's name rather than the map key: most entries are
    // keyed by base, corti by its store key, and either persists correctly. What must
    // hold is that the setter has an IPC channel to write through at all.
    assert.ok(
      store.includes(`"${save}"`),
      `${base} is missing from SECRET_IPC_SAVERS, so its setter cannot persist`
    );
  }
});

test("every key is bridged through preload", () => {
  // preload cannot require local modules under sandbox, so it mirrors the table inline.
  // A key missing here reaches the store as undefined rather than failing.
  for (const { base, get, save } of BYOK_API_KEYS) {
    assert.match(
      preload,
      new RegExp(`base: "${base}"`),
      `${base} is missing from BYOK_KEY_BRIDGES in preload.js`
    );
    assert.ok(preload.includes(get), `${get} is not bridged`);
    assert.ok(preload.includes(save), `${save} is not bridged`);
  }
});

test("every key is typed, or TypeScript cannot catch the next omission", () => {
  for (const { storeKey, get } of BYOK_API_KEYS) {
    assert.ok(
      settingsTypes.includes(`${storeKey}: string;`),
      `${storeKey} is missing from ApiKeySettings`
    );
    assert.ok(electronTypes.includes(get), `${get} is not declared on electronAPI`);
  }
});

test("every key's env var is a secret, so it is stored encrypted", () => {
  // SECRET_KEYS is spread from the same table, so this is really a guard against
  // someone replacing that spread with a literal list.
  const environment = read("src", "helpers", "environment.js");
  assert.match(
    environment,
    /\.\.\.BYOK_API_KEYS\.map\(\(k\)\s*=>\s*k\.env\)/,
    "SECRET_KEYS must be derived from the table"
  );
});

test("every lane's key field is in the settings page's own key map", () => {
  // A third hand-maintained list, and the one that produced a false alarm: the settings
  // page builds its own {apiKeyField: value} map to decide which lanes are missing a
  // key. Azure Speech was absent, so the warning claimed a missing key for a key that
  // was present — and nothing caught it, because the transcription path never reads
  // this map, so the lane worked while the UI said it could not.
  const { MULTI_TRANSCRIPTION_PROVIDERS } = require("../../src/config/multiTranscription.ts");
  const settingsPage = read("src", "components", "SettingsPage.tsx");

  const map = settingsPage.slice(
    settingsPage.indexOf("const dualApiKeys: Record<string, string> = {"),
    settingsPage.indexOf(
      "};",
      settingsPage.indexOf("const dualApiKeys: Record<string, string> = {")
    )
  );

  for (const provider of MULTI_TRANSCRIPTION_PROVIDERS) {
    assert.match(
      map,
      new RegExp(`\\b${provider.apiKeyField}\\b`),
      `${provider.id}'s ${provider.apiKeyField} is missing from dualApiKeys, so the ` +
        `settings page will report its key missing even when it is set`
    );
  }
});
