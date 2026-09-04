const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_RETENTION_SETTINGS,
  normalizeRetentionDays,
  applyRetentionSettings,
} = require("../../src/helpers/retentionSettings");

test("reports a change when a retention period is shortened", () => {
  assert.deepEqual(
    applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {
      audioRetentionDays: 1,
      transcriptRetentionDays: 1,
    }),
    {
      changed: true,
      settings: { audioRetentionDays: 1, transcriptRetentionDays: 1 },
    }
  );
});

test("never treats missing, fractional, or negative values as a request to disable retention", () => {
  for (const value of [null, "", "1.5", 1.5, -1, "-1"]) {
    assert.equal(normalizeRetentionDays(value, 30), 30);
  }
  assert.equal(normalizeRetentionDays("7", 30), 7);
  assert.equal(normalizeRetentionDays(0, 30), 0);
});

test("is idempotent when both values are unchanged — dual-window mount sync", () => {
  const { changed } = applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {
    audioRetentionDays: 30,
    transcriptRetentionDays: 0,
  });
  assert.equal(changed, false);
});

test("keeps the current value when an incoming value is missing or unusable", () => {
  const current = { audioRetentionDays: 7, transcriptRetentionDays: 1 };
  for (const incoming of [
    undefined,
    {},
    { audioRetentionDays: "abc", transcriptRetentionDays: -5 },
  ]) {
    assert.deepEqual(applyRetentionSettings(current, incoming), {
      changed: false,
      settings: current,
    });
  }
});
