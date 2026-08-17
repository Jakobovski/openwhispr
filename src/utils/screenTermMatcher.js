// Corrects a transcript against terms OCR'd from the user's screen.
//
// Unlike correctionLearner, which learns from edits the user already made (so
// precision is guaranteed by construction), this substitutes speculatively.
// A false positive silently corrupts a correct transcript, which is worse than
// missing a fix — so every rule here is biased toward precision:
//
//   Tier 1 (recase)     an exact case-insensitive hit adopts the screen's
//                       casing — semantically a no-op ("github" -> "GitHub").
//   Tier 2 (substitute) a near-miss is replaced only when the screen term is
//                       distinctive and the two are phonetically equivalent.
//
// Neither tier touches a word that is ordinary English, so prose survives a
// screen full of UI labels.
//
// Terms come from the screen at dictation time and are never persisted — see
// the custom dictionary for the durable vocabulary.

const { COMMON_WORDS } = require("./commonWords");

// Screen text is mostly chrome — menu labels, prose, button text. Only terms a
// recognizer would plausibly get wrong are worth matching against.
const MIN_TERM_LENGTH = 4;
// A safety bound for a pathological window (a minified bundle, a log dump), not a
// quality filter. It used to be 400, which quietly discarded the best candidates:
// terms are ordered by frequency, so the tail is the words that appeared once —
// exactly where an unusual name or identifier lives. Raising it costs a larger map
// per dictation and nothing else, and it does not make tier 2 less careful: two
// terms sharing a phonetic key are dropped rather than guessed between, so a longer
// list detects *more* ambiguity, not less.
const MAX_TERMS = 5000;
// Sanity bound on a tier-2 substitution, not the precision mechanism — the
// phonetic key is what decides whether two words could be the same utterance.
// Kept loose enough for genuine mishearings ("Shunade"/"Sinead" is 4/7 = 0.57);
// words far enough apart to exceed it were almost certainly bucketed by accident.
const MAX_SUBSTITUTION_DISTANCE = 0.6;

function editDistance(a, b) {
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

// Collapses the spelling differences an ASR actually produces: it hears sounds,
// so "Shunade"/"Sinead" and "Kubernetes"/"Coobernetties" should collide. Cheap
// Soundex-style folding, not a full metaphone.
function phoneticKey(word) {
  let s = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return "";
  s = s
    .replace(/([a-z])\1+/g, "$1") // doubled letters
    .replace(/ph/g, "f")
    .replace(/(?:ck|q|kh)/g, "k")
    .replace(/(?:sh|ch|zh|sch)/g, "s")
    .replace(/(?:c)(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/(?:x)/g, "ks")
    .replace(/(?:z)/g, "s")
    .replace(/(?:th|dh)/g, "t")
    .replace(/(?:gh|g)/g, "g")
    .replace(/(?:v|w)/g, "v")
    .replace(/(?:y|j)/g, "i");
  const head = s[0];
  // Vowels carry the least signal in ASR errors; keep the leading one for anchoring.
  return head + s.slice(1).replace(/[aeiou]/g, "");
}

// Distinctive = unlikely to be in the recognizer's vocabulary, so a near-miss is
// probably a mishearing of it rather than a coincidence. Mixed case ("OpenWhispr"),
// digits ("s3"), internal punctuation ("api_key") or simply not-a-common-word.
function isDistinctiveTerm(term) {
  if (term.length < MIN_TERM_LENGTH) return false;
  if (COMMON_WORDS.has(term.toLowerCase())) return false;
  if (/[A-Z]/.test(term.slice(1))) return true; // internal capital
  if (/[0-9._\-/]/.test(term)) return true;
  if (/^[A-Z]/.test(term)) return true; // proper-noun shaped
  return true;
}

/**
 * Pull candidate vocabulary out of raw OCR text.
 *
 * @param {string} ocrText - Raw text recognized from the screenshot
 * @returns {string[]} Distinctive terms, most frequent first, capped
 */
function extractScreenTerms(ocrText) {
  if (!ocrText || typeof ocrText !== "string") return [];

  // Keep internal ._- so identifiers survive; strip surrounding punctuation.
  // `/` splits: a repo or path ("OpenWhispr/openwhispr", "src/utils") is more
  // useful as its parts, since the recognizer only ever hears one at a time.
  const raw = ocrText.split(/[\s/,;:!?()[\]{}"'`<>|=+*]+/);
  const counts = new Map();
  const display = new Map();

  for (const token of raw) {
    const term = token.replace(/^[._\-/]+|[._\-/]+$/g, "").trim();
    if (!term || !isDistinctiveTerm(term)) continue;
    const key = term.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
    // Prefer a cased form over an all-lower/all-upper one for display.
    const seen = display.get(key);
    if (!seen || (/[A-Z]/.test(term) && !/^[A-Z]+$/.test(term))) {
      display.set(key, term);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TERMS)
    .map(([key]) => display.get(key));
}

function splitToken(token) {
  const match = /^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$/.exec(token);
  return match ? { lead: match[1], core: match[2], trail: match[3] } : null;
}

/**
 * Rewrite a transcript using vocabulary visible on screen.
 *
 * @param {string} transcript - Text as transcribed
 * @param {string[]} screenTerms - Terms from extractScreenTerms()
 * @returns {{text: string, replacements: Array<{from: string, to: string, kind: string}>}}
 */
function applyScreenTermCorrections(transcript, screenTerms) {
  const empty = { text: transcript || "", replacements: [] };
  if (!transcript || typeof transcript !== "string") return empty;
  if (!Array.isArray(screenTerms) || screenTerms.length === 0) return empty;

  const byLower = new Map();
  const byPhonetic = new Map();
  for (const term of screenTerms) {
    if (typeof term !== "string" || !term.trim()) continue;
    const lower = term.toLowerCase();
    if (!byLower.has(lower)) byLower.set(lower, term);
    const key = phoneticKey(term);
    // Ambiguous phonetic keys are dropped rather than guessed between.
    if (key) {
      if (byPhonetic.has(key)) {
        if (byPhonetic.get(key)?.toLowerCase() !== lower) byPhonetic.set(key, null);
      } else {
        byPhonetic.set(key, term);
      }
    }
  }

  const replacements = [];
  const text = transcript.replace(/\S+/g, (token) => {
    const parts = splitToken(token);
    if (!parts || !parts.core) return token;
    const { lead, core, trail } = parts;
    const lower = core.toLowerCase();

    // A real English word is never touched by either tier: "from" must survive a
    // screen full of "Form", and ordinary prose must not pick up UI capitalisation
    // ("pull request" -> "Pull request") just because a button said so.
    if (COMMON_WORDS.has(lower)) return token;

    // Tier 1 — same word, different casing. Semantically a no-op.
    const exact = byLower.get(lower);
    if (exact) {
      if (exact === core) return token;
      replacements.push({ from: core, to: exact, kind: "recase" });
      return lead + exact + trail;
    }

    // Tier 2 — a mishearing.
    if (core.length < MIN_TERM_LENGTH) return token;

    const candidate = byPhonetic.get(phoneticKey(core));
    if (!candidate) return token;
    if (COMMON_WORDS.has(candidate.toLowerCase())) return token;

    const dist = editDistance(lower, candidate.toLowerCase());
    const maxLen = Math.max(core.length, candidate.length);
    if (maxLen === 0 || dist / maxLen > MAX_SUBSTITUTION_DISTANCE) return token;

    replacements.push({ from: core, to: candidate, kind: "substitute" });
    return lead + candidate + trail;
  });

  return { text, replacements };
}

module.exports = {
  extractScreenTerms,
  applyScreenTermCorrections,
  phoneticKey,
  MAX_TERMS,
  MAX_SUBSTITUTION_DISTANCE,
};
