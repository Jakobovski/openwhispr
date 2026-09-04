// When to stop waiting for a multi-provider dictation.
//
// Two rules, and the second one is why this is a module rather than a few lines
// inline: it is timing logic that is invisible in normal use and only shows up as
// "sometimes dictation takes ages", which is exactly the kind of thing that needs
// tests rather than reasoning.
//
//   1. The wait for the *first* success ignores the short slow-lane budget. A lane that
//      fails fast — a 401, an empty response — must not shorten anyone else's wait, and dropping every
//      lane for missing a deadline would leave the dictation with no transcript at
//      all. Failures are skipped and the wait continues to the next lane. A separate
//      hard safety deadline still applies, because a network request may never settle
//      and the UI must not stay in "processing" forever.
//
//      Once there is a transcript, the cutoff is an absolute deadline the caller
//      supplies — normally the end of the recording plus the budget. That is what the
//      user actually experiences: time since they stopped talking. Measuring from the
//      first answer instead makes the cutoff depend on which lane won, so a batch lane
//      answering at 900ms silently granted everyone 900ms more.
//
//   2. Once a transcript exists, everything still outstanding shares one budget.
//      Not per-lane: the point of the budget is to bound the tail latency this mode
//      adds over a single provider, and that bound must not grow with lane count.
//      Whatever has not landed when it expires is abandoned.
//
// Deliberately not a deadline on the whole fan-out, which would drop every lane when
// the network is merely slow and leave the user with nothing.

/**
 * @param {Array<Promise<number>>} tracked One promise per lane, each resolving to its
 *   own index once that lane has settled. Never rejects.
 * @param {Array<{status: string}|null>} settled Written by the caller as lanes settle;
 *   read here to tell a success from a failure. Indexes match `tracked`.
 * @param {number} budgetMs How long the remaining lanes get after the first success.
 * @param {object} [options]
 * @param {number} [options.deadlineAt] Absolute performance.now() cutoff, normally the
 *   end of the recording plus the budget. Overrides budgetMs when given, so the wait is
 *   measured from when the user stopped talking rather than from the first answer.
 * @param {number} [options.firstSuccessDeadlineAt] Independent hard safety deadline for
 *   receiving any usable transcript.
 * @returns {Promise<{firstSuccessIndex: number, droppedIndexes: number[], timedOut: boolean}>}
 *   firstSuccessIndex is -1 when every lane failed.
 */
async function awaitLanesWithBudget(
  tracked,
  settled,
  budgetMs,
  { deadlineAt, firstSuccessDeadlineAt } = {}
) {
  // Race only the lanes still outstanding. A settled promise would win instantly and
  // spin this loop, so each winner is removed before the next round.
  let remaining = tracked.map((promise, index) => ({ promise, index }));
  let firstSuccessIndex = -1;
  let firstTimer;
  const firstExpired = Symbol("first-success-expired");
  const firstDeadline =
    typeof firstSuccessDeadlineAt === "number"
      ? new Promise((resolve) => {
          firstTimer = setTimeout(
            () => resolve(firstExpired),
            Math.max(0, firstSuccessDeadlineAt - performance.now())
          );
        })
      : null;

  try {
    while (remaining.length > 0) {
      const winner = await Promise.race([
        ...remaining.map((entry) => entry.promise),
        ...(firstDeadline ? [firstDeadline] : []),
      ]);
      if (winner === firstExpired) {
        return {
          firstSuccessIndex: -1,
          droppedIndexes: remaining
            .filter(({ index }) => settled[index] === null)
            .map(({ index }) => index),
          timedOut: true,
        };
      }
      remaining = remaining.filter((entry) => entry.index !== winner);
      if (settled[winner]?.status === "fulfilled") {
        firstSuccessIndex = winner;
        break;
      }
    }
  } finally {
    clearTimeout(firstTimer);
  }

  // Every lane failed. The loop above already awaited all of them, so there is
  // nothing outstanding and no budget to enforce.
  if (firstSuccessIndex === -1) return { firstSuccessIndex, droppedIndexes: [], timedOut: false };

  const outstanding = remaining.map((entry) => entry.promise);
  if (outstanding.length === 0) return { firstSuccessIndex, droppedIndexes: [], timedOut: false };

  // Anchored to the end of the recording when the caller supplies a deadline, rather than
  // to whichever lane happened to answer first.
  //
  // Those differ by more than they look. A streaming lane answers about 60ms after the
  // last frame, so a budget measured from the first success starts almost at the tail —
  // but if a *batch* lane answers first at 900ms, the same budget pushes the cutoff to
  // 900ms + budget after the tail. What the user waits is time since they stopped
  // talking, so that is what the deadline is measured in.
  //
  // The short slow-lane deadline never drops every lane. The independent first-success
  // safety deadline above is the only whole-fan-out bound.
  const remainingMs =
    typeof deadlineAt === "number" ? Math.max(0, deadlineAt - performance.now()) : budgetMs;

  if (remainingMs > 0) {
    let timer;
    const expired = Symbol("expired");
    await Promise.race([
      Promise.all(outstanding),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(expired), remainingMs);
      }),
    ]);
    clearTimeout(timer);
  }

  const droppedIndexes = [];
  for (const { index } of remaining) {
    if (settled[index] === null) droppedIndexes.push(index);
  }
  return { firstSuccessIndex, droppedIndexes, timedOut: false };
}

/**
 * First lane to succeed wins, immediately — no grace period for the rest.
 *
 * This is the merge race, not the transcription fan-out: awaitLanesWithBudget waits
 * out its budget after the first success because it is gathering candidate
 * transcripts for something downstream to reconcile. The merge race has nothing
 * downstream — each lane's answer is already the final, cleaned text, so a second one
 * is never used once the first lands, and waiting for it would only add latency for
 * nothing.
 *
 * @param {Array<Promise<number>>} tracked One promise per lane, each resolving to its
 *   own index once that lane has settled. Never rejects.
 * @param {Array<{status: string}|null>} settled Written by the caller as lanes settle;
 *   read here to tell a success from a failure. Indexes match `tracked`.
 * @param {number} budgetMs How long to wait for ANY lane to succeed before giving up.
 * @returns {Promise<{winnerIndex: number, timedOut: boolean}>} winnerIndex is -1 when
 *   nothing succeeded — either every lane failed (timedOut false, nothing left to
 *   wait for) or the budget ran out with lanes still outstanding (timedOut true).
 */
async function raceLanesForFirstSuccess(tracked, settled, budgetMs) {
  let remaining = tracked.map((promise, index) => ({ promise, index }));
  let timer;
  const expired = Symbol("expired");
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(expired), budgetMs);
  });

  try {
    while (remaining.length > 0) {
      const winner = await Promise.race([...remaining.map((entry) => entry.promise), deadline]);
      if (winner === expired) return { winnerIndex: -1, timedOut: true };
      remaining = remaining.filter((entry) => entry.index !== winner);
      if (settled[winner]?.status === "fulfilled") {
        return { winnerIndex: winner, timedOut: false };
      }
      // That lane failed — keep racing whatever's left against the same deadline.
    }
    // Every lane failed outright, and the loop already awaited all of them: nothing
    // left to wait for, so there is no need to also wait out the deadline.
    return { winnerIndex: -1, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Awaits a promise, giving up after `budgetMs`.
 *
 * Used for the merge, which sits in the paste path and so gets a deadline like the
 * lanes do. An in-flight LLM request cannot be cancelled, so a promise abandoned here
 * is left to settle on its own and its result ignored — with its rejection swallowed,
 * because an abandoned failure would otherwise surface as an unhandled rejection long
 * after the dictation it belonged to is finished.
 *
 * A rejection that arrives *before* the budget expires still propagates: the caller
 * needs to distinguish "the merge failed" from "the merge was too slow" only in what it
 * logs, but it must not mistake a failure for a success either way.
 *
 * @returns {Promise<{timedOut: boolean, value?: unknown}>}
 */
async function raceWithBudget(promise, budgetMs) {
  let timer;
  const expired = Symbol("expired");
  try {
    const outcome = await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(expired), budgetMs);
      }),
    ]);
    if (outcome === expired) {
      promise.catch(() => {});
      return { timedOut: true };
    }
    return { timedOut: false, value: outcome };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { awaitLanesWithBudget, raceLanesForFirstSuccess, raceWithBudget };
