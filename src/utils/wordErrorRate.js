// Word error rate of one transcript against another.
//
// Used to score each provider in a multi-provider dictation against the merged result,
// which is the closest thing to ground truth available without someone transcribing by
// hand. That makes it a *relative* measure and worth being clear about:
//
//   - The reference is not truth. It is what the merge model concluded, and the merge
//     reads the very transcripts being scored. A provider that agrees with the others
//     scores well partly by construction.
//   - It only means anything when a real merge happened. When the providers agreed, or
//     the merge was dropped, the "final" text *is* one lane's output — scoring against
//     that hands that lane a free 0% and the others a penalty for losing a coin toss.
//     The caller is responsible for only recording the reconciled case.
//
// What it is good for is comparing providers *to each other* over many dictations: all
// lanes are scored against the same reference each time, so a lane that is consistently
// further from the merge is consistently the odd one out.
//
// Normalised before comparing, because the merge also cleans: it removes fillers, adds
// punctuation, fixes casing and rewrites numbers. Counting those as errors would measure
// how much cleanup the transcript needed rather than how much of it was misheard. Words
// only, lowercased, punctuation stripped.

function normalizeWords(text) {
  return (
    String(text || "")
      .toLowerCase()
      // Keep intra-word apostrophes ("don't"), drop everything else.
      .replace(/[^\p{L}\p{N}'\s]/gu, " ")
      .replace(/(^|\s)'+|'+(\s|$)/g, "$1$2")
      .split(/\s+/)
      .filter(Boolean)
  );
}

/**
 * Levenshtein distance over words: substitutions, insertions and deletions, which is
 * exactly the numerator WER is defined with.
 */
function wordEditDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[n];
}

/**
 * @param {string} hypothesis The provider's transcript.
 * @param {string} reference The merged transcript it is scored against.
 * @returns {number|null} Errors per reference word, or null when there is nothing to
 *   score. Not clamped to 1: a transcript can carry more errors than the reference has
 *   words, and hiding that would flatten exactly the outliers worth seeing.
 */
function wordErrorRate(hypothesis, reference) {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);

  // No reference words means no denominator. Reporting 0 would claim a perfect score
  // for a comparison that never happened.
  if (ref.length === 0) return null;
  return wordEditDistance(hyp, ref) / ref.length;
}

module.exports = { wordErrorRate, normalizeWords };
