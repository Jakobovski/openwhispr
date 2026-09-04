const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const windowConfig = require(path.join(ROOT, "src", "helpers", "windowConfig"));
const audioManager = fs.readFileSync(path.join(ROOT, "src", "helpers", "audioManager.js"), "utf8");

test("push-to-talk does not deliberately clip the beginning of speech", () => {
  assert.ok(
    windowConfig.PUSH_TO_TALK_START_DELAY_MS <= 100,
    `push-to-talk waits ${windowConfig.PUSH_TO_TALK_START_DELAY_MS}ms before opening the mic`
  );
});

test("batch recording opens the microphone before starting OCR or live sockets", () => {
  const start = audioManager.indexOf("async startRecording(forceDefaultMic = false)");
  const end = audioManager.indexOf("\n  createBatchRecorder(micStream)", start);
  assert.ok(start >= 0 && end > start, "could not isolate startRecording");
  const section = audioManager.slice(start, end);

  const mic = section.indexOf("navigator.mediaDevices.getUserMedia");
  const recorder = section.indexOf("this.createBatchRecorder(micStream)");
  const ocr = section.indexOf("this.startScreenContextCapture()");
  const sockets = section.indexOf("this.startLiveLanesForThisRecording()");
  assert.ok(mic >= 0 && recorder > mic, "microphone capture must precede recorder setup");
  assert.ok(ocr > recorder, "OCR must not contend with opening the microphone");
  assert.ok(sockets > recorder, "socket setup must not contend with opening the microphone");
});
