/**
 * Word-level diff between two transcripts of the same audio.
 *
 * Built for the history view's dual breakdown, where the interesting part of two
 * near-identical transcripts is the handful of words they disagree on — a name, a
 * number, a spoken punctuation mark. A character diff would fragment those into
 * unreadable slivers, so tokens are whole words and the whitespace between them
 * rides along with the word before it.
 *
 * Two tiers, because both matter but not equally. A different word ("Priya" vs "Pria",
 * "5%" vs "five percent") is a disagreement about what was said and is marked loudly.
 * The same word with different punctuation or case ("click," vs "click") is marked
 * quietly: in dual mode both sides are raw ASR output, so it is still the providers
 * disagreeing — and if it were left unmarked, two transcripts that visibly differ would
 * render with nothing highlighted at all, which reads as a broken diff.
 */
export interface DiffToken {
  text: string;
  /** A different word here than the other side had. */
  changed: boolean;
  /** Same word, different punctuation or capitalisation. */
  punctuationOnly?: boolean;
}

export interface TranscriptDiff {
  a: DiffToken[];
  b: DiffToken[];
  /** Words that differ, over the longer side. 0 when the two agree word for word. */
  changeRatio: number;
  /** True when the only differences are punctuation or case. */
  punctuationOnly: boolean;
}

function tokenize(text: string): string[] {
  // Keeps trailing whitespace on each token so joining the tokens restores the
  // original string exactly, including line breaks.
  return text.match(/\S+\s*/g) ?? [];
}

function normalize(token: string): string {
  return token
    .toLowerCase()
    .replace(/[.,!?;:"'“”‘’()\[\]]/g, "")
    .trim();
}

/**
 * Longest common subsequence over normalised words, then mark everything outside it.
 *
 * O(n*m) in time and space, which is fine for dictation: these are transcripts of a
 * few seconds to a few minutes of speech, so a few hundred words at the outside.
 */
export function diffTranscripts(textA: string, textB: string): TranscriptDiff {
  const rawA = tokenize(textA);
  const rawB = tokenize(textB);
  const normA = rawA.map(normalize);
  const normB = rawB.map(normalize);

  const lengths: number[][] = Array.from({ length: rawA.length + 1 }, () =>
    new Array(rawB.length + 1).fill(0)
  );
  for (let i = rawA.length - 1; i >= 0; i--) {
    for (let j = rawB.length - 1; j >= 0; j--) {
      lengths[i][j] =
        normA[i] === normB[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const a: DiffToken[] = [];
  const b: DiffToken[] = [];
  let i = 0;
  let j = 0;
  let common = 0;
  let punctuationDiffs = 0;
  while (i < rawA.length && j < rawB.length) {
    if (normA[i] === normB[j]) {
      // Same word either way; flag it quietly when only the punctuation or case moved.
      const cosmetic = rawA[i].trim() !== rawB[j].trim();
      if (cosmetic) punctuationDiffs += 1;
      a.push({ text: rawA[i], changed: false, punctuationOnly: cosmetic });
      b.push({ text: rawB[j], changed: false, punctuationOnly: cosmetic });
      common += 1;
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      a.push({ text: rawA[i], changed: true });
      i += 1;
    } else {
      b.push({ text: rawB[j], changed: true });
      j += 1;
    }
  }
  while (i < rawA.length) a.push({ text: rawA[i++], changed: true });
  while (j < rawB.length) b.push({ text: rawB[j++], changed: true });

  const longest = Math.max(rawA.length, rawB.length);
  const changeRatio = longest === 0 ? 0 : (longest - common) / longest;
  return { a, b, changeRatio, punctuationOnly: changeRatio === 0 && punctuationDiffs > 0 };
}
