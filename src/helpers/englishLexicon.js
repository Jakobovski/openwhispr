const fs = require("fs");

// Drops ordinary English words from a screen-term list using the system dictionary.
//
// This exists because a curated list cannot cover the tail. Screens show prose, and
// prose contains words like "penultimate" and "reticent" that no hand-written list of
// UI chrome will ever include — but which are plainly English and therefore useless as
// dictation vocabulary. macOS ships 236k of them.
//
// It is not sufficient on its own: /usr/share/dict/words is Webster's 1934, so it
// predates the entire modern computing vocabulary. "email", "website", "settings",
// "download", "inbox" and "online" are all absent from it. That is what
// SCREEN_CHROME_WORDS covers. The two lists are complementary, not redundant.
//
// Loaded once, lazily, on the first capture — not at startup, which would pay for it
// on every launch whether or not the user dictates. Roughly 23 MB resident for the
// session, which buys an O(1) lookup per term instead of re-reading 2.5 MB.
//
// Absent file, unreadable file, wrong platform: the term list is returned untouched
// and screen context degrades to the curated lists rather than failing.

// Symlinked to web2 on macOS. Checked in order; the first readable one wins.
const DICTIONARY_PATHS = ["/usr/share/dict/words", "/usr/share/dict/web2"];

// Terms shorter than this are already rejected by the matcher's length floor, so
// there is no point holding the dictionary's short words.
const MIN_CACHED_LENGTH = 4;

// null = not loaded yet, false = tried and unavailable, Set = ready.
let lexicon = null;

function load() {
  for (const candidate of DICTIONARY_PATHS) {
    let raw;
    try {
      raw = fs.readFileSync(candidate, "utf8");
    } catch {
      continue;
    }

    const words = new Set();
    let start = 0;
    while (start < raw.length) {
      let end = raw.indexOf("\n", start);
      if (end === -1) end = raw.length;
      // Slicing rather than splitting the whole file: one pass, no 236k-element array.
      if (end - start >= MIN_CACHED_LENGTH) {
        words.add(raw.slice(start, end).toLowerCase());
      }
      start = end + 1;
    }

    if (words.size > 0) return words;
  }
  return false;
}

/** The loaded dictionary, or false when this machine has none. */
function getLexicon() {
  if (lexicon === null) lexicon = load();
  return lexicon;
}

/**
 * Base forms to try for an inflected word, cheapest first.
 *
 * The dictionary lists lemmas, so "request" is there and "Requests" is not — and
 * plurals and participles are most of what a UI is made of ("Files changed",
 * "Commits", "Reviewers", "approved"). Without this they all survive as candidate
 * vocabulary, which was the second half of the reported noise.
 *
 * Deliberately crude, and only ever used to *reject* a term. Over-stemming costs one
 * lost correction; under-stemming puts a word like "Checks" in front of the user as
 * though it were a name. Names rarely reduce to a real word this way — "Kubernetes"
 * gives "Kubernet", "Grafana" gives nothing.
 */
function baseForms(lower) {
  const forms = [];
  const add = (form) => {
    if (form.length >= MIN_CACHED_LENGTH) forms.push(form);
  };

  if (lower.endsWith("ies")) add(lower.slice(0, -3) + "y"); // libraries -> library
  if (lower.endsWith("es")) add(lower.slice(0, -2)); // pushes -> push
  if (lower.endsWith("s") && !lower.endsWith("ss")) add(lower.slice(0, -1)); // files -> file
  if (lower.endsWith("ed")) {
    add(lower.slice(0, -2)); // checked -> check
    add(lower.slice(0, -1)); // approved -> approve
  }
  if (lower.endsWith("ing")) {
    add(lower.slice(0, -3)); // checking -> check
    add(lower.slice(0, -3) + "e"); // merging -> merge
  }
  if (lower.endsWith("ers")) add(lower.slice(0, -1)); // reviewers -> reviewer
  if (lower.endsWith("ly")) add(lower.slice(0, -2)); // recently -> recent
  return forms;
}

function isEnglishWord(word) {
  const words = getLexicon();
  if (words === false) return false;

  const lower = String(word).toLowerCase();
  if (words.has(lower)) return true;
  return baseForms(lower).some((form) => words.has(form));
}

/**
 * @param {string[]} terms Candidate screen terms, in priority order.
 * @returns {{terms: string[], dropped: number, available: boolean}}
 */
function dropDictionaryWords(terms) {
  const input = Array.isArray(terms) ? terms : [];
  const words = getLexicon();
  if (words === false || input.length === 0) {
    return { terms: input, dropped: 0, available: words !== false };
  }

  const kept = input.filter((term) => !isEnglishWord(term));
  return { terms: kept, dropped: input.length - kept.length, available: true };
}

/** Test seam: forces the next call to reload. */
function resetForTests() {
  lexicon = null;
}

module.exports = { dropDictionaryWords, isEnglishWord, resetForTests, DICTIONARY_PATHS };
