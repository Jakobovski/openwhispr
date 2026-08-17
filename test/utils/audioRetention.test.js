const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isAudioFile,
  selectOverflowFiles,
  transcriptionIdFromFilename,
} = require("../../src/utils/audioRetention.js");

const MB = 1024 * 1024;
const file = (name, sizeMb, mtimeMs) => ({ name, size: sizeMb * MB, mtimeMs });

test("nothing is removed while under budget", () => {
  const result = selectOverflowFiles([file("a.wav", 10, 1), file("b.wav", 10, 2)], 100 * MB);

  assert.deepEqual(result.remove, []);
  assert.equal(result.freedBytes, 0);
  assert.equal(result.totalBytes, 20 * MB);
});

test("exactly at budget removes nothing", () => {
  // A cap is a ceiling, not a target to dip below; deleting here would be gratuitous.
  const result = selectOverflowFiles([file("a.wav", 50, 1), file("b.wav", 50, 2)], 100 * MB);
  assert.deepEqual(result.remove, []);
});

test("oldest go first, and only as many as the overflow requires", () => {
  // Recent recordings are the ones worth retrying, so age decides.
  const result = selectOverflowFiles(
    [file("new.wav", 40, 3000), file("old.wav", 40, 1000), file("mid.wav", 40, 2000)],
    100 * MB
  );

  assert.deepEqual(result.remove, ["old.wav"], "one deletion brings 120MB under 100MB");
  assert.equal(result.freedBytes, 40 * MB);
});

test("keeps deleting until it is actually under the cap", () => {
  const result = selectOverflowFiles(
    [file("a.wav", 30, 1), file("b.wav", 30, 2), file("c.wav", 30, 3), file("d.wav", 30, 4)],
    50 * MB
  );

  assert.deepEqual(result.remove, ["a.wav", "b.wav", "c.wav"]);
  assert.equal(result.totalBytes - result.freedBytes, 30 * MB);
});

test("non-audio files are neither counted nor deleted", () => {
  // The folder can pick up .DS_Store and partial writes; deleting those is not this
  // function's job, and counting them would evict real recordings early.
  const result = selectOverflowFiles(
    [file(".DS_Store", 90, 1), file("notes.txt", 90, 2), file("keep.wav", 10, 3)],
    50 * MB
  );

  assert.deepEqual(result.remove, []);
  assert.equal(result.totalBytes, 10 * MB);
});

test("both encodings the app has written are recognised", () => {
  // Dictation wrote WebM/Opus before it captured PCM; a cap that saw only one of them
  // would let the other accumulate untouched.
  assert.equal(isAudioFile("OpenWhispr-2026-08-17-15-44-04-289.wav"), true);
  assert.equal(isAudioFile("OpenWhispr-2026-07-30-10-00-00-12.webm"), true);
  assert.equal(isAudioFile("OpenWhispr-1.wav".toUpperCase()), true, "case insensitive");
  assert.equal(isAudioFile(".DS_Store"), false);
});

test("a zero or missing cap disables the sweep rather than deleting everything", () => {
  const files = [file("a.wav", 10, 1)];
  assert.deepEqual(selectOverflowFiles(files, 0).remove, []);
  assert.deepEqual(selectOverflowFiles(files, undefined).remove, []);
  assert.deepEqual(selectOverflowFiles(files, NaN).remove, []);
});

test("ids are recovered from timestamped and legacy filenames", () => {
  assert.equal(transcriptionIdFromFilename("OpenWhispr-2026-08-17-15-44-04-289.wav"), "289");
  assert.equal(transcriptionIdFromFilename("OpenWhispr-289.webm"), "289");
  assert.equal(transcriptionIdFromFilename("289.webm"), "289");
});

test("empty input is safe", () => {
  assert.deepEqual(selectOverflowFiles([], 100).remove, []);
  assert.deepEqual(selectOverflowFiles(null, 100).remove, []);
});
