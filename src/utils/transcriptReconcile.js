// Agreement check for dual transcription.
//
// The merge itself is done by an LLM using the app's cleanup prompt adapted for
// two candidates (see getReconcileSystemPrompt), so the only logic that belongs
// here is deciding whether a merge is needed at all.
//
// Two ASR systems make different mistakes, so their disagreements localise the
// words worth a second look — one may hear a name correctly where the other
// guesses. An LLM asked to merge them can beat either alone, and since it is
// already reading the text it also does the cleanup pass: punctuation, casing,
// filler removal and grammar.
//
// The model is deliberately allowed to repair gaps rather than only choose
// between the two readings: when the microphone drops a word, both systems miss
// it, and inferring it from context produces the sentence the speaker actually
// said. The cost is that a confidently wrong repair is indistinguishable from a
// correct one, and nothing downstream checks the output against the sources.

function stripToWords(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
}

function normalizeForCompare(text) {
  return stripToWords(text).join(" ");
}

/**
 * Do all the transcriptions say the same thing, ignoring case and punctuation?
 * When they do there is nothing to reconcile, so the LLM call can be skipped —
 * the common case for clean audio, and one less round trip before pasting.
 *
 * Variadic so a two-provider and a three-provider dictation ask the same question.
 * Anything blank, or fewer than two candidates, is reported as disagreement — see below.
 *
 * @param {...string} texts
 * @returns {boolean}
 */
function transcriptsAgree(...texts) {
  // Fewer than two candidates, or any blank one, is not agreement: the caller must not
  // mistake "nothing to compare" for "settled", or it would skip the merge and paste an
  // empty transcript. The caller filters blanks before asking.
  if (texts.length < 2) return false;
  const normalized = texts.map(normalizeForCompare);
  if (normalized.some((text) => !text)) return false;
  return normalized.every((text) => text === normalized[0]);
}

module.exports = { transcriptsAgree };
