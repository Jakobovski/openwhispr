const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const audioManager = read("src", "helpers", "audioManager.js");

// Measured, and the numbers are the whole reason this exists. For 19.1s of speech:
//
//   async job queue, after the stop      3859ms   (3.3s of it waiting on the job)
//   realtime socket, blasted after stop 15320ms   (it processes at ~real time)
//   realtime socket, fed while talking  ~700ms after the last frame
//
// So a streaming provider is only fast if it is fed during the recording. Sending the
// finished recording at a socket is worse than the job queue, not better.

test("live lanes are started before the mic, alongside the screen capture", () => {
  // The socket takes ~130ms to connect. Starting it after the mic would put that on the
  // recording's critical path; starting it here means frames captured before it is ready
  // are buffered instead.
  const start = audioManager.indexOf("async startRecording(");
  const region = audioManager.slice(start, start + 1200);
  assert.match(region, /startLiveTranscriptionLanes\(\)/, "live lanes must start here");

  const ocrAt = region.indexOf("startScreenContextCapture()");
  const lanesAt = region.indexOf("startLiveTranscriptionLanes()");
  const micAt = region.indexOf("getUserMedia");
  assert.ok(ocrAt > 0 && lanesAt > 0 && micAt > 0, "could not read the start sequence");
  assert.ok(lanesAt < micAt, "the socket must be opened before the mic is acquired");
});

test("the start is not awaited, so a slow connect cannot delay the mic", () => {
  assert.match(
    audioManager,
    /void this\.startLiveTranscriptionLanes\(\);/,
    "awaiting it would put connect latency on the recording path"
  );
});

test("only providers set to streaming get a live lane", () => {
  const method = audioManager.slice(
    audioManager.indexOf("async startLiveTranscriptionLanes()"),
    audioManager.indexOf("  _feedLiveTranscriptionLanes(frame) {")
  );
  assert.match(
    method,
    /providerWantsStreaming\(lane\.provider, settings\)/,
    "the mode setting decides, not the provider's capability"
  );
  assert.match(method, /multiTranscriptionEnabled !== true/, "only in multi mode");
  // The vocabulary has to be supplied at start: these providers bias before they listen,
  // so passing it afterwards would be too late to matter.
  assert.match(method, /getProviderTerms\(lane\.provider\)/);
});

test("the recorder's own frames feed the sockets", () => {
  // Reusing the batch recorder's frames rather than opening a second capture: two audio
  // graphs on one mic is how you get drift between what was transcribed and what was
  // saved.
  assert.match(
    audioManager,
    /new PcmBatchRecorder\(micStream, \(frame\) => \{[\s\S]{0,300}_feedLiveTranscriptionLanes\(frame\)/,
    "frames must be teed from the existing recorder"
  );
});

test("frames are converted once for all lanes, not per socket", () => {
  const method = audioManager.slice(
    audioManager.indexOf("  _feedLiveTranscriptionLanes(frame) {"),
    audioManager.indexOf("async collectLiveTranscriptionLanes()")
  );
  const conversions = method.match(/floatToPcm16\(/g) ?? [];
  assert.equal(conversions.length, 1, "one conversion, not one per lane");
  // Counting alone was vacuous: a single call *inside* the loop also counts once, and is
  // exactly the per-socket conversion this is meant to prevent. Position is the test.
  const convertAt = method.indexOf("floatToPcm16(");
  const loopAt = method.indexOf("for (const lane of");
  assert.ok(convertAt > -1 && loopAt > -1, "could not read the feed method");
  assert.ok(convertAt < loopAt, "the conversion must happen before the loop over lanes");
});

test("a lane that fails to start or returns nothing falls back to its one-shot path", () => {
  // A streaming socket is an optimisation. If it does not work the dictation must still
  // produce a transcript, not silently lose that lane.
  const startMethod = audioManager.slice(
    audioManager.indexOf("async startLiveTranscriptionLanes()"),
    audioManager.indexOf("  _feedLiveTranscriptionLanes(frame) {")
  );
  assert.match(startMethod, /falling back to batch/, "a failed start must be logged and skipped");

  const collect = audioManager.slice(
    audioManager.indexOf("async collectLiveTranscriptionLanes()"),
    audioManager.indexOf("async transcribeOneShotWithProvider(")
  );
  assert.match(collect, /if \(text\) collected\.set/, "only a non-empty transcript counts");

  // And the fan-out must treat an absent live transcript as "do the request".
  assert.match(
    audioManager,
    /liveText: liveText\.get\(lane\.provider\)/,
    "the lane is handed its live transcript, if any"
  );
});

test("a live transcript skips the upload but is still echo-checked", () => {
  const region = audioManager.slice(
    audioManager.indexOf("async transcribeRawWithProvider("),
    audioManager.indexOf("\n    let text;")
  );
  assert.match(region, /if \(liveText\) \{/, "a live transcript short-circuits the request");
  assert.match(
    region,
    /!this\.isDictionaryEcho\(trimmedLive\)/,
    "the same silence guard the one-shot path applies"
  );
  // Latency is recorded once, by the fan-out, from multi.sides.
  const shortCircuit = region.slice(region.indexOf("if (liveText) {"));
  assert.doesNotMatch(
    shortCircuit,
    /recordModelLatency/,
    "recording here too would count this lane twice"
  );
});

test("closing the sockets overlaps the trim rather than blocking it", () => {
  // Both have to happen before the fan-out; doing them in sequence would add the
  // socket's closing wait to the trim's.
  const region = audioManager.slice(
    audioManager.indexOf("const liveTextPromise"),
    audioManager.indexOf("const settled = lanes.map(() => null)")
  );
  assert.match(region, /const liveTextPromise = this\.collectLiveTranscriptionLanes\(\)/);
  const promiseAt = region.indexOf("liveTextPromise =");
  const trimAt = region.indexOf("prepareAudioForUpload");
  const awaitAt = region.indexOf("await liveTextPromise");
  assert.ok(promiseAt < trimAt && trimAt < awaitAt, "the trim must run while the sockets close");
});

test("a secret saved in one window reaches the others", () => {
  // The bug this fixes: secrets are deliberately kept out of localStorage, so they cannot
  // ride the storage event the rest of the settings sync on. A key entered in the control
  // panel stayed invisible to the window that transcribes until the app restarted — which
  // is how "No gemini API key configured" was logged four minutes after the key was saved.
  const ipc = read("src", "helpers", "ipcHandlers.js");
  assert.match(ipc, /win\.webContents\.send\("secret-key-updated"/, "main must broadcast");
  assert.match(
    ipc,
    /win\.webContents === event\.sender/,
    "the window that saved it should not be told again"
  );

  const store = read("src", "stores", "settingsStore.ts");
  assert.match(store, /onSecretKeyUpdated\?\.\(/, "the store must listen");
  assert.match(store, /useSettingsStore\.setState\(\{ \[storeKey\]: key \?\? "" \}\)/);

  const preload = read("preload.js");
  assert.match(preload, /onSecretKeyUpdated/, "preload must bridge it");

  // Still not in localStorage: that is what keeps it out of plain disk.
  assert.match(
    store,
    /STALE_SECRET_LOCALSTORAGE_KEYS/,
    "secrets must still be scrubbed from localStorage"
  );
});
