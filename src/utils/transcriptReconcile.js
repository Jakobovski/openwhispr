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

// A recogniser that stopped mid-utterance often says so: grok-stt ends its text with a
// dash where the speaker was interrupted or hesitated. Two of the truncations found in
// real history end exactly that way ("...or at least-", "...why don't we only-").
const CUT_OFF_MARKER = /[-–—]\s*$/;

// How much longer another answer has to be before it overrides slot order. Measured
// against real dictations: normal disagreement between providers ran to 17% of the word
// count, while the one genuine truncation was 121% shorter than the lane beside it. A
// quarter more words, and at least five, sits between the two with room on both sides.
const MORE_COMPLETE_RATIO = 1.25;
const MORE_COMPLETE_WORDS = 5;

const wordCount = (text) => stripToWords(text).length;

/**
 * Which answer to paste when the merge did not produce one.
 *
 * Slot order is trust order, so the first answer wins by default — that is the whole
 * point of putting the most accurate recogniser first. The exception is a lane that
 * plainly returned less of the dictation than another did: xAI's batch endpoint
 * sometimes stops partway through (verified against its own API — it reports the full
 * audio duration and returns a fraction of the words, reproducibly), and when the merge
 * is dropped or fails, slot order alone would paste that fragment while a complete
 * transcript sat in the next lane. That happened: a 17-second dictation pasted 14 words
 * ending "or at least-" while Groq had all 31.
 *
 * Deliberately conservative. Longer is not better in general — a recogniser that
 * hallucinates a repeated tail would win this comparison — so the margin has to be wide
 * enough that ordinary disagreement never triggers it, and a self-declared cut-off is
 * treated as evidence in its own right.
 *
 * @param {Array<{text: string}>} answers Lanes that returned text, in slot order.
 * @returns {{text: string}|undefined} The answer to use.
 */
function chooseFallbackTranscript(answers) {
  const usable = (answers || []).filter((answer) => (answer?.text || "").trim());
  if (usable.length === 0) return undefined;

  const leader = usable[0];
  const leaderWords = wordCount(leader.text);
  const leaderCutOff = CUT_OFF_MARKER.test(leader.text.trim());

  let best = leader;
  let bestWords = leaderWords;
  for (const answer of usable.slice(1)) {
    const words = wordCount(answer.text);
    if (words <= bestWords) continue;
    // A leader that marks its own cut-off loses to any longer answer that does not;
    // otherwise the margin has to be wide enough to rule out ordinary disagreement.
    const beatsMarker = leaderCutOff && !CUT_OFF_MARKER.test(answer.text.trim());
    const beatsMargin =
      words >= leaderWords * MORE_COMPLETE_RATIO && words - leaderWords >= MORE_COMPLETE_WORDS;
    if (beatsMarker || beatsMargin) {
      best = answer;
      bestWords = words;
    }
  }
  return best;
}

module.exports = { transcriptsAgree, chooseFallbackTranscript };
