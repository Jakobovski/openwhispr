/**
 * Extracts transcription corrections by diffing original text against
 * the edited field value. Returns corrected words to add to the custom dictionary.
 */

/** Levenshtein edit distance between two strings */
// How much of the dictation must survive in the field for an edit to be treated
// as a correction rather than a different context entirely.
const MIN_RETAINED_WORD_RATIO = 0.5;

// Main-process only, like this module's one caller in ipcHandlers. Reads the system word
// list, and reports every word as unknown if it cannot — so a machine without
// /usr/share/dict/words learns what it always did rather than learning nothing.
const { isEnglishWord } = require("../helpers/englishLexicon");

// Contraction and possessive tails, straight and curly. An inflection is never the term
// worth learning, and the lexicon cannot help here anyway: it holds nothing under four
// letters, so the base of don't, it's, I'm and didn't reads as an unknown word. Real
// entries this produced: there's, it's, I'm, that's, don't, didn't, doesn't, shouldn't,
// repository's.
const CONTRACTION_TAIL = /(?:n['\u2019]t|['\u2019](?:s|re|ve|ll|d|m))$/i;

// Sentence punctuation inside a token means the tokenizer glued two words together across
// a missing space — "those.Not" is in a real dictionary from this. A single vocabulary
// term never contains it, and anything genuinely punctuated can be added by hand.
const SENTENCE_PUNCTUATION = /[.,;:!?]/;

/**
 * Is this correction a word of the language rather than vocabulary worth biasing for?
 *
 * The dictionary exists for terms a recogniser mishears — names, jargon, product names.
 * A correction from one real word to another is the user fixing wording or grammar, and
 * feeding it back as a recognition hint is noise at best: every term here is sent to every
 * provider on every dictation.
 */
function isNotWorthLearning(word) {
  if (!/\p{L}/u.test(word)) return true; // "100"
  if (SENTENCE_PUNCTUATION.test(word)) return true; // "those.Not"
  if (isEnglishWord(word)) return true; // "scraping", "Whey"
  // Any contraction or possessive, without consulting the lexicon about the base.
  //
  // Not "reject it if the base is an English word": the lexicon holds nothing shorter
  // than four letters, so "do", "it", "did" and "the" all read as unknown and don't,
  // it's, I'm and didn't survived that version of this check. And the base being a real
  // term does not make the inflected form worth having — "Zohar's" is not the entry, and
  // if "Zohar" is worth learning it will be learned from a correction of the name itself.
  return CONTRACTION_TAIL.test(word);
}

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/** Tokenize text into words, stripping punctuation from edges */
function tokenize(text) {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, ""))
    .filter((w) => w.length > 0);
}

/**
 * Find the region in fieldValue that corresponds to the pasted originalText.
 * If the field only contains the pasted text, returns fieldValue as-is.
 */
function findEditedRegion(originalText, fieldValue) {
  if (fieldValue.length <= originalText.length * 1.5) {
    return fieldValue;
  }

  const idx = fieldValue.indexOf(originalText);
  if (idx !== -1) {
    return originalText;
  }

  // Sliding window: find the region with highest word overlap
  const origWords = tokenize(originalText);
  const fieldWords = tokenize(fieldValue);
  const windowSize = origWords.length;

  if (fieldWords.length <= windowSize) {
    return fieldValue;
  }

  let bestStart = 0;
  let bestScore = -1;

  for (let i = 0; i <= fieldWords.length - windowSize; i++) {
    let matches = 0;
    for (let j = 0; j < windowSize; j++) {
      if (fieldWords[i + j].toLowerCase() === origWords[j].toLowerCase()) {
        matches++;
      }
    }
    if (matches > bestScore) {
      bestScore = matches;
      bestStart = i;
    }
  }

  // Require at least 30% word overlap to consider it a match
  if (bestScore < windowSize * 0.3) {
    return fieldValue;
  }

  return fieldWords.slice(bestStart, bestStart + windowSize).join(" ");
}

/** Word-level LCS to find [originalWord, editedWord] substitution pairs. */
function findSubstitutions(origWords, editedWords) {
  const m = origWords.length;
  const n = editedWords.length;

  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (origWords[i - 1].toLowerCase() === editedWords[j - 1].toLowerCase()) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const aligned = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origWords[i - 1].toLowerCase() === editedWords[j - 1].toLowerCase()) {
      aligned.unshift([origWords[i - 1], editedWords[j - 1]]);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      aligned.unshift([null, editedWords[j - 1]]);
      j--;
    } else {
      aligned.unshift([origWords[i - 1], null]);
      i--;
    }
  }

  // Consecutive [origWord, null] + [null, editedWord] = substitution
  const subs = [];
  for (let k = 0; k < aligned.length - 1; k++) {
    const [origW, editW] = aligned[k];
    const [nextOrigW, nextEditW] = aligned[k + 1];

    if (origW !== null && editW === null && nextOrigW === null && nextEditW !== null) {
      subs.push([origW, nextEditW]);
    }
  }

  return subs;
}

/**
 * Extract corrected words from a user's edits to pasted transcription text.
 *
 * @param {string} originalText - The text that was originally pasted (from transcription)
 * @param {string} fieldValue - The current value of the text field (after user edits)
 * @param {string[]} existingDictionary - Words already in the custom dictionary
 * @returns {string[]} Array of corrected words to add to the dictionary
 */
function extractCorrections(originalText, fieldValue, existingDictionary) {
  if (!originalText || !fieldValue) return [];
  if (originalText === fieldValue) return [];

  const editedRegion = findEditedRegion(originalText, fieldValue);
  if (editedRegion === originalText) return [];

  const origWords = tokenize(originalText);
  const editedWords = tokenize(editedRegion);

  if (origWords.length === 0 || editedWords.length === 0) return [];

  // The field must still substantially contain the dictation. When it does not,
  // this is not an edit of our text at all: the user submitted and the field
  // cleared, or the accessibility read returned the field's placeholder ("Type /
  // for commands"). Diffing a transcript against unrelated text finds spurious
  // substitutions and learns them as corrections.
  const editedSet = new Set(editedWords.map((w) => w.toLowerCase()));
  const retained = origWords.filter((w) => editedSet.has(w.toLowerCase())).length;
  if (retained / origWords.length < MIN_RETAINED_WORD_RATIO) return [];

  // If more than 50% of words changed, this is a rewrite, not corrections
  const subs = findSubstitutions(origWords, editedWords);
  if (subs.length > origWords.length * 0.5) return [];

  const safeDict = Array.isArray(existingDictionary) ? existingDictionary : [];
  const dictSet = new Set(safeDict.map((w) => w.toLowerCase()));
  const seenCorrections = new Set();
  const results = [];

  for (const [origWord, correctedWord] of subs) {
    const normalizedCorrected = correctedWord.toLowerCase();

    if (dictSet.has(normalizedCorrected)) continue;
    if (seenCorrections.has(normalizedCorrected)) continue;
    if (origWord.toLowerCase() === normalizedCorrected) continue;
    if (correctedWord.length < 3) continue;
    if (isNotWorthLearning(correctedWord)) continue;

    // 0.65 threshold allows phonetic corrections like "Shunade" → "Sinead" (dist 4/7 = 0.57)
    // while filtering out unrelated word replacements.
    const dist = editDistance(origWord.toLowerCase(), correctedWord.toLowerCase());
    const maxLen = Math.max(origWord.length, correctedWord.length);
    if (dist / maxLen > 0.65) continue;

    results.push(correctedWord);
    seenCorrections.add(normalizedCorrected);
  }

  return results;
}

module.exports = { extractCorrections };
