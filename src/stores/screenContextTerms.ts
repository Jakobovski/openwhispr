// The OCR'd vocabulary for recent dictations, held in memory and never written
// anywhere.
//
// Screen context reads the window the user is dictating into, which means the
// candidate terms are arbitrary contents of whatever they were looking at —
// documents, messages, other people's names. None of that is about what the user
// said, so none of it belongs in the database, in a backup, or in the cloud sync
// that carries transcription rows.
//
// What is persisted instead lives in `transcriptions.screen_context_json`: the
// words screen context actually changed. Those are already in the stored
// transcript by definition — the correction is the text the user pasted — so
// recording them reveals nothing the row does not already contain.
//
// The cost of that choice is deliberate and visible in the UI: terms are shown for
// dictations made since the app started, and are gone after a restart. A history
// row from last week can say which words were changed but not what else was on
// screen at the time. That is the right trade — the alternative is a permanent
// record of everything the user has looked at while dictating.

export interface ScreenContextTerms {
  /** App and window the text was read from, e.g. "Safari — Pull Requests". */
  window: string;
  /** Candidate terms, most frequent first. */
  terms: string[];
  /** How many were extracted; equal to terms.length unless the list was capped. */
  termCount: number;
}

// Comfortably more than the history view shows at once, and bounded so a long
// session cannot grow this without limit.
const MAX_ENTRIES = 200;

// Keyed by clientTranscriptionId, which the renderer knows before the row exists
// and which the history row carries back.
const entries = new Map<string, ScreenContextTerms>();

export function recordScreenTerms(
  clientTranscriptionId: string | undefined | null,
  detail: ScreenContextTerms
): void {
  if (!clientTranscriptionId) return;

  entries.set(clientTranscriptionId, detail);
  // Map preserves insertion order, so the oldest key is the first one.
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export function getScreenTerms(
  clientTranscriptionId: string | undefined | null
): ScreenContextTerms | null {
  if (!clientTranscriptionId) return null;
  return entries.get(clientTranscriptionId) ?? null;
}

/** Test seam, and the reset a "clear history" action should reach for. */
export function clearScreenTerms(): void {
  entries.clear();
}
