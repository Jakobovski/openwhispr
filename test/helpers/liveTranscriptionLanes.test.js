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
  assert.match(method, /getProviderTerms\(lane\.provider, \{/);
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
  // Only a non-empty transcript is recorded, so a socket that connected but produced
  // nothing leaves the lane to its one-shot request rather than returning empty text.
  assert.match(collect, /if \(text\) \{/, "an empty transcript must not be collected");
  assert.match(
    collect,
    /collected\.set\(lane\.provider, \{/,
    "the transcript is keyed by provider"
  );

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

test("a streaming lane is timed from the end of the recording", () => {
  // Timing it from when the lane's request started would report almost nothing, because
  // the transcript was already being produced while the user spoke. What the user waits
  // is the tail after the last frame — measured at 63ms for Soniox on a 19s recording,
  // against 3859ms for the same provider's job queue.
  assert.match(
    audioManager,
    /this\._recordingStoppedAt = performance\.now\(\);/,
    "the end of the recording must be stamped"
  );
  const collect = audioManager.slice(
    audioManager.indexOf("async collectLiveTranscriptionLanes()"),
    audioManager.indexOf("async transcribeOneShotWithProvider(")
  );
  assert.match(
    collect,
    /performance\.now\(\) - \(this\._recordingStoppedAt/,
    "the tail must be measured from that stamp"
  );
  // Never negative, in case the stamp is missing on some path.
  assert.match(collect, /Math\.max\(\s*0,/, "a missing stamp must not produce a negative timing");
});

test("streaming and batch are recorded as different kinds", () => {
  // One is a whole request after the recording ended; the other is only the tail. Putting
  // them in one group would average 63ms with 3859ms and misrepresent both.
  assert.match(
    audioManager,
    /side\.streaming \? "transcriptionStreaming" : "transcription"/,
    "the recorded kind must depend on how the lane ran"
  );
  assert.match(
    audioManager,
    /streaming: ok \? result\.value\.streaming === true : false/,
    "the flag must survive onto the side the recorder reads"
  );

  // And the stats page needs a section for it, or the samples are collected and unseen.
  const view = read("src", "components", "ModelStatsView.tsx");
  assert.match(view, /"transcriptionStreaming"/, "the stats page must tabulate the new kind");
  const strings = JSON.parse(read("src", "locales", "en", "translation.json"));
  assert.ok(
    strings.modelStats.kinds.transcriptionStreaming,
    "the new kind needs a label or the heading renders as the key"
  );
});

test("the drop deadline is anchored to the recording's end", () => {
  // Without this the cutoff was measured from whichever lane answered first, so how long
  // the user waited depended on which one won: a batch lane answering at 900ms silently
  // granted every other lane 900ms more. Anchored to the tail it is the same wait every
  // time — which is the only version a person can reason about.
  assert.match(
    audioManager,
    /\{ deadlineAt: \(this\._recordingStoppedAt \?\? performance\.now\(\)\) \+ budgetMs \}/,
    "the fan-out must pass a deadline measured from the end of the recording"
  );
});

test("the live socket does not consume the screen capture at recording start", () => {
  // A regression this had: the socket opens about a millisecond after the OCR sidecar
  // starts, so asking for the capture there cannot succeed — and collecting is
  // destructive and caches its result, so a timed-out collection cached null and took the
  // screen terms away from the batch lanes and the correction matcher for the whole
  // dictation. The streaming lane still gets those corrections, applied to its transcript
  // afterwards instead of as a bias beforehand.
  const method = audioManager.slice(
    audioManager.indexOf("async startLiveTranscriptionLanes()"),
    audioManager.indexOf("  _feedLiveTranscriptionLanes(frame) {")
  );
  assert.match(
    method,
    /includeScreenTerms: false/,
    "the socket must not collect the screen capture"
  );
});

test("a failed screen capture is not cached over the whole dictation", () => {
  const ensure = audioManager.slice(
    audioManager.indexOf("async ensureScreenContext()"),
    audioManager.indexOf("async getProviderTerms(")
  );
  assert.match(
    ensure,
    /if \(capture\) this\._screenContext = capture;/,
    "only a real answer may be remembered, or one slow attempt decides the dictation"
  );
});

test("every provider's latency is measured from the end of the recording", () => {
  // The number that matters is what the user waits after they stop talking. Timing from
  // the start of the request hid the audio prep — trim, gain, resample, WAV encode — which
  // is real time, and made a streaming lane and a batch lane incomparable because each
  // started its own clock.
  const anchors =
    audioManager.match(/= this\._recordingStoppedAt \?\? performance\.now\(\)/g) ?? [];
  assert.ok(
    anchors.length >= 5,
    `every transcription path should anchor to the recording's end, saw ${anchors.length}`
  );
  // The per-call anchors these replaced must be gone.
  assert.doesNotMatch(
    audioManager,
    /const apiCallStart = performance\.now\(\);/,
    "a per-call anchor understates what the user waited"
  );
  assert.doesNotMatch(
    audioManager,
    /const transcriptionStart = performance\.now\(\);/,
    "same for the local and cloud paths"
  );
});

test("the anchor is cleared per recording and set by both stop paths", () => {
  // Without clearing, a dictation measures against whenever the *previous* one ended —
  // silently, and wrong by however long ago that was. And only the batch stop used to set
  // it, so a streaming dictation measured against the last batch recording.
  assert.match(
    audioManager,
    /this\._recordingStoppedAt = null;/,
    "the anchor must be cleared when a recording starts"
  );
  const setters =
    audioManager.match(/this\._recordingStoppedAt = (performance\.now\(\)|t0);/g) ?? [];
  assert.equal(setters.length, 2, "both the batch and the streaming stop paths must set it");
});

test("a lane timing can never be negative", () => {
  // The anchor is read with a fallback, so a path that never set it would otherwise be
  // able to produce a negative duration.
  assert.match(
    audioManager,
    /const elapsedSinceRecording = \(\) => Math\.max\(0,/,
    "lane timings must be clamped at zero"
  );
});

test("a non-batch (streaming) dictation is recorded too, from the recording's end", () => {
  // It was not recorded at all. The shared post-processing path files a sample for the
  // batch and multi routes, but the streaming route reports sttProcessingMs rather than
  // transcriptionProcessingDurationMs, so it never reached that code and streaming was
  // absent from Model Stats entirely.
  const stop = audioManager.slice(
    audioManager.indexOf("async stopStreamingRecording()"),
    audioManager.indexOf("const streamingAudioBytesSent")
  );
  assert.match(
    stop,
    /recordModelLatency\(\s*"transcriptionStreaming"/,
    "the streaming route must record a sample"
  );
  // t0 is the end of the recording, so the number is already the one that matters.
  assert.match(
    stop,
    /const streamingSttProcessingMs = Math\.round\(tTerminate - t0\)/,
    "and it must be measured from the recording's end"
  );
  assert.match(stop, /this\._recordingStoppedAt = t0;/, "t0 must be the recording-end anchor");
  // An empty transcript is a failure, not a fast success — otherwise a dead socket would
  // look like the best provider on the page.
  assert.match(stop, /finalText && finalText\.trim\(\) \? "ok" : "failed"/);
});

test("a streaming provider is one row, not split by which route ran it", () => {
  // gemini streams through the "gemini-live" entry, so keying the single-provider route's
  // stats on the internal streaming key would put it on a different row from the multi
  // live lane — the same provider, streaming the same way, reported twice.
  const stop = audioManager.slice(
    audioManager.indexOf("async stopStreamingRecording()"),
    audioManager.indexOf("const streamingAudioBytesSent")
  );
  assert.match(
    stop,
    /STREAMING_PROVIDER_BY_TRANSCRIPTION_PROVIDER\[stSettings\.cloudTranscriptionProvider\]\s*\n?\s*\?\s*stSettings\.cloudTranscriptionProvider/,
    "the configured provider should win when it maps to a streaming route"
  );
  // But routes with no transcription-provider equivalent still get named.
  assert.match(
    stop,
    /: this\.getStreamingProviderName\(\)/,
    "deepgram and friends need a fallback"
  );
});
