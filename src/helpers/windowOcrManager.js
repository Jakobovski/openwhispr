const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { extractScreenTerms } = require("../utils/screenTermMatcher");
const { dropDictionaryWords } = require("./englishLexicon");

const BINARY_NAME = "macos-window-ocr";
// Ceiling on how long the transcript will wait for screen context. The sidecar
// has its own (shorter) watchdog; this is the backstop if it wedges entirely.
const SPAWN_TIMEOUT_MS = 6000;
const SIDECAR_TIMEOUT_SECONDS = 4;

// Captures the focused window and OCRs it, in parallel with recording. Every
// failure is non-fatal: screen context is an enhancement, so a denied
// permission, a missing binary or an unsupported OS just yields no terms and
// the transcript is used exactly as transcribed.
class WindowOcrManager {
  constructor() {
    this.cachedBinaryPath = undefined;
    this.pending = null;
    // Whether `pending` has resolved. A resolved capture nobody collected belongs
    // to a dictation that ended without one, and must not be handed to the next.
    this.settled = false;
    this.child = null;
  }

  resolveBinaryPath() {
    if (this.cachedBinaryPath !== undefined) return this.cachedBinaryPath;

    const candidates = [];
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, "bin", BINARY_NAME));
    }
    candidates.push(path.join(__dirname, "..", "..", "resources", "bin", BINARY_NAME));

    this.cachedBinaryPath = candidates.find((candidate) => fs.existsSync(candidate)) || null;
    if (!this.cachedBinaryPath) {
      debugLogger.debug("Window OCR binary not found", { candidates }, "window-ocr");
    }
    return this.cachedBinaryPath;
  }

  isSupported() {
    return process.platform === "darwin" && !!this.resolveBinaryPath();
  }

  /**
   * Kick off a capture. Call as early as possible — ideally the moment
   * recording starts — so recognition overlaps with the user speaking.
   * Safe to call repeatedly; a capture already in flight is reused.
   */
  start() {
    // A finished capture still sitting here was never collected, which means the
    // dictation that asked for it ended without a transcript — cancelled, failed,
    // or its collect budget expired. Handing it to this dictation would correct
    // the new transcript against the window the user was looking at during the
    // old one, so it is dropped. An *unfinished* capture is a concurrent start
    // inside one dictation and is still shared.
    if (this.pending && this.settled) {
      debugLogger.debug(
        "Dropping an uncollected capture from an earlier dictation",
        {},
        "window-ocr"
      );
      this.pending = null;
      this.settled = false;
    }
    if (this.pending) {
      debugLogger.debug("Window OCR already in flight, reusing", {}, "window-ocr");
      return this.pending;
    }

    const capture = this._run().catch((error) => {
      debugLogger.debug("Window OCR failed", { error: error.message }, "window-ocr");
      return null;
    });
    this.pending = capture;
    this.settled = false;
    // Guarded against a start that replaced this capture in the meantime, so a
    // stale resolution cannot mark a live capture as collectable-and-abandoned.
    void capture.then(() => {
      if (this.pending === capture) this.settled = true;
    });
    return capture;
  }

  /**
   * Await the in-flight capture, if any. Returns null when OCR is unavailable,
   * failed, or was never started — callers must treat null as "no context".
   */
  async collect() {
    if (!this.pending) return null;
    const result = await this.pending;
    this.pending = null;
    this.settled = false;
    return result;
  }

  // Discard an in-flight capture whose transcript will never arrive (a
  // cancelled dictation), so the next one starts clean.
  cancel() {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        // Already gone
      }
    }
    this.child = null;
    this.pending = null;
    this.settled = false;
  }

  _run() {
    const binaryPath = this.resolveBinaryPath();
    if (!binaryPath) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child = null;
        resolve(value);
      };

      let child;
      try {
        child = spawn(binaryPath, [
          "--timeout",
          String(SIDECAR_TIMEOUT_SECONDS),
          "--exclude-pid",
          String(process.pid),
        ]);
      } catch (error) {
        debugLogger.debug("Window OCR spawn threw", { error: error.message }, "window-ocr");
        return resolve(null);
      }
      this.child = child;

      const timer = setTimeout(() => {
        debugLogger.debug("Window OCR timed out, killing", {}, "window-ocr");
        try {
          child.kill();
        } catch {
          // Already gone
        }
        finish(null);
      }, SPAWN_TIMEOUT_MS);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        debugLogger.debug("Window OCR process error", { error: error.message }, "window-ocr");
        finish(null);
      });

      child.on("close", () => {
        let payload;
        try {
          payload = JSON.parse(stdout.trim());
        } catch {
          debugLogger.debug(
            "Window OCR returned unparseable output",
            { stdout: stdout.slice(0, 200), stderr: stderr.slice(0, 200) },
            "window-ocr"
          );
          return finish(null);
        }

        if (!payload?.ok) {
          // A declined permission lands here on every dictation; keep it at
          // debug so it can't spam the log.
          debugLogger.debug("Window OCR unavailable", { error: payload?.error }, "window-ocr");
          return finish(null);
        }

        const text = typeof payload.text === "string" ? payload.text : "";

        // Terms are extracted here, not in the renderer that consumes them, for two
        // reasons. The dictionary filter reads 2.5 MB, and this runs while the user
        // is still speaking — so it costs nothing on the path between "stopped
        // talking" and "text pasted". And the raw screen text never has to leave this
        // process: only the filtered vocabulary crosses to the renderer.
        const candidates = extractScreenTerms(text);
        const { terms, dropped, available } = dropDictionaryWords(candidates);

        debugLogger.debug(
          "Window OCR captured",
          {
            window: payload.window,
            chars: text.length,
            candidates: candidates.length,
            terms: terms.length,
            droppedAsEnglish: dropped,
            dictionaryAvailable: available,
            sidecarMs: payload.durationMs,
            totalMs: Date.now() - started,
          },
          "window-ocr"
        );
        finish({
          window: payload.window || "",
          terms,
          termCount: terms.length,
          ocrChars: text.length,
        });
      });
    });
  }
}

module.exports = WindowOcrManager;
module.exports.SPAWN_TIMEOUT_MS = SPAWN_TIMEOUT_MS;
