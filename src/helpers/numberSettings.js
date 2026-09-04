/** Parse a numeric localStorage value without truncating decimals or accepting junk. */
function parseStoredNumber(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = { parseStoredNumber };
