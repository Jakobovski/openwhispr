// When to stop waiting for a multi-provider dictation.
//
// Two rules, and the second one is why this is a module rather than a few lines
// inline: it is timing logic that is invisible in normal use and only shows up as
// "sometimes dictation takes ages", which is exactly the kind of thing that needs
// tests rather than reasoning.
//
//   1. The budget starts when a lane *succeeds*, not when one answers. A lane that
//      fails fast — a 401, an empty response — must not start the clock on the
//      others: there is no transcript yet, so the budget would be spent protecting
//      latency with nothing to show for it. Failures are skipped and the wait
//      continues to the next lane.
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
 * @returns {Promise<{firstSuccessIndex: number, droppedIndexes: number[]}>}
 *   firstSuccessIndex is -1 when every lane failed.
 */
async function awaitLanesWithBudget(tracked, settled, budgetMs) {
  // Race only the lanes still outstanding. A settled promise would win instantly and
  // spin this loop, so each winner is removed before the next round.
  let remaining = tracked.map((promise, index) => ({ promise, index }));
  let firstSuccessIndex = -1;

  while (remaining.length > 0) {
    const winner = await Promise.race(remaining.map((entry) => entry.promise));
    remaining = remaining.filter((entry) => entry.index !== winner);
    if (settled[winner]?.status === "fulfilled") {
      firstSuccessIndex = winner;
      break;
    }
  }

  // Every lane failed. The loop above already awaited all of them, so there is
  // nothing outstanding and no budget to enforce.
  if (firstSuccessIndex === -1) return { firstSuccessIndex, droppedIndexes: [] };

  const outstanding = remaining.map((entry) => entry.promise);
  if (outstanding.length === 0) return { firstSuccessIndex, droppedIndexes: [] };

  let timer;
  const expired = Symbol("expired");
  await Promise.race([
    Promise.all(outstanding),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(expired), budgetMs);
    }),
  ]);
  clearTimeout(timer);

  const droppedIndexes = [];
  for (const { index } of remaining) {
    if (settled[index] === null) droppedIndexes.push(index);
  }
  return { firstSuccessIndex, droppedIndexes };
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

module.exports = { awaitLanesWithBudget, raceWithBudget };
