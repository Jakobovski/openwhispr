import { useTranslation } from "react-i18next";

export interface DictationStatsData {
  recordedSeconds?: number | null;
  latencyMs?: number | null;
  transcriptionProcessingDurationMs?: number | null;
  reconcileDurationMs?: number | null;
  dual?: {
    providerA?: string;
    providerB?: string;
    msA?: number | null;
    msB?: number | null;
    reconcileMs?: number | null;
    reconciled?: boolean;
  } | null;
}

// Provider ids are brand names, so they are shown verbatim rather than translated.
const PROVIDER_LABELS: Record<string, string> = {
  groq: "Groq",
  xai: "xAI",
  openai: "OpenAI",
};

// Sub-second values read better as milliseconds; anything longer as seconds, so
// the row stays scannable at a glance rather than needing to be parsed.
function formatMs(ms?: number | null): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatSeconds(seconds?: number | null): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  return `${seconds.toFixed(1)}s`;
}

/**
 * The timing readout that appears beside the mic for a couple of seconds after a
 * dictation. Every field is optional: a provider that reports no timing simply
 * drops out of the row rather than rendering a blank or a zero.
 */
export default function DictationStats({ stats }: { stats: DictationStatsData | null }) {
  const { t } = useTranslation();
  if (!stats) return null;

  const parts: { label: string; value: string }[] = [];

  const recorded = formatSeconds(stats.recordedSeconds);
  if (recorded) parts.push({ label: t("app.stats.recorded"), value: recorded });

  const dual = stats.dual;
  if (dual) {
    const a = formatMs(dual.msA);
    const b = formatMs(dual.msB);
    if (a)
      parts.push({
        label: PROVIDER_LABELS[dual.providerA || ""] || dual.providerA || "A",
        value: a,
      });
    if (b)
      parts.push({
        label: PROVIDER_LABELS[dual.providerB || ""] || dual.providerB || "B",
        value: b,
      });
    const reconcile = formatMs(dual.reconcileMs);
    // Absent when the two transcripts agreed and the merge was skipped.
    if (reconcile) parts.push({ label: t("app.stats.reconcile"), value: reconcile });
  } else {
    const transcription = formatMs(stats.transcriptionProcessingDurationMs);
    if (transcription) parts.push({ label: t("app.stats.transcription"), value: transcription });
  }

  const total = formatMs(stats.latencyMs);
  if (total) parts.push({ label: t("app.stats.total"), value: total });

  if (parts.length === 0) return null;

  return (
    <div
      className="flex items-center gap-2 rounded-full bg-black/60 px-2.5 py-1 text-[10px] whitespace-nowrap text-white/85 tabular-nums backdrop-blur-sm animate-in fade-in duration-150"
      role="status"
    >
      {parts.map((part, index) => (
        <span key={part.label} className="flex items-center gap-1">
          {index > 0 && <span className="text-white/25">·</span>}
          <span className="text-white/50">{part.label}</span>
          <span className="font-medium">{part.value}</span>
        </span>
      ))}
    </div>
  );
}
