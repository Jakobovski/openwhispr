// The speaker's vocabulary, normalised once for every provider that accepts one.
//
// Three providers now bias recognition on a term list — Azure's phrase list, Gemini's
// custom_vocabulary, Soniox's context.terms — and xAI takes keyterms. They disagree only
// on the ceiling and, for xAI, a per-term length limit. Everything else was being written
// out per provider, and had already drifted: the same list arrived deduplicated in one
// place and not another, and two of them had their own copy of the identical
// trim-dedupe-cap loop.
//
// The rules are the same everywhere and worth stating once:
//
//   - Trim, and drop anything that is empty afterwards. A blank term is not a hint.
//   - Deduplicate case-insensitively but keep the first spelling seen. The casing is the
//     whole point for a term like "OpenWhispr", and the list is assembled from two
//     sources that routinely supply the same word.
//   - Cap at the provider's own limit, keeping the head. The order is deliberate — the
//     curated dictionary comes before terms scraped off the screen — so truncating from
//     the end drops the least-vouched-for terms first.

/**
 * @param {unknown} terms - Candidate terms, from any source.
 * @param {object} [options]
 * @param {number} [options.limit] - Provider's ceiling on term count.
 * @param {number} [options.maxTermLength] - Provider's ceiling on a single term.
 * @returns {string[]}
 */
function normalizeDictationTerms(terms, { limit = Infinity, maxTermLength = Infinity } = {}) {
  if (!Array.isArray(terms)) return [];

  const seen = new Set();
  const out = [];
  for (const raw of terms) {
    if (typeof raw !== "string") continue;
    let term = raw.trim();
    if (!term) continue;
    if (term.length > maxTermLength) term = term.slice(0, maxTermLength);
    // Truncation can collide with a term already kept, so dedupe after it rather than
    // before, or a provider with a short term limit gets duplicates.
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { normalizeDictationTerms };
