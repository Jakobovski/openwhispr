import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { RotateCcw, Trash2 } from "lucide-react";
import { getProviderDisplayName } from "../models/ModelRegistry";
import type { ModelLatencyStat } from "../types/electron";

// Transcription and reconciliation are different jobs with different budgets, so they
// are tabulated separately rather than sorted into one list where a 600ms merge sits
// next to a 600ms transcription as if they were comparable.
const KINDS = ["transcription", "reconcile"] as const;

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
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
        // Fastest first: the question this page answers is which model to pick.
        .sort((a, b) => a.median_ms - b.median_ms);
    }
    return out;
  }, [stats]);

  const handleClear = async () => {
    await window.electronAPI?.clearModelLatency?.();
    load();
  };

  const totalSamples = stats.reduce((sum, row) => sum + row.n, 0);

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
                    <th className="text-right font-medium px-3 py-2">{t("modelStats.max")}</th>
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
                        {formatMs(row.max_ms)}
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
