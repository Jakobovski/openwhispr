import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Tooltip } from "./tooltip";
import {
  Copy,
  Trash2,
  FileText,
  FolderOpen,
  RotateCcw,
  Loader2,
  AlertCircle,
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type {
  TranscriptionItem as TranscriptionItemType,
  TranscriptionErrorCode,
} from "../../types/electron";
import { cn } from "../lib/utils";
import { getCachedPlatform } from "../../utils/platform";
import { formatMmSs } from "../../utils/formatDuration";
import { getProviderDisplayName } from "../../models/ModelRegistry";
import { diffTranscripts, type DiffToken } from "../../utils/transcriptDiff";

const platform = getCachedPlatform();

interface DualSide {
  provider?: string | null;
  model?: string | null;
  text?: string | null;
  status?: string | null;
  ms?: number | null;
}

interface DualDetail {
  sides: DualSide[];
  reconciled: boolean;
  reconcileMs?: number | null;
  mergedText?: string | null;
}

/**
 * The per-side detail stored for a dual-provider dictation, or null for every other
 * row. Parsed defensively: it is opaque JSON written by whichever version of the app
 * recorded the row, so a shape change must not take the history list down with it.
 */
function parseDual(raw?: string | null): DualDetail | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    const sides: DualSide[] = [
      { provider: d.providerA, model: d.modelA, text: d.textA, status: d.statusA, ms: d.msA },
      { provider: d.providerB, model: d.modelB, text: d.textB, status: d.statusB, ms: d.msB },
    ].filter((side) => side.provider);
    if (sides.length === 0) return null;
    return {
      sides,
      reconciled: !!d.reconciled,
      reconcileMs: d.reconcileMs ?? null,
      mergedText: d.mergedText ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * A different word gets weight and a wash of colour. A punctuation-or-case difference
 * gets a dotted underline instead — visible, but not competing with the real edits.
 */
function DiffText({ tokens }: { tokens: DiffToken[] }) {
  return (
    <>
      {tokens.map((token, index) => {
        if (token.changed) {
          return (
            <mark
              key={index}
              className="bg-primary/15 text-foreground font-semibold rounded-[2px] px-[1px]"
            >
              {token.text}
            </mark>
          );
        }
        if (token.punctuationOnly) {
          return (
            <span
              key={index}
              className="underline decoration-dotted decoration-muted-foreground/40"
            >
              {token.text}
            </span>
          );
        }
        return <span key={index}>{token.text}</span>;
      })}
    </>
  );
}

function formatMs(ms?: number | null): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function getShowInFolderKey(): string {
  if (platform === "win32") return "controlPanel.history.showInFolderWindows";
  if (platform === "linux") return "controlPanel.history.showInFolderLinux";
  return "controlPanel.history.showInFolder";
}

interface TranscriptionItemProps {
  item: TranscriptionItemType;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onShowAudioInFolder?: (id: number) => void;
  onRetryTranscription?: (id: number, options?: { isRecover?: boolean }) => Promise<void>;
  onOpenSettings?: () => void;
}

export default function TranscriptionItem({
  item,
  onCopy,
  onDelete,
  onShowAudioInFolder,
  onRetryTranscription,
  onOpenSettings,
}: TranscriptionItemProps) {
  const { t, i18n } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);

  const isFailed = item.status === "failed";
  const isDiscarded = item.status === "discarded";
  const rawText = item.raw_text;
  const dual = parseDual(item.dual_json);
  const hasRawText = rawText !== null;
  const hasAudio = item.has_audio === 1;
  // The dual breakdown lives in the same expandable panel, so a dual row with no raw
  // text still needs the toggle.
  const hasExpandable = hasRawText || !!dual;
  const canExpand = hasExpandable && !isFailed && !isDiscarded;

  const timestampSource = item.timestamp.endsWith("Z") ? item.timestamp : `${item.timestamp}Z`;
  const timestampDate = new Date(timestampSource);
  const formattedTime = Number.isNaN(timestampDate.getTime())
    ? ""
    : timestampDate.toLocaleTimeString(i18n.language, {
        hour: "2-digit",
        minute: "2-digit",
      });

  const handleRetry = async () => {
    if (isRetrying || !onRetryTranscription) return;
    setIsRetrying(true);
    try {
      await onRetryTranscription(item.id, { isRecover: item.status === "discarded" });
    } finally {
      setIsRetrying(false);
    }
  };

  // Clicking the row expands it. Two things must not trigger it: a click that was
  // really a text selection (dragging across the transcript to copy it), and a click on
  // one of the action buttons, which stop propagation themselves.
  const handleRowClick = () => {
    if (!canExpand) return;
    if ((window.getSelection()?.toString() ?? "").length > 0) return;
    setIsExpanded((open) => !open);
  };

  const discardedDuration =
    item.audio_duration_ms && item.audio_duration_ms > 0
      ? formatMmSs(Math.round(item.audio_duration_ms / 1000))
      : null;

  // Only meaningful with two transcripts to compare: a dropped or failed side has
  // nothing to disagree with, and a merged result is a third text rather than a
  // second opinion.
  const sideDiff = useMemo(() => {
    const [a, b] = dual?.sides ?? [];
    if (!a?.text || !b?.text) return null;
    return diffTranscripts(a.text, b.text);
  }, [dual]);
  const showUtilityGroup = hasExpandable || hasAudio;

  const errorCode = item.error_code as TranscriptionErrorCode;
  const isConfigError =
    errorCode === "API_KEY_MISSING" ||
    errorCode === "INVALID_KEY" ||
    errorCode === "MODEL_NOT_AVAILABLE";
  const isLimitError = errorCode === "LIMIT_REACHED";
  const isOfflineError = errorCode === "OFFLINE";

  return (
    <div
      className={cn(
        "group rounded-md border border-l-2 px-3 py-2.5 transition-colors duration-150",
        isFailed
          ? "border-destructive/30 bg-destructive/5 hover:bg-destructive/10"
          : isDiscarded
            ? "border-border/30 bg-muted/20 hover:bg-muted/30 opacity-80"
            : "border-border/40 dark:border-border-subtle/60 bg-card/50 dark:bg-surface-2/60 hover:bg-muted/30 dark:hover:bg-surface-2/80",
        canExpand && "cursor-pointer",
        // Subtle left accent for translation records; transparent keeps others pixel-aligned.
        item.route_kind === "translation"
          ? "border-l-primary/70 dark:border-l-primary/70"
          : "border-l-transparent dark:border-l-transparent"
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleRowClick}
    >
      <div className="flex items-start gap-3">
        {formattedTime && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums pt-0.5">
            {formattedTime}
          </span>
        )}

        {isFailed ? (
          <div className="flex-1 min-w-0 flex items-start gap-2">
            <AlertCircle size={14} className="shrink-0 text-destructive mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm text-destructive font-medium">
                {t("controlPanel.history.transcriptionFailed")}
              </p>
              {item.error_message && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {item.error_message}
                </p>
              )}
              {isConfigError && (
                <p className="text-xs text-muted-foreground mt-1">
                  {hasAudio ? (
                    <>
                      <button
                        onClick={() => onOpenSettings?.()}
                        className="text-primary hover:underline cursor-pointer"
                      >
                        {t("controlPanel.history.failedCtaSettings")}
                      </button>{" "}
                      {t("controlPanel.history.failedCtaAndRetry")}
                    </>
                  ) : (
                    <button
                      onClick={() => onOpenSettings?.()}
                      className="text-primary hover:underline cursor-pointer"
                    >
                      {t("controlPanel.history.failedCtaSettingsOnly")}
                    </button>
                  )}
                </p>
              )}
              {isLimitError && (
                <p className="text-xs text-muted-foreground mt-1">
                  {t("controlPanel.history.failedLimitReached")}
                </p>
              )}
              {isOfflineError && (
                <p className="text-xs text-muted-foreground mt-1">
                  {t("controlPanel.history.failedOffline")}
                </p>
              )}
            </div>
          </div>
        ) : isDiscarded ? (
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("controlPanel.history.discarded.badge")}
            </span>
            <span className="text-sm text-muted-foreground truncate">
              {discardedDuration
                ? t("controlPanel.history.discarded.recordingWithDuration", {
                    duration: discardedDuration,
                  })
                : t("controlPanel.history.discarded.recording")}
            </span>
          </div>
        ) : (
          <div className="flex-1 min-w-0">
            <p className="text-foreground text-sm leading-normal wrap-break-word whitespace-pre-wrap">
              {item.text}
            </p>

            {/* Always visible, because the full breakdown sits behind an icon that only
                appears on hover — a dual dictation should say so without being probed.
                Clicking the line is the same toggle as that icon. */}
            {dual && (
              <button
                type="button"
                onClick={(event) => {
                  // Without this the row handler fires too and the two toggles cancel.
                  event.stopPropagation();
                  setIsExpanded(!isExpanded);
                }}
                className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors"
              >
                {dual.sides.map((side, index) => {
                  const time = formatMs(side.ms);
                  const state =
                    side.status && side.status !== "ok"
                      ? t(`app.stats.${side.status === "failed" ? "failed" : "dropped"}`)
                      : null;
                  return (
                    <span key={`${index}-${side.provider}`} className="whitespace-nowrap">
                      {index > 0 && <span className="mr-1.5 text-muted-foreground/30">·</span>}
                      {getProviderDisplayName(side.provider || "")}
                      <span className={cn("ml-1 tabular-nums", state && "italic")}>
                        {state ?? time}
                      </span>
                    </span>
                  );
                })}
                <span className="text-muted-foreground/30">·</span>
                <span className="whitespace-nowrap">
                  {dual.reconciled
                    ? `${t("controlPanel.history.dualMergedShort")} ${formatMs(dual.reconcileMs)}`
                    : t("controlPanel.history.dualNoMergeShort")}
                </span>
                {isExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
              </button>
            )}
          </div>
        )}

        <div
          onClick={(event) => event.stopPropagation()}
          className={cn(
            "flex items-center gap-0.5 shrink-0 transition-opacity duration-150",
            isFailed || isDiscarded ? "opacity-100" : isHovered ? "opacity-100" : "opacity-0"
          )}
        >
          {isDiscarded && hasAudio && (
            <Tooltip content={t("controlPanel.history.discarded.recover")}>
              <Button
                size="icon"
                variant="ghost"
                onClick={handleRetry}
                disabled={isRetrying}
                className="h-6 w-6 rounded-sm text-muted-foreground hover:text-primary hover:bg-primary/10"
              >
                {isRetrying ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <ArchiveRestore size={12} />
                )}
              </Button>
            </Tooltip>
          )}
          {isFailed && hasAudio && (
            <Tooltip
              content={t(
                item.route_kind === "translation"
                  ? "controlPanel.history.retryTranslationMode"
                  : "controlPanel.history.retryTranscription"
              )}
            >
              <Button
                size="icon"
                variant="ghost"
                onClick={handleRetry}
                disabled={isRetrying}
                className="h-6 w-6 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                {isRetrying ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RotateCcw size={12} />
                )}
              </Button>
            </Tooltip>
          )}
          {!isFailed && !isDiscarded && hasExpandable && (
            <Tooltip content={t("controlPanel.history.viewRawTranscript")}>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setIsExpanded(!isExpanded)}
                className={cn(
                  "h-6 w-6 rounded-sm text-muted-foreground hover:text-primary hover:bg-primary/10",
                  isExpanded && "text-primary"
                )}
              >
                <FileText size={12} />
              </Button>
            </Tooltip>
          )}
          {hasAudio && (
            <Tooltip content={t(getShowInFolderKey())}>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onShowAudioInFolder?.(item.id)}
                className="h-6 w-6 rounded-sm text-muted-foreground hover:text-primary hover:bg-primary/10"
              >
                <FolderOpen size={12} />
              </Button>
            </Tooltip>
          )}
          {!isFailed && !isDiscarded && hasAudio && (
            <Tooltip
              content={t(
                item.route_kind === "translation"
                  ? "controlPanel.history.retryTranslationMode"
                  : "controlPanel.history.retryTranscription"
              )}
            >
              <Button
                size="icon"
                variant="ghost"
                onClick={handleRetry}
                disabled={isRetrying}
                className="h-6 w-6 rounded-sm text-muted-foreground hover:text-primary hover:bg-primary/10"
              >
                {isRetrying ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RotateCcw size={12} />
                )}
              </Button>
            </Tooltip>
          )}
          {showUtilityGroup && <div className="w-px h-3 bg-border/30" />}
          {!isFailed && !isDiscarded && (
            <Tooltip content={t("controlPanel.history.copyText")}>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onCopy(item.text)}
                className="h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/10"
              >
                <Copy size={12} />
              </Button>
            </Tooltip>
          )}
          <Tooltip content={t("controlPanel.history.deleteItem")}>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onDelete(item.id)}
              className="h-6 w-6 rounded-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            >
              <Trash2 size={12} />
            </Button>
          </Tooltip>
        </div>
      </div>

      {!isFailed && !isDiscarded && hasExpandable && (
        <div
          onClick={(event) => event.stopPropagation()}
          inert={!isExpanded}
          className={cn(
            "grid transition-[grid-template-rows] duration-200",
            isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          )}
        >
          <div className="min-h-0 overflow-hidden">
            {dual && (
              <div className="border-t border-border/20 mt-2 pt-2 space-y-2">
                {dual.sides.map((side, index) => {
                  const time = formatMs(side.ms);
                  const state =
                    side.status && side.status !== "ok"
                      ? t(`app.stats.${side.status === "failed" ? "failed" : "dropped"}`)
                      : null;
                  return (
                    <div key={`${index}-${side.provider}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                          {getProviderDisplayName(side.provider || "")}
                          {side.model ? (
                            <span className="ml-1 normal-case text-muted-foreground/50">
                              {side.model}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex items-center gap-1.5 shrink-0">
                          {(state || time) && (
                            <span
                              className={cn(
                                "text-[10px] tabular-nums",
                                state
                                  ? "text-muted-foreground/50 italic"
                                  : "text-muted-foreground/60"
                              )}
                            >
                              {state ?? time}
                            </span>
                          )}
                          {side.text ? (
                            <Tooltip content={t("controlPanel.history.copyRawTranscript")}>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => onCopy(side.text as string)}
                                className="h-5 w-5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/10"
                              >
                                <Copy size={10} />
                              </Button>
                            </Tooltip>
                          ) : null}
                        </span>
                      </div>
                      {/* A side that failed or was dropped has no text of its own; saying so
                          beats an empty block that reads like a transcription of silence. */}
                      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-1 whitespace-pre-wrap">
                        {side.text ? (
                          // Highlighted against the other side, so the words the two
                          // providers disagreed on are the ones that stand out.
                          sideDiff ? (
                            <DiffText tokens={index === 0 ? sideDiff.a : sideDiff.b} />
                          ) : (
                            side.text
                          )
                        ) : (
                          <span className="italic text-muted-foreground/50">
                            {t("controlPanel.history.dualNoText")}
                          </span>
                        )}
                      </p>
                    </div>
                  );
                })}
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-medium text-primary/70 uppercase tracking-wider">
                      {dual.reconciled
                        ? t("controlPanel.history.dualMerged")
                        : t("controlPanel.history.dualNotMerged")}
                    </span>
                    <span className="flex items-center gap-2 shrink-0">
                      {sideDiff && sideDiff.changeRatio > 0 && (
                        <span className="text-[10px] tabular-nums text-muted-foreground/50">
                          {t("controlPanel.history.dualDisagreement", {
                            percent: Math.max(1, Math.round(sideDiff.changeRatio * 100)),
                          })}
                        </span>
                      )}
                      {sideDiff?.punctuationOnly && (
                        <span className="text-[10px] text-muted-foreground/50">
                          {t("controlPanel.history.dualPunctuationOnly")}
                        </span>
                      )}
                      {formatMs(dual.reconcileMs) && (
                        <span className="text-[10px] tabular-nums text-muted-foreground/60">
                          {formatMs(dual.reconcileMs)}
                        </span>
                      )}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground/80 leading-relaxed mt-1">
                    {dual.mergedText ?? rawText}
                  </p>
                </div>
              </div>
            )}
            {rawText !== null && (
              <div className="border-t border-border/20 mt-2 pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {t("controlPanel.history.rawTranscript")}
                  </span>
                  <Tooltip content={t("controlPanel.history.copyRawTranscript")}>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => onCopy(rawText)}
                      className="h-5 w-5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/10"
                    >
                      <Copy size={10} />
                    </Button>
                  </Tooltip>
                </div>
                <p className="text-xs text-muted-foreground/80 leading-relaxed mt-1">{rawText}</p>
                {rawText === item.text && (
                  <p className="text-[10px] text-muted-foreground/50 italic mt-1">
                    {t("controlPanel.history.noAiProcessing")}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
