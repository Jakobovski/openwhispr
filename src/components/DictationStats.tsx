import { useTranslation } from "react-i18next";

export interface DictationStatsData {
  recordedSeconds?: number | null;
  trimmedPercent?: number | null;
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
    droppedProvider?: string | null;
  } | null;
}

// Provider ids are brand names, so they are shown verbatim rather than translated.
const PROVIDER_LABELS: Record<string, string> = {
  groq: "Groq",
  xai: "xAI",
  openai: "OpenAI",
};

function providerLabel(id?: string | null, fallback = ""): string {
  if (!id) return fallback;
  return PROVIDER_LABELS[id] || id;
}

// Sub-second values read better as milliseconds, longer ones as seconds, so a
// row stays scannable at a glance rather than needing to be parsed.
function formatMs(ms?: number | null): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatSeconds(seconds?: number | null): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  return `${seconds.toFixed(1)}s`;
}

/**
 * The timing readout shown beside the mic for a few seconds after a dictation.
 *
 * One row per statistic rather than a single line: the dual-provider case has
 * five numbers, which a 96px-wide panel cannot show horizontally without
 * clipping. The window is grown to WITH_STATS while this is on screen.
 *
 * Every row is optional — a provider that reports no timing drops out rather
 * than rendering a blank or a zero.
 */
export default function DictationStats({ stats }: { stats: DictationStatsData | null }) {
  const { t } = useTranslation();
  if (!stats) return null;

  const rows: { label: string; value: string; muted?: boolean }[] = [];

  const recorded = formatSeconds(stats.recordedSeconds);
  if (recorded) rows.push({ label: t("app.stats.recorded"), value: recorded });

  // Always shown, 0% included: an absent row could not be told apart from
  // trimming that did not run, which is exactly the confusion it caused.
  rows.push({
    label: t("app.stats.trimmed"),
    value: `${typeof stats.trimmedPercent === "number" ? stats.trimmedPercent : 0}%`,
  });

  const dual = stats.dual;
  if (dual) {
    const a = formatMs(dual.msA);
    const b = formatMs(dual.msB);
    if (a) rows.push({ label: providerLabel(dual.providerA, "A"), value: a });
    if (b) rows.push({ label: providerLabel(dual.providerB, "B"), value: b });

    // A provider dropped for exceeding the wait budget has no timing of its own,
    // so it is reported explicitly instead of silently vanishing from the list.
    if (dual.droppedProvider) {
      rows.push({
        label: providerLabel(dual.droppedProvider),
        value: t("app.stats.dropped"),
        muted: true,
      });
    }

    // Always present, reading 0 when the merge was skipped — the providers agreed,
    // or one was dropped. An absent row was ambiguous: it could not be told apart
    // from a merge that ran but reported no timing.
    rows.push({
      label: t("app.stats.reconcile"),
      value: formatMs(dual.reconcileMs) ?? "0ms",
    });
  } else {
    const transcription = formatMs(stats.transcriptionProcessingDurationMs);
    if (transcription) rows.push({ label: t("app.stats.transcription"), value: transcription });
  }

  const total = formatMs(stats.latencyMs);
  if (total) rows.push({ label: t("app.stats.total"), value: total });

  if (rows.length === 0) return null;

  return (
    <div
      className="flex shrink-0 flex-col gap-1 rounded-xl bg-black/75 px-3 py-2.5 text-xs whitespace-nowrap text-white/90 tabular-nums shadow-lg backdrop-blur-sm animate-in fade-in duration-150"
      role="status"
    >
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-4">
          <span className={row.muted ? "text-white/35" : "text-white/55"}>{row.label}</span>
          <span className={row.muted ? "text-white/45 italic" : "font-semibold"}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}
