const WebSocket = require("ws");
const debugLogger = require("./debugLogger");
const { resolveXaiSttLanguage } = require("./xaiSttLanguages");

const XAI_STT_WSS_URL = "wss://api.x.ai/v1/stt";
const SAMPLE_RATE = 16000;
const WEBSOCKET_TIMEOUT_MS = 30000;
const TERMINATION_TIMEOUT_MS = 5000;
const KEEPALIVE_INTERVAL_MS = 15000;
const PRE_READY_BUFFER_MAX = 3 * SAMPLE_RATE * 2; // 3 seconds of 16-bit mono PCM
// A warm socket can stay OPEN long after xAI has stopped transcribing on it, so
// don't trust one indefinitely — cold-connect instead once it's this old.
const MAX_WARM_AGE_MS = 120000;
// Max wait for the first transcript.partial from a promoted warm connection
// before treating it as dead. xAI emits interims even while the speaker is
// silent, so any partial (empty text included) proves the session is alive.
const LIVENESS_TIMEOUT_MS = 2500;

// xAI's WSS transport: API key in an Authorization header, all configuration in
// the query string, then raw PCM frames once the server sends transcript.created.
// Mirrors the Corti/Deepgram streaming classes.
class XaiStreaming {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.isConnected = false;
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.connectionTimeout = null;
    this.accumulatedText = "";
    this.finalSegments = [];
    this.pendingAck = null;
    this.isDisconnecting = false;
    this.serverReady = false;
    this.preReadyBuffer = [];
    this.preReadyBufferSize = 0;
    this.sessionStartedAt = null;
    this.audioBytesSent = 0;
    this.currentModel = "grok-stt";
    this.sampleRate = SAMPLE_RATE;
    this.warmConnection = null;
    this.warmConnectionReady = false;
    this.warmSessionId = null;
    this.warmSessionStartedAt = null;
    this.warmReadyAt = null;
    this.keepAliveInterval = null;
    this.resultsReceived = 0;
    this.livenessTimer = null;
    this.replayBuffer = [];
    this.replayBufferSize = 0;
    this.connectionOptions = null;
  }

  get completedSegments() {
    return this.finalSegments;
  }

  resolveApiKey(options) {
    // Meeting mode hands every streaming class the same {apiKey, token} pair.
    return options.apiKey || options.token;
  }

  buildWebSocketUrl(options) {
    const sampleRate = options.sampleRate || SAMPLE_RATE;
    const params = new URLSearchParams({
      encoding: options.encoding || "pcm",
      sample_rate: String(sampleRate),
      // Partial transcripts (~every 500ms) drive the live preview.
      interim_results: "true",
    });

    const language = resolveXaiSttLanguage(options.language);
    if (language) {
      params.set("language", language);
    } else if (options.language && options.language !== "auto") {
      debugLogger.debug("xAI streaming language unsupported, using auto-detect", {
        language: options.language,
      });
    }

    // Endpointing/VAD/Smart Turn are left at xAI's defaults unless a caller opts
    // in, so tuning lives with the caller rather than being baked in here.
    if (typeof options.endpointing === "number") {
      params.set("endpointing", String(options.endpointing));
    }
    if (typeof options.vadThreshold === "number") {
      params.set("vad_threshold", String(options.vadThreshold));
    }
    if (typeof options.smartTurn === "number") {
      params.set("smart_turn", String(options.smartTurn));
      if (typeof options.smartTurnTimeout === "number") {
        params.set("smart_turn_timeout", String(options.smartTurnTimeout));
      }
    }

    if (Array.isArray(options.keyterms)) {
      // Same limits as the REST endpoint: up to 100 terms, 50 chars each.
      for (const term of options.keyterms.slice(0, 100)) {
        const trimmed = String(term || "")
          .trim()
          .slice(0, 50);
        if (trimmed) params.append("keyterm", trimmed);
      }
    }

    return `${XAI_STT_WSS_URL}?${params.toString()}`;
  }

  buildSocketOptions(apiKey) {
    return { headers: { Authorization: `Bearer ${apiKey}` } };
  }

  // 100ms of silence at the session's rate. Warm connections are kept alive with
  // real (silent) audio rather than a websocket ping: a ping keeps the socket
  // open but does not stop xAI from finishing the transcription session, which
  // leaves a socket that accepts audio and never returns a transcript.
  silenceFrame() {
    return Buffer.alloc(Math.round(this.sampleRate / 10) * 2);
  }

  async connect(options = {}) {
    const apiKey = this.resolveApiKey(options);
    if (!apiKey) {
      throw new Error("xAI streaming requires an API key");
    }

    if (this.isConnected) {
      debugLogger.debug("xAI streaming already connected");
      return;
    }

    const { replayBuffer, forceNew } = options;
    // A reconnect keeps the text already committed; a fresh session starts clean.
    if (!replayBuffer) {
      this.accumulatedText = "";
      this.finalSegments = [];
      this.audioBytesSent = 0;
    }
    this.serverReady = false;
    this.preReadyBuffer = [];
    this.preReadyBufferSize = 0;
    this.sampleRate = options.sampleRate || SAMPLE_RATE;
    this.connectionOptions = { ...options, replayBuffer: undefined, forceNew: undefined };

    // Reuse the pre-warmed socket for an instant start; cold-connect otherwise.
    if (!forceNew && this.useWarmConnection()) {
      debugLogger.debug("xAI using warm connection - instant start");
      return;
    }
    this.clearLivenessWatch();

    // Audio captured while a dead warm session was being detected replays first,
    // so the pre-ready buffer flushes it in order once the new session is up.
    if (replayBuffer && replayBuffer.length > 0) {
      this.preReadyBuffer = [...replayBuffer];
      this.preReadyBufferSize = replayBuffer.reduce((sum, b) => sum + b.length, 0);
      debugLogger.debug("xAI replaying audio into new session", {
        chunks: this.preReadyBuffer.length,
        bytes: this.preReadyBufferSize,
      });
    }

    const url = this.buildWebSocketUrl(options);
    debugLogger.debug("xAI streaming connecting", { sampleRate: this.sampleRate });

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        this.cleanup();
        reject(new Error("xAI WebSocket connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.ws = new WebSocket(url, this.buildSocketOptions(apiKey));
      this.ws.on("open", () => {
        debugLogger.debug("xAI WebSocket connected, waiting for transcript.created");
      });
      this.attachSocketHandlers(this.ws);
    });
  }

  // Live-socket wiring shared by the cold connect and a promoted warm connection.
  // Every handler ignores a socket we've already moved on from (a reconnect
  // replaces this.ws, and the old socket's close/error still arrives later —
  // acting on it would tear down the session that just replaced it).
  attachSocketHandlers(ws) {
    const isStale = () => this.ws !== ws;

    ws.on("message", (data) => {
      if (isStale()) return;
      this.handleMessage(data);
    });

    ws.on("error", (error) => {
      if (isStale()) {
        debugLogger.debug("xAI ignoring error from replaced socket", {
          error: error.message,
        });
        return;
      }
      debugLogger.error("xAI WebSocket error", { error: error.message });
      this.cleanup();
      if (this.pendingReject) {
        this.pendingReject(error);
        this.pendingReject = null;
        this.pendingResolve = null;
      }
      this.onError?.(error);
    });

    ws.on("close", (code, reason) => {
      if (isStale()) {
        debugLogger.debug("xAI replaced socket closed", { code });
        return;
      }
      const wasActive = this.isConnected;
      debugLogger.debug("xAI WebSocket closed", {
        code,
        reason: reason?.toString(),
        wasActive,
      });
      if (this.pendingReject) {
        this.pendingReject(new Error(`xAI WebSocket closed before ready (code: ${code})`));
        this.pendingReject = null;
        this.pendingResolve = null;
      }
      this.resolvePendingAck();
      this.cleanup();
      if (wasActive && !this.isDisconnecting) {
        this.onError?.(new Error(`Connection lost (code: ${code})`));
      }
    });
  }

  // Pre-open the socket and wait for transcript.created before recording, so the
  // first words aren't spent on the handshake. Mirrors Corti/Deepgram.
  async warmup(options = {}) {
    const apiKey = this.resolveApiKey(options);
    if (!apiKey) {
      throw new Error("xAI warmup requires an API key");
    }
    if (this.warmConnection) {
      debugLogger.debug(
        this.warmConnectionReady
          ? "xAI connection already warm"
          : "xAI warmup already in progress, skipping"
      );
      return;
    }

    this.warmConnectionReady = false;
    this.warmSessionId = null;
    this.sampleRate = options.sampleRate || SAMPLE_RATE;

    const url = this.buildWebSocketUrl(options);
    debugLogger.debug("xAI warming up connection", { sampleRate: this.sampleRate });

    return new Promise((resolve, reject) => {
      let settled = false;
      const warmupTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.cleanupWarmConnection();
        reject(new Error("xAI warmup connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.warmConnection = new WebSocket(url, this.buildSocketOptions(apiKey));

      this.warmConnection.on("open", () => {
        debugLogger.debug("xAI warm connection opened, waiting for transcript.created");
      });

      this.warmConnection.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch (err) {
          return;
        }
        if (message.type === "transcript.created" && !settled) {
          settled = true;
          clearTimeout(warmupTimeout);
          this.warmConnectionReady = true;
          this.warmSessionId = message.request_id || message.id || null;
          this.warmSessionStartedAt = Date.now();
          this.warmReadyAt = Date.now();
          this.startKeepAlive();
          debugLogger.debug("xAI connection warmed up", { sessionId: this.warmSessionId });
          resolve();
        }
      });

      this.warmConnection.on("error", (error) => {
        debugLogger.error("xAI warmup connection error", { error: error.message });
        this.cleanupWarmConnection();
        if (!settled) {
          settled = true;
          clearTimeout(warmupTimeout);
          reject(error);
        }
      });

      this.warmConnection.on("close", (code, reason) => {
        clearTimeout(warmupTimeout);
        const wasReady = this.warmConnectionReady;
        debugLogger.debug("xAI warm connection closed", {
          code,
          reason: reason?.toString(),
          wasReady,
        });
        this.cleanupWarmConnection();
        if (!settled) {
          settled = true;
          reject(new Error(`xAI warmup connection closed (code: ${code})`));
        }
      });
    });
  }

  hasWarmConnection() {
    if (
      this.warmConnection === null ||
      !this.warmConnectionReady ||
      this.warmConnection.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    // readyState alone is not proof the session still transcribes.
    if (this.warmReadyAt != null && Date.now() - this.warmReadyAt > MAX_WARM_AGE_MS) {
      debugLogger.debug("xAI warm connection too old, discarding", {
        ageMs: Date.now() - this.warmReadyAt,
      });
      return false;
    }
    return true;
  }

  // Promote the warm socket to the active session — the server already sent
  // transcript.created, so audio flows immediately. Returns false (clearing any
  // stale socket) if none is usable.
  useWarmConnection() {
    if (!this.hasWarmConnection()) {
      this.cleanupWarmConnection();
      return false;
    }

    this.stopKeepAlive();
    this.ws = this.warmConnection;
    this.isConnected = true;
    this.serverReady = true;
    this.sessionId = this.warmSessionId || null;
    this.sessionStartedAt = this.warmSessionStartedAt || Date.now();
    this.warmConnection = null;
    this.warmConnectionReady = false;
    this.warmSessionId = null;
    this.warmSessionStartedAt = null;
    this.warmReadyAt = null;
    this.startLivenessWatch();

    this.ws.removeAllListeners("open");
    this.ws.removeAllListeners("message");
    this.ws.removeAllListeners("error");
    this.ws.removeAllListeners("close");
    this.attachSocketHandlers(this.ws);
    return true;
  }

  startKeepAlive() {
    this.stopKeepAlive();
    const frame = this.silenceFrame();
    this.keepAliveInterval = setInterval(() => {
      if (this.warmConnection?.readyState !== WebSocket.OPEN) {
        this.stopKeepAlive();
        return;
      }
      // Stop paying for a warm session nobody claimed. Streaming STT is billed
      // per hour of audio, and the keep-alive silence is audio — tiny per tick,
      // but there's no reason to send it (or hold the session) indefinitely.
      // The next dictation cold-connects instead, which costs ~500ms.
      if (this.warmReadyAt != null && Date.now() - this.warmReadyAt > MAX_WARM_AGE_MS) {
        debugLogger.debug("xAI warm connection expired, closing", {
          ageMs: Date.now() - this.warmReadyAt,
        });
        this.cleanupWarmConnection();
        return;
      }
      try {
        this.warmConnection.send(frame);
      } catch (err) {
        debugLogger.debug("xAI keep-alive failed", { error: err.message });
        this.cleanupWarmConnection();
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  cleanupWarmConnection() {
    this.stopKeepAlive();
    if (this.warmConnection) {
      try {
        this.warmConnection.close(1000);
      } catch (err) {
        // Ignore close errors
      }
      this.warmConnection = null;
    }
    this.warmConnectionReady = false;
    this.warmSessionId = null;
    this.warmSessionStartedAt = null;
    this.warmReadyAt = null;
  }

  // A promoted warm socket that never returns a partial is a dead session: it
  // accepts audio and silently transcribes nothing. Detect that and cold-connect,
  // replaying the audio captured meanwhile so no speech is lost.
  startLivenessWatch() {
    clearTimeout(this.livenessTimer);
    this.resultsReceived = 0;
    this.replayBuffer = [];
    this.replayBufferSize = 0;
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = null;
      this.recoverDeadWarmSession();
    }, LIVENESS_TIMEOUT_MS);
  }

  clearLivenessWatch() {
    clearTimeout(this.livenessTimer);
    this.livenessTimer = null;
    this.replayBuffer = [];
    this.replayBufferSize = 0;
  }

  async recoverDeadWarmSession() {
    if (this.resultsReceived > 0 || !this.isConnected || this.isDisconnecting) return;

    const replay = this.replayBuffer;
    const options = this.connectionOptions;
    debugLogger.warn("xAI warm session produced no results, reconnecting", {
      replayChunks: replay.length,
      replayBytes: this.replayBufferSize,
    });

    this.replayBuffer = [];
    this.replayBufferSize = 0;
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch (err) {
        // Ignore close errors
      }
      this.ws = null;
    }
    this.isConnected = false;
    this.serverReady = false;

    try {
      await this.connect({ ...options, replayBuffer: replay, forceNew: true });
    } catch (error) {
      debugLogger.error("xAI reconnect after dead warm session failed", {
        error: error.message,
      });
      this.onError?.(error);
    }
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (err) {
      debugLogger.error("xAI message parse error", { error: err.message });
      return;
    }

    switch (message.type) {
      case "transcript.created":
        this.isConnected = true;
        this.serverReady = true;
        this.sessionId = message.request_id || message.id || null;
        this.sessionStartedAt = Date.now();
        clearTimeout(this.connectionTimeout);
        this.flushPreReadyBuffer();
        debugLogger.debug("xAI session started", { sessionId: this.sessionId });
        if (this.pendingResolve) {
          this.pendingResolve();
          this.pendingResolve = null;
          this.pendingReject = null;
        }
        break;

      case "transcript.partial": {
        // Count before the empty-text guard: an empty interim still proves the
        // session is alive, which is all the liveness watch needs.
        this.resultsReceived++;
        this.clearLivenessWatch();

        const text = message.text;
        if (!text || !text.trim()) break;
        // Three states ride on is_final/speech_final. A chunk final
        // (is_final && !speech_final) locks ~3s of text that the following
        // utterance final then restates as one stitched utterance, so only
        // speech_final commits a segment — committing chunk finals too would
        // double-count that text. Everything before it feeds the live preview.
        if (message.is_final && message.speech_final) {
          this.commitSegment(text, message);
        } else {
          this.onPartialTranscript?.(text);
        }
        break;
      }

      case "transcript.done": {
        // The full transcript, sent after audio.done. We normally already hold
        // every utterance final, so only adopt it when we hold nothing — that
        // covers a session that ended without a speech_final without letting a
        // whole-session restatement duplicate what we already committed.
        const text = String(message.text || "").trim();
        if (text && !this.accumulatedText) {
          debugLogger.debug("xAI adopting transcript.done text (no utterance finals seen)");
          this.commitSegment(text, message);
        }
        if (this.pendingAck?.type === "transcript.done") {
          this.resolvePendingAck();
        }
        break;
      }

      case "error":
        debugLogger.error("xAI streaming error", { error: message.message });
        this.onError?.(new Error(message.message || "xAI streaming error"));
        break;

      default:
        debugLogger.debug("xAI unknown message type", { type: message.type });
    }
  }

  commitSegment(text, message) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return;
    this.finalSegments.push(trimmed);
    this.accumulatedText = this.finalSegments.join(" ");
    const startedAt =
      this.sessionStartedAt != null && typeof message?.start === "number"
        ? this.sessionStartedAt + message.start * 1000
        : Date.now();
    this.onFinalTranscript?.(this.accumulatedText, startedAt);
    debugLogger.debug("xAI final transcript", {
      text: trimmed.slice(0, 100),
      totalAccumulated: this.accumulatedText.length,
    });
  }

  flushPreReadyBuffer() {
    if (this.preReadyBuffer.length === 0) return;
    debugLogger.debug("xAI flushing pre-ready buffer", {
      chunks: this.preReadyBuffer.length,
      bytes: this.preReadyBufferSize,
    });
    for (const frame of this.preReadyBuffer) {
      this.ws.send(frame);
      this.audioBytesSent += frame.length;
    }
    this.preReadyBuffer = [];
    this.preReadyBufferSize = 0;
  }

  sendAudio(pcmBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (!this.serverReady) {
      // xAI expects audio only after transcript.created; cap the handshake
      // buffer at ~3s so a stalled handshake can't grow it without bound.
      if (this.preReadyBufferSize < PRE_READY_BUFFER_MAX) {
        const copy = Buffer.from(pcmBuffer);
        this.preReadyBuffer.push(copy);
        this.preReadyBufferSize += copy.length;
      }
      return true;
    }

    // Keep a copy until the session proves it transcribes, so a dead warm
    // session can be replayed into a fresh one instead of losing the audio.
    if (this.livenessTimer) {
      this.replayBuffer.push(Buffer.from(pcmBuffer));
      this.replayBufferSize += pcmBuffer.length;
    }

    this.audioBytesSent += pcmBuffer.length;
    this.ws.send(pcmBuffer);
    return true;
  }

  // Forces the current utterance to finalize as speech_final immediately, which
  // is what push-to-talk needs on key release.
  finalize() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    // xAI's prose spells this "finalize" while its JSON examples use "Finalize";
    // the examples (and Deepgram, whose event shape this mirrors) win.
    this.ws.send(JSON.stringify({ type: "Finalize" }));
    debugLogger.debug("xAI Finalize sent");
    return true;
  }

  // Resolves a single in-flight waitForAck (server ack or socket close).
  resolvePendingAck() {
    if (!this.pendingAck) return;
    clearTimeout(this.pendingAck.timer);
    this.pendingAck.resolve();
    this.pendingAck = null;
  }

  waitForAck(type) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAck = null;
        resolve();
      }, TERMINATION_TIMEOUT_MS);
      this.pendingAck = { type, resolve, timer };
    });
  }

  async disconnect(closeStream = true) {
    if (!this.ws) return { text: this.accumulatedText };

    this.isDisconnecting = true;

    if (closeStream && this.ws.readyState === WebSocket.OPEN) {
      // Close handshake: Finalize so any in-flight utterance lands as
      // speech_final, then audio.done to flush and wait for transcript.done.
      this.ws.send(JSON.stringify({ type: "Finalize" }));
      this.ws.send(JSON.stringify({ type: "audio.done" }));
      await this.waitForAck("transcript.done");

      const result = { text: this.accumulatedText };
      this.onSessionEnd?.(result);
      this.cleanup();
      this.isDisconnecting = false;
      return result;
    }

    const result = { text: this.accumulatedText };
    this.cleanup();
    this.isDisconnecting = false;
    return result;
  }

  cleanup() {
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    this.preReadyBuffer = [];
    this.preReadyBufferSize = 0;
    this.clearLivenessWatch();

    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch (err) {
        // Ignore close errors
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.serverReady = false;
    this.sessionId = null;
    this.resolvePendingAck();
  }

  cleanupAll() {
    this.cleanup();
    this.cleanupWarmConnection();
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      sessionId: this.sessionId,
    };
  }
}

module.exports = XaiStreaming;
