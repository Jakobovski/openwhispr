const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Guards the rule that a setting has exactly one default.
//
// Every bug this file exists to prevent had the same shape: the same value written
// down twice, so the settings UI, the code that resolves the setting, and the
// default a fresh install gets could disagree without anyone touching them.
// Real instances, all shipped: a dictation went to OpenAI twice while xAI never ran
// (a stored slot colliding with a changed slot default); cleanup called a retired
// model (a getter returning the raw stored id while the picker showed a healed one);
// the second-provider wait budget existed as two constants and the store's copy
// silently won; and the Parakeet model id was spelled out in six places across the
// renderer, the main process and the IPC layer.
//
// The store is the only place allowed to say what a setting defaults to. Anything
// outside it that needs the default imports src/config/settingsDefaults.json.
//
// These checks are static text scans on purpose: they run without a DOM, without
// Electron and without importing the store, so they hold in CI and cannot be
// satisfied by a mock.

const ROOT = path.join(__dirname, "..", "..");
const STORE_PATH = path.join(ROOT, "src", "stores", "settingsStore.ts");
const TABLE_PATH = path.join(ROOT, "src", "config", "settingsDefaults.json");

const table = JSON.parse(fs.readFileSync(TABLE_PATH, "utf8"));
const storeSource = fs.readFileSync(STORE_PATH, "utf8");

/** Every source file the app ships, minus build output and the store itself. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "dist" || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!/\.(js|jsx|ts|tsx)$/.test(entry.name)) continue;
      if (full === STORE_PATH) continue;
      out.push(full);
    }
  };
  walk(path.join(ROOT, "src"));
  return out;
}

const FILES = sourceFiles().map((file) => ({
  file,
  rel: path.relative(ROOT, file),
  source: fs.readFileSync(file, "utf8"),
}));

/** key -> default expression, as the store's initial state declares it. */
function storeDefaults() {
  const defaults = new Map();
  const pattern =
    /(\w+):\s*read(?:String|Boolean|Number)\(\s*"(\w+)"\s*,\s*([^,)]+(?:\([^)]*\))?)\)/g;
  for (const match of storeSource.matchAll(pattern)) {
    defaults.set(match[2], { property: match[1], expression: match[3].trim() });
  }
  return defaults;
}

const DEFAULTS = storeDefaults();

// A fallback of empty/zero/false normalises a missing value for a comparison or a
// trim; it does not assert what the setting should be, so it is not a second default.
const NORMALISERS = new Set(['""', "''", "0", "false", "null", "undefined", "[]", "{}"]);

// Exceptions must name the reason. An empty list is the goal, not an accident.
const ALLOWED_SECOND_DEFAULTS = [
  // e.g. { rel: "src/x.ts", key: "someKey", why: "..." }
];

// A default's value may also be one option in a list the user picks from. That is a
// coincidence of value, not a second default: the list is not consulted to decide
// what a blank setting means.
const ALLOWED_LITERAL_COPIES = [
  {
    rel: "src/components/EnterpriseProviderConfig.tsx",
    values: ["us-east-1", "us-central1"],
    why: "AWS/Vertex region pickers list every region, one of which is the default",
  },
];

test("the store's read helpers cannot disagree with the key they read", () => {
  // A copy-paste that leaves the property name pointing at another key's storage
  // slot makes the UI edit one setting and the runtime read another.
  const mismatched = [...DEFAULTS.entries()]
    .filter(([key, { property }]) => property !== key)
    .map(([key, { property }]) => `${property} reads "${key}"`);

  assert.deepEqual(mismatched, []);
});

test("no setting is read twice in the store with different defaults", () => {
  const seen = new Map();
  const pattern = /read(?:String|Boolean|Number)\(\s*"(\w+)"\s*,\s*([^,)]+(?:\([^)]*\))?)\)/g;
  for (const match of storeSource.matchAll(pattern)) {
    const [key, expression] = [match[1], match[2].trim()];
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(expression);
  }

  const divergent = [...seen.entries()]
    .filter(([, expressions]) => expressions.size > 1)
    .map(([key, expressions]) => `${key}: ${[...expressions].join(" vs ")}`);

  assert.deepEqual(divergent, []);
});

test("every value in the shared table is what the store actually seeds", () => {
  // The table is only useful if the store reads from it. A key listed here whose
  // store default is still a literal is two defaults again, one of them unused.
  const wrong = [];
  for (const key of Object.keys(table.storeDefaults)) {
    const entry = DEFAULTS.get(key);
    if (!entry) {
      wrong.push(`${key}: listed in settingsDefaults.json but the store never reads it`);
      continue;
    }
    const expected = `settingsDefaults.storeDefaults.${key}`;
    if (entry.expression !== expected) {
      wrong.push(`${key}: store seeds ${entry.expression}, expected ${expected}`);
    }
  }

  assert.deepEqual(wrong, []);
});

test("nothing outside the store supplies its own default for a setting", () => {
  // The check that catches the next one of these: `settings.foo || "bar"` anywhere
  // outside the store is a second default that only fires when the stored value is
  // empty, which is why these bugs appear on some installs and not others.
  const violations = [];

  for (const { rel, source } of FILES) {
    for (const key of DEFAULTS.keys()) {
      const pattern = new RegExp(
        `\\.${key}\\s*(?:\\|\\||\\?\\?)\\s*("[^"]*"|'[^']*'|[\\d.]+|true|false|null)`,
        "g"
      );
      for (const match of source.matchAll(pattern)) {
        const literal = match[1].replace(/'/g, '"');
        if (NORMALISERS.has(literal)) continue;
        if (ALLOWED_SECOND_DEFAULTS.some((entry) => entry.rel === rel && entry.key === key))
          continue;
        violations.push(
          `${rel}: ${key} falls back to ${literal} — import settingsDefaults.json instead`
        );
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("a default in the shared table is never spelled out as a literal", () => {
  // The Parakeet case: the same model id written into six files, so changing the
  // default changed only some of them. One declaration, every reader imports it.
  const values = [
    ...Object.values(table.storeDefaults),
    ...Object.values(table.resolutionDefaults),
  ].filter((value) => typeof value === "string" && value.length > 3);

  const violations = [];
  for (const { rel, source } of FILES) {
    for (const value of values) {
      // Only flag ids distinctive enough that a bare copy is certainly this default,
      // not an unrelated string that happens to match a short word like "base".
      if (!/[-.]/.test(value)) continue;
      const excused = ALLOWED_LITERAL_COPIES.some(
        (entry) => entry.rel === rel && entry.values.includes(value)
      );
      if (excused) continue;
      if (source.includes(`"${value}"`)) {
        violations.push(`${rel}: "${value}" is a shared default — import it`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("a fresh install and a cleared setting resolve to the same thing", () => {
  // The reinstall case. readString only falls back when a key is *absent*, so a key
  // present but empty took a different path through the app than a fresh profile —
  // which is how the duplicate-provider bug hid: it needed one stored slot and one
  // unstored slot to appear.
  const { resolveMultiTranscriptionLanes } = require("../../src/config/dualTranscription.ts");

  const fresh = resolveMultiTranscriptionLanes({});
  const cleared = resolveMultiTranscriptionLanes({
    dualTranscriptionProviderA: "",
    dualTranscriptionProviderB: "",
    dualTranscriptionProviderC: "",
    dualTranscriptionModelA: "",
    dualTranscriptionModelB: "",
    dualTranscriptionModelC: "",
  });

  assert.deepEqual(cleared, fresh);
});
