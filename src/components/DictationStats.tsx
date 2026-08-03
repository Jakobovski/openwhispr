import { useTranslation } from "react-i18next";
import { getProviderDisplayName } from "../models/ModelRegistry";

export interface DictationStatsData {
  recordedSeconds?: number | null;
  trimmedPercent?: number | null;
  latencyMs?: number | null;
  transcriptionProcessingDurationMs?: number | null;
  reconcileDurationMs?: number | null;
  /** Provider that transcribed, for the single-provider case. Dual reports its own. */
  provider?: string | null;
  dual?: {
    providerA?: string;
    providerB?: string;
    msA?: number | null;
    msB?: number | null;
    /** "ok" | "failed" | "dropped" — why a side has no timing. */
    statusA?: string | null;
    statusB?: string | null;
    reconcileMs?: number | null;
    reconciled?: boolean;
    droppedProvider?: string | null;
  } | null;
}

// Provider ids are brand names, so they are shown verbatim rather than translated.
// The names come from the registry, which is the same place the pickers read them
// from — a local table here went stale the moment a provider was added, and only
// ever knew groq, xai and openai.
function providerLabel(id?: string | null, fallback = ""): string {
  if (!id) return fallback;
  return getProviderDisplayName(id) || fallback || id;
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
    // Every provider that took part gets a row, whatever became of it. A side that
    // was dropped for being slow, or failed outright, has no timing to show — and
    // omitting it made a pair look like a single provider, which is the opposite of
    // what this readout is for. Its state goes in the value column instead.
    const sides = [
      { provider: dual.providerA, ms: dual.msA, status: dual.statusA, fallbackLabel: "A" },
      { provider: dual.providerB, ms: dual.msB, status: dual.statusB, fallbackLabel: "B" },
    ];

    for (const side of sides) {
      const time = formatMs(side.ms);
      if (time) {
        rows.push({ label: providerLabel(side.provider, side.fallbackLabel), value: time });
        continue;
      }
      // Older payloads carry no per-side status, so fall back to the dropped
      // provider's name to tell "slow" apart from "errored".
      const failed =
        side.status === "failed" ||
        (!side.status && !!side.provider && dual.droppedProvider !== side.provider);
      rows.push({
        label: providerLabel(side.provider, side.fallbackLabel),
        value: failed ? t("app.stats.failed") : t("app.stats.dropped"),
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
    // Named with the provider that did the work, so the readout says the same kind
    // of thing in single mode as in dual. Falls back to the generic label when the
    // provider is unknown — a self-hosted endpoint, say.
    if (transcription) {
      rows.push({
        label: providerLabel(stats.provider, t("app.stats.transcription")),
        value: transcription,
      });
    }
  }

  const total = formatMs(stats.latencyMs);
  if (total) rows.push({ label: t("app.stats.total"), value: total });

  if (rows.length === 0) return null;

  return (
    <div
      className="flex shrink-0 flex-col gap-1 rounded-xl bg-black/75 px-3 py-2.5 text-xs whitespace-nowrap text-white/90 tabular-nums shadow-lg backdrop-blur-sm animate-in fade-in duration-150"
      role="status"
    >
      {/* Keyed by position, not label: two sides can legitimately carry the same
          label, and a duplicate key drops a row from the readout. */}
      {rows.map((row, index) => (
        <div key={`${index}-${row.label}`} className="flex items-baseline justify-between gap-4">
          <span className={row.muted ? "text-white/35" : "text-white/55"}>{row.label}</span>
          <span className={row.muted ? "text-white/45 italic" : "font-semibold"}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}
