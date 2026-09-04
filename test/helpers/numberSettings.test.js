const test = require("node:test");
const assert = require("node:assert/strict");

const { parseStoredNumber } = require("../../src/helpers/numberSettings");

test("numeric settings preserve decimal choices across restarts", () => {
  assert.equal(parseStoredNumber("7.5", 5), 7.5);
});

test("numeric settings reject blanks, partial numbers, and non-finite values", () => {
  for (const value of [null, "", "  ", "7.5ms", "NaN", "Infinity", "-Infinity"]) {
    assert.equal(parseStoredNumber(value, 5), 5);
  }
});

test("zero and negative finite values remain available to setting-specific validators", () => {
  assert.equal(parseStoredNumber("0", 5), 0);
  assert.equal(parseStoredNumber("-1", 5), -1);
});
