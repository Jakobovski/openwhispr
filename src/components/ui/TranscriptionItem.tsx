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
  ScanText,
  Check,
} from "lucide-react";
import type {
  TranscriptionItem as TranscriptionItemType,
  TranscriptionErrorCode,
  ScreenContextTerms,
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
  /**
   * Whether this lane transcribed while the user talked or after they stopped.
   *
   * Not inferable from the model id: Meta serves one model on both paths, so its rows
   * were indistinguishable here. Absent on rows recorded before this was stored.
   */
  streaming?: boolean | null;
}

interface DualDetail {
  sides: DualSide[];
  reconciled: boolean;
  /** The merge ran out of time, which is not the same as never having been needed. */
  reconcileDropped: boolean;
  reconcileMs?: number | null;
  mergedText?: string | null;
}

/**
 * The per-lane detail stored for a multi-provider dictation, or null for every other row.
 *
 * Reads both shapes: the current `sides` array, and the A/B pair written before slots
 * existed. Parsed defensively either way — it is opaque JSON written by whichever version
 * of the app recorded the row, so a shape change must not take the history list down.
 */
function parseDual(raw?: string | null): DualDetail | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    const sides: DualSide[] = Array.isArray(d.sides)
      ? d.sides
          .filter((side: DualSide) => side && side.provider)
          .map((side: DualSide) => ({
            provider: side.provider,
            model: side.model,
            text: side.text,
            status: side.status,
            ms: side.ms,
            streaming: side.streaming,
          }))
      : [
          { provider: d.providerA, model: d.modelA, text: d.textA, status: d.statusA, ms: d.msA },
          { provider: d.providerB, model: d.modelB, text: d.textB, status: d.statusB, ms: d.msB },
        ].filter((side) => side.provider);
    if (sides.length === 0) return null;
    return {
      sides,
      reconciled: !!d.reconciled,
      reconcileDropped: !!d.reconcileDropped,
      reconcileMs: d.reconcileMs ?? null,
      mergedText: d.mergedText ?? null,
    };
  } catch {
    return null;
  }
}

interface ScreenReplacement {
  from: string;
  to: string;
  kind: string;
}

interface ScreenContextDetail {
  replacements: ScreenReplacement[];
}

/**
 * The words screen context rewrote, or null for every row it left alone.
 *
 * This is all that is persisted. The vocabulary those words came from is held in
 * memory only (see screenContextTerms) and read separately below, so an expanded
 * row shows the terms for this session and only the corrections after a restart.
 *
 * Parsed defensively for the same reason as the dual detail: it is opaque JSON
 * written by whichever version of the app recorded the row, and a shape change
 * must not take the history list down with it. Rows written by earlier builds
 * carry extra keys, which are simply ignored.
 */
function parseScreenContext(raw?: string | null): ScreenContextDetail | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const replacements: ScreenReplacement[] = Array.isArray(parsed.replacements)
      ? parsed.replacements
          .filter((entry: ScreenReplacement) => entry && entry.from && entry.to)
          .map((entry: ScreenReplacement) => ({
            from: String(entry.from),
            to: String(entry.to),
            kind: entry.kind === "substitute" ? "substitute" : "recase",
          }))
      : [];
    if (replacements.length === 0) return null;
    return { replacements };
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
  /**
   * Terms OCR'd from the window this dictation was made into, when they are still
   * held in memory. Absent for dictations from a previous run of the app, since they
   * are deliberately never persisted.
   */
  screenTerms?: ScreenContextTerms;
}

export default function TranscriptionItem({
  item,
  onCopy,
  onDelete,
  onShowAudioInFolder,
  onRetryTranscription,
  onOpenSettings,
  screenTerms,
}: TranscriptionItemProps) {
  const { t, i18n } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);

  const isFailed = item.status === "failed";
  const isDiscarded = item.status === "discarded";
  const rawText = item.raw_text;
  const dual = parseDual(item.dual_json);
  const screenContext = parseScreenContext(item.screen_context_json);
  // Which of the candidate terms actually landed in the transcript, so the list
  // below distinguishes "was available" from "was used".
  const usedTerms = useMemo(
    () => new Set((screenContext?.replacements ?? []).map((r) => r.to.toLowerCase())),
    [screenContext]
  );
  const hasRawText = rawText !== null;
  const hasAudio = item.has_audio === 1;
  // The dual breakdown lives in the same expandable panel, so a dual row with no raw
  // text still needs the toggle. Same for a row screen context rewrote, or one whose
  // terms are still in memory from this session.
  const hasExpandable = hasRawText || !!dual || !!screenContext || !!screenTerms;
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

  // With two lanes the interesting comparison is against each other. With three there is
  // no single "other side", so each lane is compared against the merged result instead —
  // which answers the question that actually matters: what did this provider get wrong?
  const sideDiffs = useMemo(() => {
    const sides = dual?.sides ?? [];
    const withText = sides.filter((side) => side.text);
    if (withText.length < 2) return null;
    if (withText.length === 2) {
      const pair = diffTranscripts(withText[0].text as string, withText[1].text as string);
      return new Map<number, DiffToken[]>([
        [sides.indexOf(withText[0]), pair.a],
        [sides.indexOf(withText[1]), pair.b],
      ]);
    }
    const reference = dual?.mergedText;
    if (!reference) return null;
    return new Map<number, DiffToken[]>(
      withText.map((side) => [
        sides.indexOf(side),
        diffTranscripts(side.text as string, reference).a,
      ])
    );
  }, [dual]);

  // The disagreement figure only means something for a pair; with three lanes there is no
  // single ratio to quote, so the label is left off rather than made up.
  const pairDiff = useMemo(() => {
    const withText = (dual?.sides ?? []).filter((side) => side.text);
    if (withText.length !== 2) return null;
    return diffTranscripts(withText[0].text as string, withText[1].text as string);
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
                    : dual.reconcileDropped
                      ? t("controlPanel.history.dualMergeDroppedShort")
                      : t("controlPanel.history.dualNoMergeShort")}
                </span>
                {isExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
              </button>
            )}

            {/* Also always visible: a transcript was rewritten from what was on
                screen, and the user should be able to tell that from the list
                rather than only after expanding a row they had no reason to. */}
            {(screenContext || screenTerms) && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setIsExpanded(!isExpanded);
                }}
                className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors"
              >
                <ScanText size={10} />
                <span className="whitespace-nowrap">
                  {screenContext
                    ? t("controlPanel.history.screenContextCount", {
                        words: screenContext.replacements.length,
                      })
                    : t("controlPanel.history.screenContextRead", {
                        words: screenTerms?.termCount ?? 0,
                      })}
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
                          {side.streaming ? (
                            <span
                              className="ml-1.5 normal-case text-primary/60"
                              title={t("controlPanel.history.laneStreamingHint")}
                            >
                              {t("controlPanel.history.laneStreaming")}
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
                          sideDiffs?.get(index) ? (
                            <DiffText tokens={sideDiffs.get(index) as DiffToken[]} />
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
                        : dual.reconcileDropped
                          ? t("controlPanel.history.dualMergeDropped")
                          : t("controlPanel.history.dualNotMerged")}
                    </span>
                    <span className="flex items-center gap-2 shrink-0">
                      {pairDiff && pairDiff.changeRatio > 0 && (
                        <span className="text-[10px] tabular-nums text-muted-foreground/50">
                          {t("controlPanel.history.dualDisagreement", {
                            percent: Math.max(1, Math.round(pairDiff.changeRatio * 100)),
                          })}
                        </span>
                      )}
                      {pairDiff?.punctuationOnly && (
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
            {/* Every word screen context changed, spelled out. A recase is
                cosmetic, but a substitute replaced one word with a different one
                on the strength of a phonetic guess — so it is named and labelled by
                which tier did it. */}
            {(screenContext || screenTerms) && (
              <div className="border-t border-border/20 mt-2 pt-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    <ScanText size={10} />
                    {t("controlPanel.history.screenContextTitle")}
                  </span>
                  {/* In-memory only, like the terms — a window title is often the
                      most identifying thing on a screen. */}
                  {screenTerms?.window && (
                    <span className="truncate text-[10px] text-muted-foreground/50">
                      {screenTerms.window}
                    </span>
                  )}
                </div>
                {screenContext ? (
                  <ul className="mt-1 space-y-0.5">
                    {screenContext.replacements.map((replacement, index) => (
                      <li
                        key={`${index}-${replacement.from}`}
                        className="flex items-baseline gap-1.5 text-xs"
                      >
                        <span className="text-muted-foreground/60 line-through">
                          {replacement.from}
                        </span>
                        <span className="text-muted-foreground/40">&rarr;</span>
                        <mark className="rounded-[2px] bg-primary/15 px-[1px] font-semibold text-foreground">
                          {replacement.to}
                        </mark>
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/50">
                          {replacement.kind === "substitute"
                            ? t("controlPanel.history.screenContextSubstitute")
                            : t("controlPanel.history.screenContextRecase")}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs italic text-muted-foreground/50">
                    {t("controlPanel.history.screenContextNoCorrections")}
                  </p>
                )}

                {/* The vocabulary that was on offer, whether or not any of it was
                    used. Without this a row that corrected nothing is unreadable:
                    there is no way to tell a window with nothing worth fixing from
                    the wrong window, or from a capture that read no text at all.
                    Never persisted, so this is here for dictations from this session
                    and absent for anything older. */}
                {screenTerms && screenTerms.terms.length > 0 && (
                  <div className="mt-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                        {t("controlPanel.history.screenContextTerms", {
                          words: screenTerms.termCount,
                        })}
                      </span>
                      {/* Only worth saying when something is actually marked. */}
                      {usedTerms.size > 0 && (
                        <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/60">
                          <Check size={9} className="text-primary" />
                          {t("controlPanel.history.screenContextUsedLegend")}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {screenTerms.terms.map((term, index) => {
                        const used = usedTerms.has(term.toLowerCase());
                        return (
                          <span
                            key={`${index}-${term}`}
                            className={cn(
                              "inline-flex items-center gap-0.5 rounded-sm px-1 py-px text-[10px] leading-relaxed",
                              // A used term has to be findable at a glance in a list of
                              // hundreds, so it gets a tick and a border rather than a
                              // tint that disappears among its neighbours.
                              used
                                ? "border border-primary/40 bg-primary/20 font-semibold text-foreground"
                                : "border border-transparent bg-foreground/5 text-muted-foreground/70"
                            )}
                          >
                            {used && <Check size={9} className="text-primary" />}
                            {term}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
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
