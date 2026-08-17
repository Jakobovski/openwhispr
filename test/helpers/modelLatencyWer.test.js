const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-wer-db-"));
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => userDataDir, isPackaged: false } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const DatabaseManager = require("../../src/helpers/database.js");
Module._load = originalLoad;

// The stats row is what the user reads to decide which provider to keep, so the rules
// about when a rate exists at all matter as much as the arithmetic.

function freshDb() {
  // The constructor opens the database; only the table needs clearing between tests.
  const db = new DatabaseManager();
  db.clearModelLatency();
  return db;
}

const statFor = (db, provider) =>
  db.getModelLatencyStats().stats.find((row) => row.provider === provider);

test("a rate is stored and returned as a median", () => {
  const db = freshDb();
  for (const wer of [0.1, 0.2, 0.3]) {
    db.recordModelLatency({
      kind: "transcription",
      provider: "xai",
      model: "grok-stt",
      ms: 500,
      wer,
    });
  }

  const row = statFor(db, "xai");
  assert.equal(row.wer_n, 3);
  assert.ok(Math.abs(row.median_wer - 0.2) < 1e-9, `expected 0.2, got ${row.median_wer}`);
});

test("a lane with timings but no merged dictation has no rate", () => {
  // The distinction the column depends on: plenty of samples, nothing to score against.
  // Reporting 0 here would read as a flawless provider.
  const db = freshDb();
  db.recordModelLatency({ kind: "transcription", provider: "groq", model: "whisper", ms: 800 });
  db.recordModelLatency({ kind: "transcription", provider: "groq", model: "whisper", ms: 900 });

  const row = statFor(db, "groq");
  assert.equal(row.n, 2, "the timings are still recorded");
  assert.equal(row.wer_n, 0);
  assert.equal(row.median_wer, null);
});

test("a perfect score is kept, not confused with an absent one", () => {
  const db = freshDb();
  db.recordModelLatency({
    kind: "transcription",
    provider: "openai",
    model: "gpt",
    ms: 600,
    wer: 0,
  });

  const row = statFor(db, "openai");
  assert.equal(row.wer_n, 1);
  assert.equal(row.median_wer, 0);
});

test("the median is taken over rates, not over the latency ordering", () => {
  // The query sorts by ms because the timing stats need it. Sorting the rates by
  // whichever call happened to be fastest would report an arbitrary sample as the median.
  const db = freshDb();
  const samples = [
    { ms: 100, wer: 0.9 },
    { ms: 200, wer: 0.1 },
    { ms: 300, wer: 0.5 },
  ];
  for (const { ms, wer } of samples) {
    db.recordModelLatency({
      kind: "transcription",
      provider: "azure-speech",
      model: "mai",
      ms,
      wer,
    });
  }

  const row = statFor(db, "azure-speech");
  assert.ok(Math.abs(row.median_wer - 0.5) < 1e-9, `expected 0.5, got ${row.median_wer}`);
});

test("a rate above one survives the round trip", () => {
  // A lane that returned something unrelated scores above 1. Clamping or dropping it
  // would hide the worst outlier the table exists to surface.
  const db = freshDb();
  db.recordModelLatency({
    kind: "transcription",
    provider: "xai",
    model: "grok-stt",
    ms: 500,
    wer: 2.5,
  });

  assert.ok(Math.abs(statFor(db, "xai").median_wer - 2.5) < 1e-9);
});

test("a dropped lane still contributes its rate if it had one", () => {
  // Outcome and scoring are independent: a lane can answer late enough to be dropped
  // from the merge, and separately be worth scoring when it did answer.
  const db = freshDb();
  db.recordModelLatency({
    kind: "transcription",
    provider: "openrouter",
    model: "mai",
    ms: 0,
    outcome: "dropped",
    wer: 0.4,
  });

  const row = statFor(db, "openrouter");
  assert.equal(row.dropped, 1);
  assert.equal(row.n, 0, "a drop is not a timing sample");
  assert.equal(row.wer_n, 1);
});
