const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const store = require("../../src/helpers/screenContextTermsStore");

const ROOT = path.join(__dirname, "..", "..");

test.beforeEach(() => store.clear());

test("terms are returned for the dictation that recorded them", () => {
  store.record(41, { window: "Safari — PR", terms: ["OpenWhispr"], termCount: 1 });

  assert.deepEqual(store.getAll(), {
    41: { window: "Safari — PR", terms: ["OpenWhispr"], termCount: 1 },
  });
});

test("a missing or non-row id records nothing rather than colliding", () => {
  // The bug this replaced keyed on clientTranscriptionId, which the renderer only
  // knows on the OpenWhispr-cloud path — every BYOK dictation passed undefined, so
  // nothing was ever recorded, and the database minted a different id anyway.
  // Anything that is not a real row id must be refused loudly-by-omission here
  // rather than bucketed under a shared falsy key.
  for (const id of [undefined, null, "", 0, -1, "abc", NaN]) {
    store.record(id, { window: "W", terms: ["A"], termCount: 1 });
  }

  assert.deepEqual(store.getAll(), {});
});

test("a numeric string id lands on the same key as the number", () => {
  // IPC and JSON round-trips can turn a row id into a string; both must find it.
  store.record("57", { window: "W", terms: ["Sinead"], termCount: 1 });
  assert.deepEqual(store.getAll()["57"], { window: "W", terms: ["Sinead"], termCount: 1 });

  store.forget(57);
  assert.deepEqual(store.getAll(), {}, "forget by number clears a string-recorded id");
});

test("malformed detail is normalised instead of stored as-is", () => {
  store.record(3, { window: 42, terms: ["ok", 7, null, "fine"], termCount: "many" });

  assert.deepEqual(store.getAll()[3], { window: "", terms: ["ok", "fine"], termCount: 0 });
});

test("deleting a dictation drops its terms", () => {
  store.record(9, { window: "W", terms: ["A"], termCount: 1 });
  store.forget(9);
  assert.deepEqual(store.getAll(), {});
});

test("the store is bounded, dropping the oldest dictations first", () => {
  for (let i = 1; i <= store.MAX_ENTRIES + 40; i++) {
    store.record(i, { window: "W", terms: [`term-${i}`], termCount: 1 });
  }

  const all = store.getAll();
  assert.equal(Object.keys(all).length, store.MAX_ENTRIES);
  assert.equal(all[1], undefined, "oldest evicted");
  assert.deepEqual(all[store.MAX_ENTRIES + 40].terms, [`term-${store.MAX_ENTRIES + 40}`]);
});

test("the store lives in the main process, not a renderer module", () => {
  // The bug this replaced put the store in a renderer module. Dictation runs in the
  // overlay window and history renders in the control panel — separate renderer
  // processes, so the Map written by one was invisible to the other and the terms
  // could never appear. Only the main process is shared, so the store must stay
  // reachable from there: a renderer-only home is the defect, not a detail.
  const storePath = path.join(ROOT, "src", "helpers", "screenContextTermsStore.js");
  assert.ok(fs.existsSync(storePath), "the store must live under src/helpers (main process)");

  const handlers = fs.readFileSync(path.join(ROOT, "src", "helpers", "ipcHandlers.js"), "utf8");
  assert.match(handlers, /screen-context-record-terms/, "main must accept terms over IPC");
  assert.match(handlers, /screen-context-get-terms/, "main must serve terms over IPC");
});

test("nothing writes the terms to disk", () => {
  // The store is the only holder, and it must never gain a persistence path: the
  // terms are the contents of whatever window the user was dictating into.
  const source = fs.readFileSync(
    path.join(ROOT, "src", "helpers", "screenContextTermsStore.js"),
    "utf8"
  );

  // It imports nothing at all, which is the strongest form of this guarantee: with
  // no dependencies it cannot reach the filesystem, the database, or the network.
  // Checked against code with comments stripped, so prose about persistence — or a
  // word like "insertion" — cannot trip it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  assert.doesNotMatch(code, /\brequire\s*\(/, "the store must have no dependencies");
  assert.doesNotMatch(code, /\bimport\b/, "the store must have no dependencies");
  assert.doesNotMatch(code, /writeFile|appendFile|createWriteStream/, "no writes");
  assert.doesNotMatch(code, /\.prepare\s*\(|INSERT\s+INTO|localStorage/i, "no persistence");
});
