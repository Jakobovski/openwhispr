const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// The merge step became unconditional. It was skipped whenever there was nothing to
// reconcile — a single answer, or several identical ones — which was right about
// reconciling and wrong about everything else the same call does: it applies the
// speaker's vocabulary (dictionary plus the terms read off screen) and it cleans,
// punctuates and de-fillers the text. The most common dictations are the ones where the
// recognisers agree, so the skip meant the common case pasted raw recogniser output
// while only the disagreeing minority got prepared.
//
// Static scans over the fan-out: exercising it for real needs a store, three provider
// endpoints, a merge model and a wall clock, and the thing worth pinning down is which
// branches exist.

const ROOT = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const audioManager = read("src", "helpers", "audioManager.js");

const LOCALES = fs
  .readdirSync(path.join(ROOT, "src", "locales"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const fanOut = (() => {
  const start = audioManager.indexOf("async transcribeMulti(");
  const end = audioManager.indexOf("\n  getTranscriptionModel() {", start);
  const slice = audioManager.slice(start, end);
  assert.ok(slice.length > 1000, "could not isolate transcribeMulti — has it moved?");
  return slice;
})();

test("nothing short-circuits the merge any more", () => {
  // The two early returns that used to bypass it. Either one coming back means the
  // vocabulary and the cleanup silently stop applying to whole classes of dictation.
  assert.doesNotMatch(
    fanOut,
    /if \(answered\.length === 1\) \{\s*\n\s*return/,
    "a single answer bypasses the merge again"
  );
  assert.doesNotMatch(
    fanOut,
    /if \(transcriptsAgree\([^)]*\)\) \{\s*\n\s*(logger|return)/,
    "agreement bypasses the merge again"
  );
});

test("agreement is still measured, just no longer acted on", () => {
  // It says something real about the lanes, and history and the log both report it.
  assert.match(fanOut, /const agreed = answered\.length > 1 && transcriptsAgree\(/);
});

test("the merge is reached with a single answer", () => {
  // The only guard left before the merge call is "no answers at all", which is an error.
  // From the answer list to the merge call. Starting earlier catches the `return` inside
  // the sides.map callback, which is not an early exit at all — the first version of this
  // check failed on it.
  const beforeMerge = fanOut.slice(
    fanOut.indexOf("const answered = sides.filter"),
    fanOut.indexOf("const reconcileStart")
  );
  const returns = beforeMerge.match(/\n\s*return \{/g) ?? [];
  assert.equal(
    returns.length,
    0,
    "something returns before the merge; only the no-answers throw belongs there"
  );
  assert.match(beforeMerge, /if \(answered\.length === 0\)/, "the no-answers guard is gone");
});

test("a single-answer dictation is not scored for word error rate", () => {
  // The merge now runs on one answer, so `reconciled` alone would score that lane
  // against a cleaned copy of its own text — a near-perfect rate it did nothing to earn,
  // measuring how much tidying it needed rather than how much it misheard.
  assert.match(
    audioManager,
    /const werReference =\s*multi\.reconciled && \(multi\.mergedFrom \?\? 0\) > 1 \? multi\.text : null;/,
    "the WER reference must require more than one answer, not just a merge"
  );
});

test("the prompt tells the model its input may be a single transcript", () => {
  // It used to open with "two or more", which is now a lie on any dictation where one
  // provider answered — and the model was being asked to reconcile one version with
  // itself.
  const pairClaims = {
    en: "two or more independent",
    es: "dos o más transcripciones",
    fr: "deux transcriptions indépendantes ou plus",
    de: "zwei oder mehr unabhängige",
    pt: "duas ou mais transcrições",
    it: "due o più trascrizioni",
    ru: "два или более независимых",
    ja: "2つ以上の音声認識エンジン",
    "zh-CN": "两份或更多份独立语音识别",
    "zh-TW": "兩份或更多份獨立語音辨識",
  };
  for (const locale of LOCALES) {
    const prompt = JSON.parse(read("src", "locales", locale, "prompts.json")).reconcilePrompt;
    const claim = pairClaims[locale];
    assert.ok(claim, `no pair-claim phrase known for "${locale}" — add one`);
    assert.ok(!prompt.includes(claim), `${locale} still tells the model to expect two or more`);
  }
});

test("every locale carries the frequency-bias rule, above the majority rule", () => {
  // Recognisers pull rare words toward common ones, and they all do it the same way, so
  // two of them agreeing on the commoner word is expected rather than corroborating.
  // The rule therefore has to sit *before* the majority tie-break in the prompt, or the
  // model reads the tie-break first and the correction never happens.
  const biasWords = {
    en: ["biased toward frequent words", "rarer, more specific"],
    es: ["sesgados hacia las palabras frecuentes", "más rara y específica"],
    fr: ["biaisés vers les mots fréquents", "plus rare et la plus spécifique"],
    de: ["häufige Wörter voreingenommen", "seltenere, spezifischere"],
    pt: ["enviesados a favor de palavras frequentes", "mais rara e específica"],
    it: ["sbilanciati verso le parole frequenti", "più rara e specifica"],
    ru: ["смещены в сторону частых слов", "более редкий и конкретный"],
    ja: ["頻出語に偏っています", "まれで具体的なほう"],
    "zh-CN": ["偏向常见词", "更罕见、更具体"],
    "zh-TW": ["偏向常見詞", "更罕見、更具體"],
  };
  const majorityWords = {
    en: "majority",
    es: "mayoría",
    fr: "majorité",
    de: "Mehrheit",
    pt: "maioria",
    it: "maggioranza",
    ru: "большинств",
    ja: "多数決",
    "zh-CN": "多数",
    "zh-TW": "多數",
  };

  for (const locale of LOCALES) {
    const prompt = JSON.parse(read("src", "locales", locale, "prompts.json")).reconcilePrompt;
    const phrases = biasWords[locale];
    assert.ok(phrases, `no bias-rule phrases known for "${locale}" — add them`);
    for (const phrase of phrases) {
      assert.ok(prompt.includes(phrase), `${locale} is missing the bias rule ("${phrase}")`);
    }
    const biasAt = prompt.indexOf(phrases[0]);
    const majorityAt = prompt.indexOf(majorityWords[locale]);
    assert.ok(majorityAt > 0, `${locale}: could not find the majority rule to compare against`);
    assert.ok(
      biasAt < majorityAt,
      `${locale}: the bias rule must come before the majority rule, or the tie-break wins`
    );
  }
});

test("a merge that produces no text is reported as dropped, not as nothing to merge", () => {
  // The history row derives three states from `reconciled` and `reconcileDropped`, and
  // nothing ever assigned the second one — so a merge that timed out or failed showed as
  // "nothing to merge", which reads as "the recognisers agreed". It hid a real case: a
  // 750ms budget expired, the fan-out pasted slot A's raw text, and that text said
  // "Who's a good chance" where the other two lanes both said "There's".
  //
  // Every path that returns without merged text must say so. Counted rather than
  // pattern-matched across the whole file, so a third such path added later fails here
  // instead of quietly inheriting the old label.
  const noMergePaths = audioManager.match(/reconciled: false,\n\s+(\/\/[^\n]*\n\s+)*reconcileDropped: true,/g);
  assert.equal(
    (noMergePaths || []).length,
    2,
    "both the timed-out/failed path and the empty-winner path must set reconcileDropped"
  );

  // And the successful path must not claim to be dropped.
  assert.doesNotMatch(
    audioManager,
    /reconciled: true,\n\s+reconcileDropped: true/,
    "a merge that produced text is not dropped"
  );
});
