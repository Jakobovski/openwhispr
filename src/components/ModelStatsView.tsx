import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { RotateCcw, Trash2 } from "lucide-react";
import { getProviderDisplayName } from "../models/ModelRegistry";
import { cn } from "./lib/utils";
import type { ModelLatencyStat } from "../types/electron";

// Transcription and reconciliation are different jobs with different budgets, so they
// are tabulated separately rather than sorted into one list where a 600ms merge sits
// next to a 600ms transcription as if they were comparable.
const KINDS = ["transcription", "reconcile"] as const;

function formatMs(ms: number | null): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Rates rather than counts: n is already on the row, so a count would be the same
// information twice, and a rate is what says whether a provider is worth keeping.
// Rounded to whole percent below 10% so a single failure in 40 calls reads as 3%
// rather than 2.5%, which invites more precision than one sample supports.
function formatRate(count: number, total: number): string {
  if (total === 0) return "—";
  if (count === 0) return "0%";
  return `${Math.round((count / total) * 100)}%`;
}

// Word error rate against the merged transcript, as a percentage. Only multi-provider
// dictations that were actually merged carry one, so a lane can have plenty of timings
// and no rate — an em dash rather than 0%, which would read as flawless.
//
// One decimal below 10%: the difference between 2.4% and 3.1% is the kind of gap that
// decides which provider to keep, and whole percent hides it.
function formatWer(rate: number | null): string {
  if (rate == null) return "—";
  const percent = rate * 100;
  if (percent === 0) return "0%";
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

/** Everything that was attempted: successes plus both kinds of non-answer. */
function attempts(row: ModelLatencyStat): number {
  return row.n + row.failed + row.dropped;
}

export default function ModelStatsView() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<ModelLatencyStat[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const result = await window.electronAPI?.getModelLatencyStats?.();
    setStats(result?.stats ?? []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const grouped = useMemo(() => {
    const out: Record<string, ModelLatencyStat[]> = {};
    for (const kind of KINDS) {
      out[kind] = stats
        .filter((row) => row.kind === kind)
        // Fastest first: the question this page answers is which model to pick. A model
        // with no successful sample has no median, so it sorts to the bottom instead of
        // comparing null against a number.
        .sort((a, b) => (a.median_ms ?? Infinity) - (b.median_ms ?? Infinity));
    }
    return out;
  }, [stats]);

  const handleClear = async () => {
    await window.electronAPI?.clearModelLatency?.();
    load();
  };

  const totalSamples = stats.reduce((sum, row) => sum + attempts(row), 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t("modelStats.title")}</h2>
          <p className="text-xs text-muted-foreground mt-1 max-w-prose">
            {t("modelStats.description")}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button size="sm" variant="ghost" onClick={load} className="h-7 px-2 text-xs">
            <RotateCcw size={12} className="mr-1" />
            {t("modelStats.refresh")}
          </Button>
          {totalSamples > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleClear}
              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
            >
              <Trash2 size={12} className="mr-1" />
              {t("modelStats.clear")}
            </Button>
          )}
        </div>
      </div>

      {loaded && totalSamples === 0 && (
        <p className="text-sm text-muted-foreground">{t("modelStats.empty")}</p>
      )}

      {KINDS.map((kind) =>
        grouped[kind].length === 0 ? null : (
          <div key={kind} className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t(`modelStats.kinds.${kind}`)}
            </h3>
            <div className="overflow-x-auto rounded-md border border-border/40">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground/70 border-b border-border/30">
                    <th className="text-left font-medium px-3 py-2">{t("modelStats.model")}</th>
                    <th className="text-right font-medium px-3 py-2 tabular-nums">
                      {t("modelStats.samples")}
                    </th>
                    <th className="text-right font-medium px-3 py-2">{t("modelStats.min")}</th>
                    <th className="text-right font-medium px-3 py-2">{t("modelStats.median")}</th>
                    <th className="text-right font-medium px-3 py-2">{t("modelStats.mean")}</th>
                    <th className="text-right font-medium px-3 py-2">{t("modelStats.p95")}</th>
                    <th className="text-right font-medium px-3 py-2">{t("modelStats.max")}</th>
                    <th className="text-right font-medium px-3 py-2">{t("modelStats.wer")}</th>
                    <th className="text-right font-medium px-3 py-2">{t("modelStats.failRate")}</th>
                    <th className="text-right font-medium px-3 py-2">{t("modelStats.dropRate")}</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped[kind].map((row) => (
                    <tr
                      key={`${row.provider}-${row.model}`}
                      className="border-b border-border/15 last:border-0"
                    >
                      <td className="px-3 py-2">
                        <span className="text-foreground font-medium">
                          {getProviderDisplayName(row.provider || "")}
                        </span>
                        {row.model && (
                          <span className="text-muted-foreground/60 ml-1.5">{row.model}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {row.n}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {formatMs(row.min_ms)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-foreground">
                        {formatMs(row.median_ms)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {formatMs(row.mean_ms)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {formatMs(row.p95_ms)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {formatMs(row.max_ms)}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right tabular-nums",
                          row.median_wer == null ? "text-muted-foreground/40" : "text-foreground"
                        )}
                        title={
                          row.wer_n
                            ? t("modelStats.werTooltip", { count: row.wer_n })
                            : t("modelStats.werNone")
                        }
                      >
                        {formatWer(row.median_wer)}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right tabular-nums",
                          row.failed > 0 ? "text-warning" : "text-muted-foreground/40"
                        )}
                        title={`${row.failed}/${attempts(row)}`}
                      >
                        {formatRate(row.failed, attempts(row))}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right tabular-nums",
                          row.dropped > 0 ? "text-muted-foreground" : "text-muted-foreground/40"
                        )}
                        title={`${row.dropped}/${attempts(row)}`}
                      >
                        {formatRate(row.dropped, attempts(row))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}
    </div>
  );
}
