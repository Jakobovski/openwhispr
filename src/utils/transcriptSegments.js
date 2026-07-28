const { COMMON_WORDS } = require("./commonWords");

// Streaming recognizers emit one segment per utterance and capitalize each as
// though it were a new sentence — they cannot know the speaker is mid-thought.
// Concatenating them naively strews capitals through the middle of sentences:
//
//   "We don't need cleanup, just" + "Just have it, not even try, and then"
//     -> "We don't need cleanup, just Just have it, not even try, and then"
//
// So when the previous segment did not end a sentence, the next segment's first
// word is lowered back — but only when doing so is unambiguously safe.

const SENTENCE_ENDINGS = new Set([".", "!", "?", ":", ";"]);

function endsSentence(segment) {
  const trimmed = segment.trimEnd();
  if (!trimmed) return true;
  // Ignore a trailing quote or bracket: `he said "stop."` still ends a sentence.
  const stripped = trimmed.replace(/["'”’)\]]+$/, "");
  return SENTENCE_ENDINGS.has(stripped.slice(-1));
}

// Lowering a word is only safe when it is ordinary English in plain
// sentence-case. Anything else — a name, an acronym, camelCase, the pronoun
// "I" — carries its capital for a reason.
function canLower(word) {
  if (!word) return false;
  if (word === "I" || /^I['’]/.test(word)) return false;
  if (!/^[A-Z][a-z]*$/.test(word)) return false;
  return COMMON_WORDS.has(word.toLowerCase());
}

/**
 * Join utterance segments into one transcript, repairing the sentence-case
 * artifacts that segmentation introduces.
 *
 * @param {string[]} segments - Committed segments, in order
 * @returns {string} The joined transcript
 */
function joinTranscriptSegments(segments) {
  if (!Array.isArray(segments)) return "";
  const parts = segments.filter((s) => typeof s === "string" && s.trim());
  if (parts.length === 0) return "";

  let out = parts[0].trim();
  for (let i = 1; i < parts.length; i++) {
    let next = parts[i].trim();
    if (!endsSentence(out)) {
      const match = /^(\S+)/.exec(next);
      const first = match?.[1];
      // Compare the bare word so trailing punctuation ("Then,") still qualifies.
      const bare = first ? first.replace(/[^A-Za-z'’]+$/, "") : "";
      if (bare && canLower(bare)) {
        next = bare.charAt(0).toLowerCase() + next.slice(1);
      }
    }
    out += " " + next;
  }
  return out;
}

module.exports = { joinTranscriptSegments, endsSentence };
