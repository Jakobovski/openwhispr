const test = require("node:test");
const assert = require("node:assert/strict");

const {
  awaitLanesWithBudget,
  raceWithBudget,
} = require("../../src/helpers/multiTranscriptionRace");

// Builds the pair of structures transcribeMulti passes in: one promise per lane that
// resolves to its own index once it settles, and the `settled` array the caller fills
// in as results arrive.
//
// `plan` is one entry per lane: {ms, ok}. Timings are relative to the start, in real
// milliseconds — these are deliberately small but not zero, because the thing being
// tested is ordering under a real timer.
function lanes(plan) {
  const settled = plan.map(() => null);
  const tracked = plan.map((lane, index) =>
    new Promise((resolve) => setTimeout(resolve, lane.ms)).then(() => {
      settled[index] = lane.ok
        ? { status: "fulfilled", value: `text-${index}` }
        : { status: "rejected", reason: new Error(`lane ${index} failed`) };
      return index;
    })
  );
  return { tracked, settled };
}

test("the budget starts at the first success, skipping a lane that failed first", async () => {
  // The case this was written for: lane 0 fails immediately, so the budget must not
  // start there. Lane 1 succeeds at 60ms and lane 2 needs 400ms — with a 150ms budget
  // measured from lane 1, lane 2 is dropped.
  const { tracked, settled } = lanes([
    { ms: 5, ok: false },
    { ms: 60, ok: true },
    { ms: 400, ok: true },
  ]);

  const result = await awaitLanesWithBudget(tracked, settled, 150);

  assert.equal(result.firstSuccessIndex, 1, "the failure did not start the clock");
  assert.deepEqual(result.droppedIndexes, [2]);
});

test("a fast failure no longer removes the deadline entirely", async () => {
  // The bug. When the first lane to settle had failed, the old code fell through to
  // Promise.all and waited for every remaining lane with no budget at all — so one
  // instant 401 meant an unbounded wait on whatever else was hanging.
  const { tracked, settled } = lanes([
    { ms: 5, ok: false },
    { ms: 30, ok: true },
    { ms: 5000, ok: true },
  ]);

  const startedAt = Date.now();
  const result = await awaitLanesWithBudget(tracked, settled, 100);
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(result.droppedIndexes, [2]);
  assert.ok(elapsed < 1000, `returned in ${elapsed}ms rather than waiting on the slow lane`);
});

test("two slow lanes share one budget rather than getting one each", async () => {
  // The bound has to be independent of lane count: 200ms total, not 200ms per lane.
  const { tracked, settled } = lanes([
    { ms: 20, ok: true },
    { ms: 3000, ok: true },
    { ms: 3000, ok: true },
  ]);

  const startedAt = Date.now();
  const result = await awaitLanesWithBudget(tracked, settled, 200);
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(result.droppedIndexes, [1, 2], "both slow lanes dropped together");
  assert.ok(elapsed < 1200, `one shared budget, took ${elapsed}ms`);
});

test("a lane that lands inside the budget is kept and only the later one dropped", async () => {
  // Not all-or-nothing: whatever arrived by the deadline counts.
  const { tracked, settled } = lanes([
    { ms: 20, ok: true },
    { ms: 90, ok: true },
    { ms: 3000, ok: true },
  ]);

  const result = await awaitLanesWithBudget(tracked, settled, 200);

  assert.deepEqual(result.droppedIndexes, [2]);
  assert.equal(settled[1].status, "fulfilled", "the lane inside the budget was kept");
});

test("every lane failing waits for all of them and reports no success", async () => {
  const { tracked, settled } = lanes([
    { ms: 5, ok: false },
    { ms: 20, ok: false },
    { ms: 40, ok: false },
  ]);

  const result = await awaitLanesWithBudget(tracked, settled, 100);

  assert.equal(result.firstSuccessIndex, -1);
  assert.deepEqual(result.droppedIndexes, [], "a failure is not a drop");
  assert.ok(
    settled.every((entry) => entry?.status === "rejected"),
    "all lanes were awaited, so all are reported rather than left pending"
  );
});

test("the last lane succeeding after two failures leaves nothing to drop", async () => {
  const { tracked, settled } = lanes([
    { ms: 5, ok: false },
    { ms: 20, ok: false },
    { ms: 40, ok: true },
  ]);

  const result = await awaitLanesWithBudget(tracked, settled, 100);

  assert.equal(result.firstSuccessIndex, 2);
  assert.deepEqual(result.droppedIndexes, []);
});

test("a single lane needs no budget", async () => {
  const { tracked, settled } = lanes([{ ms: 10, ok: true }]);
  const result = await awaitLanesWithBudget(tracked, settled, 50);

  assert.equal(result.firstSuccessIndex, 0);
  assert.deepEqual(result.droppedIndexes, []);
});

// --- the merge deadline ---

const after = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const failsAfter = (ms, message) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));

test("a merge that finishes inside its budget is used", async () => {
  const result = await raceWithBudget(after(20, "merged text"), 200);
  assert.deepEqual(result, { timedOut: false, value: "merged text" });
});

test("a merge that overruns is abandoned rather than waited on", async () => {
  const startedAt = Date.now();
  const result = await raceWithBudget(after(5000, "too late"), 100);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.timedOut, true);
  assert.equal(result.value, undefined, "the late answer is not used");
  assert.ok(elapsed < 1000, `gave up after ${elapsed}ms instead of waiting`);
});

test("an abandoned merge that later fails does not become an unhandled rejection", async () => {
  // The reason the loser's rejection is swallowed: it settles long after the dictation
  // it belonged to, and an unhandled rejection there would take the renderer down.
  const rejections = [];
  const onRejection = (error) => rejections.push(error);
  process.on("unhandledRejection", onRejection);

  try {
    const result = await raceWithBudget(failsAfter(40, "merge blew up"), 10);
    assert.equal(result.timedOut, true);

    // Long enough for the abandoned promise to reject and for the microtask queue to
    // have surfaced it if nothing were catching.
    await after(120);
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("a merge that fails before the deadline still reports the failure", async () => {
  // Distinct from timing out: the caller falls back either way, but must not mistake a
  // failure for a usable result.
  await assert.rejects(() => raceWithBudget(failsAfter(10, "bad request"), 500), /bad request/);
});
