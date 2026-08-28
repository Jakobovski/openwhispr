// The lanes that transcribe while the user is still talking.
//
// One object with a four-call lifecycle — start, feed, close, discard — because that is
// the whole feature. It lived as five methods and a field on audioManager, where the
// ordering rules between them were invisible and easy to get wrong; here they are the
// object's own business.
//
// Why it exists at all: a batch lane cannot begin until the recording ends, and for a
// job-queue provider that is the entire latency. Soniox's async path measured 3859ms for
// a 19-second recording against a ~700ms lane budget, so the fan-out dropped it every
// time. The same provider's socket, fed live, finishes about 60ms after the last frame.
//
// Sending the finished recording at a socket instead does not work: it processes at
// roughly real time, so the same audio took 15.3s that way. Live is the only arrangement
// where a streaming provider is fast.

const { floatToPcm16 } = require("../utils/pcmAudio");

const SAMPLE_RATE = 16000;

// How long a lane gets to hand over its closing transcript.
//
// This is a backstop, not the real cutoff — the caller's deadline is what decides whether
// a lane is used. So it has to be comfortably larger than the slowest supported provider's
// tail, or it becomes the limiting factor instead: measured after the last frame, Soniox
// finalises in 63ms and Gemini Live in 527-541ms across runs, and a 600ms budget was
// cutting Gemini off before it answered even though the deadline had room.
//
// Still bounded, because the socket's own ceiling is five seconds and a hung lane must not
// hold its own result open that long.
const CLOSE_BUDGET_MS = 1500;

class LiveTranscriptionLanes {
  /**
   * @param {object} deps
   * @param {Record<string, object>} deps.providers - Streaming APIs by streaming key.
   * @param {Record<string, string>} deps.keyByProvider - Transcription provider id to
   *   streaming key. They differ: gemini streams through "gemini-live".
   * @param {{warn: Function}} deps.logger
   */
  constructor({ providers, keyByProvider, logger }) {
    this.providers = providers;
    this.keyByProvider = keyByProvider;
    this.logger = logger;
    this.lanes = [];
    // The model each provider actually streamed with, reported by the provider when it
    // started. Kept separately from `lanes` because it outlives them: a lane that is
    // closed, dropped, or never answers still has to be filed under the right model, and
    // the caller only knows the provider's batch model.
    this.modelByProvider = new Map();
    // Held so close() and discard() can wait for a start that is still connecting. A
    // short dictation can end before the socket is up, and without this its lanes were
    // pushed after close() had already run — leaving a socket open that nobody owned.
    this.starting = null;
  }

  /** True once any lane is open, so the caller can skip converting frames for nothing. */
  get active() {
    return this.lanes.length > 0 || this.starting !== null;
  }

  /**
   * Open a socket per lane. Never throws: a lane that cannot start is simply absent, and
   * the caller's one-shot path covers it.
   *
   * @param {Array<{provider: string}>} lanes
   * @param {object} options
   * @param {string} [options.language] - Omitted when the app does not know it.
   * @param {(provider: string) => Promise<string[]>} options.termsFor
   */
  async start(lanes, { language, termsFor }) {
    this.lanes = [];
    this.modelByProvider.clear();
    if (!lanes?.length) return;

    this.starting = (async () => {
      for (const lane of lanes) {
        const api = this.providers[this.keyByProvider[lane.provider]];
        if (!api?.start) continue;
        try {
          // No model: the caller's lane model is the provider's *batch* model, which a
          // streaming socket rejects — Soniox answers "Specified model stt-async-v5 does
          // not support real-time transcription" and closes. The dialect's own default is
          // the streaming model.
          const result = await api.start({
            sampleRate: SAMPLE_RATE,
            language,
            vocabulary: await termsFor(lane.provider),
          });
          if (result?.success === false) {
            this._warn("failed to start", lane.provider, result.error);
            continue;
          }
          // Subscribed so the provider's own words reach the log. Without it a fatal
          // error showed up only as repeated "audio send dropped" warnings: the symptom,
          // with the cause discarded.
          const unsubscribe = api.onError?.((error) =>
            this._warn("reported an error", lane.provider, error)
          );
          this.modelByProvider.set(lane.provider, result?.model ?? null);
          this.lanes.push({ provider: lane.provider, api, unsubscribe });
        } catch (error) {
          this._warn("threw while starting", lane.provider, error?.message);
        }
      }
    })();

    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /**
   * The model this provider actually streamed with, or null if it never started.
   * Not the same as the lane's configured model, which is the provider's batch model.
   */
  modelFor(provider) {
    return this.modelByProvider.get(provider) ?? null;
  }

  /** One captured block of float samples, to every open lane. */
  feed(frame) {
    if (!this.lanes.length || !frame?.length) return;
    // Converted once for all lanes rather than per socket.
    const pcm = floatToPcm16(frame);
    for (const lane of this.lanes) {
      try {
        lane.api.send(pcm.buffer);
      } catch {
        // A dead socket must not interrupt the recording; close() reports it.
      }
    }
  }

  /**
   * Begin closing every lane, and hand back one promise per provider.
   *
   * Not awaited as a whole, on purpose. The caller used to block its fan-out on this,
   * which let a dead socket stall the dictation and then let the close budget come out of
   * the budget shared with the batch lanes, starving them. Per-lane promises make a
   * streaming lane just another lane in the caller's race.
   *
   * @param {number} anchorAt - performance.now() at the end of the recording. Latency is
   *   measured from there because that is what the user waits.
   * @returns {Map<string, Promise<{text: string, ms: number}|null>>}
   */
  close(anchorAt) {
    const closing = new Map();
    const lanes = this.lanes;
    this.lanes = [];

    const pending = this.starting;
    for (const lane of lanes) {
      closing.set(lane.provider, this._closeLane(lane, anchorAt));
    }

    // A start still in flight has lanes this call cannot see yet. Nothing can be awaited
    // for them without reintroducing the stall, so they are closed unread — the caller's
    // one-shot path already covers those providers.
    if (pending) pending.then(() => this.discard()).catch(() => {});
    return closing;
  }

  /** Close everything without reading it, for a cancelled take. */
  discard() {
    const lanes = this.lanes;
    this.lanes = [];
    for (const lane of lanes) {
      try {
        lane.unsubscribe?.();
        // An open socket is billed by wall-clock time, so a cancelled take must not leave
        // one running until the next recording happens to replace it.
        lane.api.stop?.()?.catch?.(() => {});
      } catch {
        // Cancelling must not throw; the recording is already being thrown away.
      }
    }
    if (this.starting) this.starting.then(() => this.discard()).catch(() => {});
  }

  async _closeLane(lane, anchorAt) {
    try {
      lane.unsubscribe?.();
      lane.api.finalize?.();

      const stop = lane.api.stop();
      // Abandoned if it loses the race, so its rejection is swallowed here: it settles
      // after the dictation has moved on, where an unhandled rejection would surface far
      // from anything explaining it.
      stop.catch(() => {});

      const result = await Promise.race([
        stop,
        new Promise((resolve) => setTimeout(() => resolve(null), CLOSE_BUDGET_MS)),
      ]);

      const text = (result?.text || "").trim();
      if (!text) {
        this._warn("returned nothing, falling back to batch", lane.provider);
        return null;
      }
      return { text, ms: Math.max(0, Math.round(performance.now() - anchorAt)) };
    } catch (error) {
      this._warn("failed on stop, falling back to batch", lane.provider, error?.message);
      return null;
    }
  }

  _warn(what, provider, error) {
    this.logger?.warn?.(
      `Live transcription lane ${what}`,
      error ? { provider, error } : { provider },
      "streaming"
    );
  }
}

module.exports = { LiveTranscriptionLanes, LIVE_LANE_CLOSE_BUDGET_MS: CLOSE_BUDGET_MS };
