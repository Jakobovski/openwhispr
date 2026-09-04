// Pure resolver for the "retention-settings-changed" IPC sync. Both renderer
// windows re-sync on mount, so the handler needs to know whether the incoming
// values actually differ before kicking off another cleanup sweep.
const DEFAULT_RETENTION_SETTINGS = {
  audioRetentionDays: 30,
  transcriptRetentionDays: 0, // 0 = keep transcripts forever
};

// IPC payloads and localStorage are both untrusted inputs. In particular,
// Number(null) and Number("") are 0, which would silently disable retention
// when a missing value reaches the main process. Keep the allowed shape in one
// place so renderer state cannot disagree with the cleanup process.
function normalizeRetentionDays(value, fallback) {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  return Number.isFinite(numeric) && Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function applyRetentionSettings(current, incoming) {
  const settings = {
    audioRetentionDays: normalizeRetentionDays(
      incoming?.audioRetentionDays,
      current.audioRetentionDays
    ),
    transcriptRetentionDays: normalizeRetentionDays(
      incoming?.transcriptRetentionDays,
      current.transcriptRetentionDays
    ),
  };
  const changed =
    settings.audioRetentionDays !== current.audioRetentionDays ||
    settings.transcriptRetentionDays !== current.transcriptRetentionDays;
  return { changed, settings };
}

module.exports = { DEFAULT_RETENTION_SETTINGS, normalizeRetentionDays, applyRetentionSettings };
