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

test("mean and p95 are computed over the same samples as median, and p95 needs no math to check", () => {
  // 20 samples: 19 quick, one deliberately far out. p95 is defined as "the smallest
  // sample at or beyond the 95th percentile" — with exactly 20 samples that is the
  // 19th one once sorted, chosen so the answer is obvious by construction rather than
  // needing a percentile formula to verify the test itself.
  const db = freshDb();
  const fast = Array.from({ length: 19 }, () => 100);
  const samples = [...fast, 5000];
  for (const ms of samples) {
    db.recordModelLatency({ kind: "reconcile", provider: "openrouter", model: "inkling", ms });
  }

  const row = statFor(db, "openrouter");
  assert.equal(row.n, 20);
  assert.equal(row.median_ms, 100);
  assert.equal(row.p95_ms, 100, "the 19th of 20 sorted samples is still in the fast cluster");
  assert.equal(row.max_ms, 5000, "the outlier is still visible as the max");
  // Mean is dragged by the outlier in a way median and p95 are not — (19*100+5000)/20.
  assert.equal(row.mean_ms, Math.round((19 * 100 + 5000) / 20));
});

test("p95 with a single sample is that sample, not a divide-by-zero", () => {
  const db = freshDb();
  db.recordModelLatency({ kind: "reconcile", provider: "xai", model: "grok-4.5", ms: 640 });

  const row = statFor(db, "xai");
  assert.equal(row.p95_ms, 640);
  assert.equal(row.mean_ms, 640);
});

test("mean and p95 are null with no successful samples, same as median", () => {
  const db = freshDb();
  db.recordModelLatency({ kind: "reconcile", provider: "xai", model: "grok-4.5", ms: null, outcome: "failed" });

  const row = statFor(db, "xai");
  assert.equal(row.n, 0);
  assert.equal(row.mean_ms, null);
  assert.equal(row.p95_ms, null);
});

test("two reconcile rows for the same kind stay separate, one per model", () => {
  // The whole point of racing two merge models: their stats have to be comparable
  // side by side, which means never collapsed into one row for the shared "reconcile"
  // kind — grouping is (kind, provider, model), and this pins that it stays that way.
  const db = freshDb();
  db.recordModelLatency({ kind: "reconcile", provider: "openrouter", model: "inkling-small", ms: 300 });
  db.recordModelLatency({ kind: "reconcile", provider: "xai", model: "grok-4.5", ms: 700 });

  const stats = db.getModelLatencyStats().stats.filter((row) => row.kind === "reconcile");
  assert.equal(stats.length, 2);
  assert.ok(stats.some((row) => row.provider === "openrouter" && row.median_ms === 300));
  assert.ok(stats.some((row) => row.provider === "xai" && row.median_ms === 700));
});

test("streaming and batch never share a row, even for the same provider and model", () => {
  // The same provider can run either way, and the two numbers mean different things: a
  // batch sample is a whole request made after the recording ended, a streaming sample is
  // only the tail. Grouping is (kind, provider, model), so the kinds must keep them apart
  // — otherwise a 60ms streaming run would flatter a 3900ms batch median into nonsense.
  const db = freshDb();
  for (const ms of [3800, 3900, 4000]) {
    db.recordModelLatency({ kind: "transcription", provider: "soniox", model: "stt-v5", ms });
  }
  for (const ms of [60, 63, 70]) {
    db.recordModelLatency({
      kind: "transcriptionStreaming",
      provider: "soniox",
      model: "stt-v5",
      ms,
    });
  }

  const rows = db.getModelLatencyStats().stats.filter((r) => r.provider === "soniox");
  assert.equal(rows.length, 2, "the same provider/model must yield one row per kind");

  const batch = rows.find((r) => r.kind === "transcription");
  const streaming = rows.find((r) => r.kind === "transcriptionStreaming");
  assert.ok(batch && streaming, "both kinds must be present");
  assert.equal(batch.n, 3);
  assert.equal(streaming.n, 3);
  assert.equal(batch.median_ms, 3900, "the batch median must not be pulled down");
  assert.equal(streaming.median_ms, 63, "and the streaming median must not be pulled up");
});
