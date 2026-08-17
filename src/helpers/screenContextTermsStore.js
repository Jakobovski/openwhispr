// The OCR'd vocabulary for recent dictations, held in the main process and never
// written anywhere.
//
// Why the main process rather than the renderer that produces it: dictation runs in
// the overlay window and history renders in the control panel, which are separate
// BrowserWindows and therefore separate renderer processes. A module-level Map in
// the renderer is per-window, so terms recorded during a dictation were invisible
// to the window that displays them. The main process is the only memory both share.
//
// Why in memory rather than in the database: the candidate terms are the contents
// of whatever window the user was dictating into — documents, messages, other
// people's names — and none of it is about what they said. Keeping it would also
// hand it to the cloud sync that carries transcription rows.
//
// What is persisted instead is `transcriptions.screen_context_json`: the words
// screen context actually changed. Those are already in the stored transcript by
// definition, since the correction is the text that got pasted.
//
// The deliberate cost: terms survive until the app quits, so a history row from a
// previous run shows which words were corrected but not what else was on screen.

// Keyed by the transcriptions row id — the one identifier both sides agree on.
// clientTranscriptionId is unsuitable: the renderer only knows it on the
// OpenWhispr-cloud path, and the database mints its own when it is absent.
const entries = new Map();

// Comfortably more than the history view shows at once, and bounded so a long
// session cannot grow this without limit.
const MAX_ENTRIES = 300;

function record(transcriptionId, detail) {
  const id = Number(transcriptionId);
  if (!Number.isInteger(id) || id <= 0) return;

  entries.set(id, {
    window: typeof detail?.window === "string" ? detail.window : "",
    terms: Array.isArray(detail?.terms) ? detail.terms.filter((t) => typeof t === "string") : [],
    termCount: Number.isFinite(detail?.termCount) ? detail.termCount : 0,
  });

  // Map preserves insertion order, so the first key is the oldest.
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** Everything currently held, as a plain object so it can cross IPC. */
function getAll() {
  const out = {};
  for (const [id, detail] of entries) out[id] = detail;
  return out;
}

function forget(transcriptionId) {
  entries.delete(Number(transcriptionId));
}

function clear() {
  entries.clear();
}

module.exports = { record, getAll, forget, clear, MAX_ENTRIES };
