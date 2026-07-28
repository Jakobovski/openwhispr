// Cleanup can fail two very different ways.
//
// A transient failure — network, rate limit, a bad response — is worth telling
// the user about: their cleanup normally works and just didn't this time.
//
// An unconfigured or unauthenticated cloud is a standing condition. It fails
// identically on every recording, the user cannot fix it from the dictation
// panel, and toasting each time turns a permanent state into per-recording
// noise. Those are logged, not surfaced.
const UNAVAILABLE_CLEANUP_ERROR = /not configured|not authenticated|not signed in|no api key/i;

/**
 * Should a cleanup failure be hidden from the user?
 *
 * @param {{message?: string}|null|undefined} error - The failure from the reasoning call
 * @returns {boolean} true when the cause is a standing config gap, not a blip
 */
function isCleanupPermanentlyUnavailable(error) {
  return UNAVAILABLE_CLEANUP_ERROR.test(error?.message || "");
}

module.exports = { isCleanupPermanentlyUnavailable };
