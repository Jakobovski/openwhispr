// Which stored recordings to delete when the audio folder outgrows its budget.
//
// Kept pure so the selection can be tested without a filesystem: the cost of getting this
// wrong is deleting a recording the user still wanted, which is not recoverable.

/** Extensions the app has written for stored dictations. */
const AUDIO_EXTENSIONS = [".wav", ".webm", ".ogg", ".mp3", ".m4a", ".flac"];

function isAudioFile(name) {
  const lower = String(name || "").toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Oldest-first selection of files to remove so the total falls to or below maxBytes.
 *
 * Oldest first because a recording's value decays: the reason to keep audio is retrying a
 * recent dictation that transcribed badly. Returns nothing when already under budget, so
 * the caller can skip the work entirely.
 *
 * @param {Array<{name: string, size: number, mtimeMs: number}>} files
 * @param {number} maxBytes
 * @returns {{ remove: string[], totalBytes: number, freedBytes: number }}
 */
function selectOverflowFiles(files, maxBytes) {
  const audio = (files || []).filter((file) => file && isAudioFile(file.name));
  const totalBytes = audio.reduce((sum, file) => sum + (file.size || 0), 0);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || totalBytes <= maxBytes) {
    return { remove: [], totalBytes, freedBytes: 0 };
  }

  const oldestFirst = [...audio].sort((a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0));
  const remove = [];
  let freedBytes = 0;
  for (const file of oldestFirst) {
    if (totalBytes - freedBytes <= maxBytes) break;
    remove.push(file.name);
    freedBytes += file.size || 0;
  }
  return { remove, totalBytes, freedBytes };
}

/**
 * The transcription id encoded in a stored filename.
 *
 * Names look like "OpenWhispr-2026-08-17-15-44-04-289.wav", with legacy "289.webm" from
 * before timestamps were included. The id is the trailing number either way.
 */
function transcriptionIdFromFilename(name) {
  const base = String(name || "").replace(/\.[a-z0-9]+$/i, "");
  const lastDash = base.lastIndexOf("-");
  return lastDash !== -1 ? base.slice(lastDash + 1) : base;
}

module.exports = {
  AUDIO_EXTENSIONS,
  isAudioFile,
  selectOverflowFiles,
  transcriptionIdFromFilename,
};
