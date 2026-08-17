// A recording with no audio in it — produced when the dictation hotkey toggles on and
// off within milliseconds (an accidental double-tap, or the KDE double-trigger fixed in
// main.js) — is essentially just a header. That was a WebM/Opus container header when
// dictation went through MediaRecorder; it is now a 44-byte WAV header, since dictation
// captures 16 kHz mono PCM directly. The threshold covers both: 256 bytes is under a
// third of a kilobyte of Opus, and 106 PCM samples, which is 6.6 ms of audio.
//
// We gate on size, not wall-clock duration: a genuinely short utterance can last under
// any reasonable time threshold yet still carry real audio, so a duration gate would
// silently drop it. See issue #864.
export const MIN_AUDIO_BYTES = 256;

export function isEmptyRecording(blobSize) {
  const size = typeof blobSize === "number" && Number.isFinite(blobSize) ? blobSize : 0;
  return size < MIN_AUDIO_BYTES;
}
