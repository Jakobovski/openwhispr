const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  LiveTranscriptionLanes,
  LIVE_LANE_CLOSE_BUDGET_MS,
} = require("../../src/helpers/liveTranscriptionLanes");

// Exercised through fake provider APIs rather than by grepping audioManager, which is
// what these tests used to do. The behaviour that matters is timing and ordering — a
// socket that never comes up, one that answers nothing, a take that is cancelled — and
// text matching cannot see any of it.
//
// The numbers behind the design, measured for 19.1s of speech:
//   async job queue, after the stop      3859ms
//   realtime socket, blasted after stop 15320ms
//   realtime socket, fed while talking   ~60ms after the last frame

function fakeApi(behaviour = {}) {
  const calls = { start: [], sent: [], finalize: 0, stop: 0 };
  let onError = null;
  return {
    calls,
    emitError: (message) => onError?.(message),
    api: {
      start: async (options) => {
        calls.start.push(options);
        if (behaviour.startDelayMs) {
          await new Promise((r) => setTimeout(r, behaviour.startDelayMs));
        }
        return behaviour.startResult ?? { success: true };
      },
      send: (buffer) => {
        if (behaviour.sendThrows) throw new Error("socket dead");
        calls.sent.push(buffer);
      },
      finalize: () => {
        calls.finalize += 1;
      },
      stop: async () => {
        calls.stop += 1;
        if (behaviour.stopHangs) return new Promise(() => {});
        if (behaviour.stopRejects) throw new Error("stop blew up");
        if (behaviour.stopDelayMs) await new Promise((r) => setTimeout(r, behaviour.stopDelayMs));
        return behaviour.stopResult ?? { text: "hello there" };
      },
      onError: (cb) => {
        onError = cb;
        return () => {
          onError = null;
        };
      },
    },
  };
}

function build(behaviour) {
  const fake = fakeApi(behaviour);
  const warnings = [];
  const lanes = new LiveTranscriptionLanes({
    providers: { "soniox-rt": fake.api },
    keyByProvider: { soniox: "soniox-rt" },
    logger: { warn: (message, meta) => warnings.push({ message, ...meta }) },
  });
  return { lanes, fake, warnings };
}

const frame = (n = 4) => Float32Array.from({ length: n }, (_, i) => (i % 2 ? 0.5 : -0.5));

test("a lane opens with the language and terms, and no model", () => {
  // The model is the caller's *batch* model and a streaming socket rejects it: Soniox
  // answers "Specified model stt-async-v5 does not support real-time transcription" and
  // closes, after which the lane looks merely slow and gets dropped.
  return (async () => {
    const { lanes, fake } = build();
    await lanes.start([{ provider: "soniox", model: "stt-async-v5" }], {
      language: "en",
      termsFor: async () => ["OpenWhispr"],
    });

    assert.equal(fake.calls.start.length, 1);
    const options = fake.calls.start[0];
    assert.equal(options.language, "en");
    assert.deepEqual(options.vocabulary, ["OpenWhispr"]);
    assert.equal(options.sampleRate, 16000);
    assert.ok(!("model" in options), "the batch model must not reach the streaming socket");
  })();
});

test("frames are converted once and forwarded to every lane", async () => {
  const { lanes, fake } = build();
  await lanes.start([{ provider: "soniox" }], { termsFor: async () => [] });

  lanes.feed(frame(4));
  assert.equal(fake.calls.sent.length, 1);
  // PCM16: two bytes per sample.
  assert.equal(fake.calls.sent[0].byteLength, 8);

  // Nothing is sent for an empty frame, or once the lanes are closed.
  lanes.feed(new Float32Array(0));
  lanes.feed(null);
  assert.equal(fake.calls.sent.length, 1);
});

test("a dead socket does not interrupt the recording", async () => {
  const { lanes } = build({ sendThrows: true });
  await lanes.start([{ provider: "soniox" }], { termsFor: async () => [] });
  assert.doesNotThrow(() => lanes.feed(frame()));
});

test("closing returns the transcript, timed from the recording's end", async () => {
  const { lanes, fake } = build({ stopResult: { text: "  hello there  " } });
  await lanes.start([{ provider: "soniox" }], { termsFor: async () => [] });

  const anchor = performance.now();
  const closing = lanes.close(anchor);
  const result = await closing.get("soniox");

  assert.equal(fake.calls.finalize, 1, "the utterance must be finalized before stopping");
  assert.equal(result.text, "hello there", "and the text trimmed");
  assert.ok(
    result.ms >= 0 && result.ms < 500,
    `ms ${result.ms} should be measured from the anchor`
  );
});

test("closing hands back one promise per provider rather than one combined wait", () => {
  // The caller races these against the same deadline as its batch lanes. Awaiting them as
  // a group is what let a dead socket stall the dictation, and then let the close budget
  // come out of the budget shared with the batch lanes and starve them.
  return (async () => {
    const { lanes } = build();
    await lanes.start([{ provider: "soniox" }], { termsFor: async () => [] });
    const closing = lanes.close(performance.now());
    assert.ok(closing instanceof Map);
    assert.ok(closing.get("soniox") instanceof Promise);
  })();
});

test("the close budget clears the slowest provider's tail", () => {
  // It is a backstop, not the cutoff — the caller's deadline decides what gets used. Set
  // below a supported provider's tail it becomes the limiting factor instead: measured
  // after the last frame, Soniox finalises in 63ms and Gemini Live in 527-541ms, and a
  // 600ms budget was cutting Gemini off while the deadline still had room.
  assert.ok(
    LIVE_LANE_CLOSE_BUDGET_MS > 1000,
    `${LIVE_LANE_CLOSE_BUDGET_MS}ms is not clear of Gemini Live's ~540ms tail`
  );
  // But still well inside the socket's own five-second ceiling.
  assert.ok(LIVE_LANE_CLOSE_BUDGET_MS < 5000, "a hung lane must not hold its result for 5s");
});

test("a lane that hangs resolves null within the close budget", async () => {
  const { lanes, warnings } = build({ stopHangs: true });
  await lanes.start([{ provider: "soniox" }], { termsFor: async () => [] });

  const startedAt = Date.now();
  const result = await lanes.close(performance.now()).get("soniox");
  const elapsed = Date.now() - startedAt;

  assert.equal(result, null, "the caller must be free to use its one-shot path");
  assert.ok(
    elapsed < LIVE_LANE_CLOSE_BUDGET_MS + 300,
    `waited ${elapsed}ms, which is past the budget`
  );
  assert.ok(warnings.some((w) => /returned nothing/.test(w.message)));
});

test("a lane that returns empty text resolves null and says so", async () => {
  const { lanes, warnings } = build({ stopResult: { text: "   " } });
  await lanes.start([{ provider: "soniox" }], { termsFor: async () => [] });

  assert.equal(await lanes.close(performance.now()).get("soniox"), null);
  assert.ok(warnings.some((w) => /returned nothing/.test(w.message)));
});

test("a lane whose stop rejects resolves null instead of throwing", async () => {
  const { lanes, warnings } = build({ stopRejects: true });
  await lanes.start([{ provider: "soniox" }], { termsFor: async () => [] });

  assert.equal(await lanes.close(performance.now()).get("soniox"), null);
  assert.ok(warnings.some((w) => /failed on stop/.test(w.message)));
});

test("a lane that will not start is simply absent", async () => {
  const { lanes, warnings } = build({ startResult: { success: false, error: "no key" } });
  await lanes.start([{ provider: "soniox" }], { termsFor: async () => [] });

  assert.equal(lanes.close(performance.now()).size, 0, "no promise for a lane that never opened");
  assert.ok(warnings.some((w) => /failed to start/.test(w.message)));
});

test("an unknown provider is skipped rather than throwing", async () => {
  const { lanes } = build();
  await lanes.start([{ provider: "not-a-provider" }], { termsFor: async () => [] });
  assert.equal(lanes.close(performance.now()).size, 0);
});

test("the provider's own error reaches the log", async () => {
  // Without this a fatal message appeared only as repeated "audio send dropped"
  // warnings: the symptom, with the cause discarded.
  const { lanes, fake, warnings } = build();
  await lanes.start([{ provider: "soniox" }], { termsFor: async () => [] });

  fake.emitError("Specified model stt-async-v5 does not support real-time transcription");
  assert.ok(
    warnings.some((w) => /reported an error/.test(w.message) && /stt-async-v5/.test(w.error)),
    "the provider's words must be logged"
  );
});

test("a cancelled take closes its sockets instead of leaving them open", async () => {
  // An open socket is billed by wall-clock time. Before this a cancelled take left its
  // sockets running until the next recording happened to replace them.
  const { lanes, fake } = build();
  await lanes.start([{ provider: "soniox" }], { termsFor: async () => [] });

  lanes.discard();
  assert.equal(fake.calls.stop, 1, "the socket must be stopped");
  assert.equal(lanes.active, false, "and the lane forgotten");
  // Frames after a discard go nowhere.
  lanes.feed(frame());
  assert.equal(fake.calls.sent.length, 0);
});

test("a recording that ends while the socket is still connecting leaks nothing", async () => {
  // The race this closes: a short dictation can stop before the socket is up, so close()
  // saw no lanes and the start pushed one afterwards that nobody owned — an open socket
  // with no closer.
  const { lanes, fake } = build({ startDelayMs: 60 });

  const starting = lanes.start([{ provider: "soniox" }], { termsFor: async () => [] });
  assert.equal(lanes.active, true, "a pending start counts as active");

  const closing = lanes.close(performance.now());
  assert.equal(closing.size, 0, "the lane is not visible yet, so it cannot be read");

  await starting;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fake.calls.stop, 1, "but it is closed once it appears");
  assert.equal(lanes.active, false);
});

test("start clears any previous lanes so a take cannot inherit them", async () => {
  const { lanes, fake } = build();
  await lanes.start([{ provider: "soniox" }], { termsFor: async () => [] });
  await lanes.start([{ provider: "soniox" }], { termsFor: async () => [] });

  const closing = lanes.close(performance.now());
  assert.equal(closing.size, 1, "one lane, not two");
  assert.equal(fake.calls.start.length, 2);
});

// --- the wiring in audioManager, which is now four calls ---

const audioManager = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "helpers", "audioManager.js"),
  "utf8"
);

test("audioManager only owns the policy, not the lifecycle", () => {
  // Which lanes stream and what terms they get is this app's decision; the ordering rules
  // between starting, feeding and closing belong to the lanes object.
  assert.match(audioManager, /this\.liveLanes\.feed\(frame\)/);
  assert.match(audioManager, /this\.liveLanes\.discard\(\)/);
  assert.match(audioManager, /this\.liveLanes\.close\(/);
  assert.match(audioManager, /providerWantsStreaming\(lane\.provider, settings\)/);
  // The five methods this replaced should be gone.
  for (const gone of [
    "_feedLiveTranscriptionLanes",
    "beginClosingLiveTranscriptionLanes",
    "_closeLiveLane",
    "discardLiveTranscriptionLanes",
  ]) {
    assert.doesNotMatch(audioManager, new RegExp(gone), `${gone} should have moved out`);
  }
});

test("a streaming lane races on the same deadline as a batch lane", () => {
  // Not awaited as a group before the fan-out: that is what stalled the dictation and
  // starved the batch lanes of the shared budget.
  assert.match(
    audioManager,
    /return track\(closing \? closing\.then\(request\) : request\(undefined\), index\);/,
    "each lane must wait only for itself"
  );
  assert.doesNotMatch(
    audioManager,
    /await liveTextPromise/,
    "the fan-out must not block on the live lanes"
  );
});

test("the deadline and every lane timing are anchored to the recording's end", () => {
  assert.match(
    audioManager,
    /\{ deadlineAt: \(this\._recordingStoppedAt \?\? performance\.now\(\)\) \+ budgetMs \}/
  );
  assert.match(
    audioManager,
    /const startedAt = this\._recordingStoppedAt \?\? performance\.now\(\)/
  );
  // And the reported total covers the whole post-recording wait, or a stall hides in it:
  // measured from the fan-out's own start it read 1ms on a five-second dictation.
  assert.match(audioManager, /performance\.now\(\) - \(this\._recordingStoppedAt \?\? startedAt\)/);
});

test("a dropped streaming lane is still filed as streaming", () => {
  // It was read from the lane's result, which a dropped or failed lane never returns — so
  // every dropped streaming lane landed in the batch row, inflating that row's drop rate
  // while the streaming row never moved. How the lane was run is known from its config
  // regardless of how it ended.
  assert.match(
    audioManager,
    /streaming: providerWantsStreaming\(lane\.provider, settings\)/,
    "the streaming flag must come from the lane's configuration"
  );
  assert.doesNotMatch(
    audioManager,
    /streaming: ok \? result\.value\.streaming/,
    "reading it from the result loses every non-ok lane"
  );
});
