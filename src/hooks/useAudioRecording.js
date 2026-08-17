import { useState, useEffect, useRef, useCallback, createElement } from "react";
import { useTranslation } from "react-i18next";
import AudioManager from "../helpers/audioManager";
import logger from "../utils/logger";
import { playStartCue, playStopCue } from "../utils/dictationCues";
import { getSettings } from "../stores/settingsStore";
import { expandSnippets } from "../utils/snippets";
import { getRecordingErrorTitle, getRecordingErrorDescription } from "../utils/recordingErrors";
import { isAccessibilitySkipped } from "../utils/permissions";

/**
 * Whether this install talks to OpenWhispr's own transcription service.
 *
 * The cloud STT config only exists for that mode; a BYOK install asking for it produced
 * 327 failed requests across the local logs, each logged as an ERROR.
 */
const usesOpenWhisprCloud = () => {
  const settings = getSettings();
  return !settings.useLocalWhisper && settings.cloudTranscriptionMode === "openwhispr";
};

// How long the timing readout stays on screen after a dictation.
const STATS_VISIBLE_MS = 4000;

export const useAudioRecording = (toast, options = {}) => {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [micCaptureStatus, setMicCaptureStatus] = useState("inactive");
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  // Timing readout shown briefly beside the mic once a dictation lands.
  const [lastStats, setLastStats] = useState(null);
  const statsTimerRef = useRef(null);
  const audioManagerRef = useRef(null);
  const startLockRef = useRef(false);
  const stopLockRef = useRef(false);
  const wasRecordingRef = useRef(false);
  const wasMicUnavailableRef = useRef(false);
  const { onToggle } = options;

  const performStartRecording = useCallback(
    async ({ voiceAgentRequested = false, translationRequested = false } = {}) => {
      if (startLockRef.current) return false;
      startLockRef.current = true;
      try {
        if (!audioManagerRef.current) return false;

        const currentState = audioManagerRef.current.getState();
        if (currentState.isRecording || currentState.isProcessing) return false;

        audioManagerRef.current.setVoiceAgentRequested(voiceAgentRequested);
        audioManagerRef.current.setTranslationRequested(translationRequested);

        // Retry STT config fetch if it wasn't loaded on mount (e.g. auth wasn't ready).
        // Only in cloud mode: on BYOK the endpoint is never configured, so asking is a
        // guaranteed failed request and an ERROR line that buries real ones.
        if (!audioManagerRef.current.sttConfig && usesOpenWhisprCloud()) {
          const config = await window.electronAPI.getSttConfig?.();
          if (config?.success) {
            audioManagerRef.current.setSttConfig(config);
          }
        }

        const didStart = audioManagerRef.current.shouldUseStreaming()
          ? await audioManagerRef.current.startStreamingRecording()
          : await audioManagerRef.current.startRecording();

        // A quick tap can end the recording inside the start call itself (deferred
        // streaming stop) — don't pause media for a recording that already ended. See #1060.
        if (didStart && audioManagerRef.current.getState().isRecording) {
          if (getSettings().pauseMediaOnDictation) {
            window.electronAPI?.pauseMediaPlayback?.();
          }
          window.electronAPI?.registerCancelHotkey?.("Escape");
          void playStartCue();
        }

        return didStart;
      } finally {
        startLockRef.current = false;
      }
    },
    []
  );

  const performStopRecording = useCallback(async () => {
    if (stopLockRef.current) return false;
    stopLockRef.current = true;
    try {
      if (!audioManagerRef.current) return false;

      const currentState = audioManagerRef.current.getState();
      if (!currentState.isRecording && !currentState.isStreamingStartInProgress) return false;

      window.electronAPI?.unregisterCancelHotkey?.();

      if (currentState.isStreaming || currentState.isStreamingStartInProgress) {
        void playStopCue();
        return await audioManagerRef.current.stopStreamingRecording();
      }

      const didStop = audioManagerRef.current.stopRecording();

      if (didStop) {
        void playStopCue();
      }

      return didStop;
    } finally {
      stopLockRef.current = false;
    }
  }, []);

  useEffect(() => {
    audioManagerRef.current = new AudioManager();

    audioManagerRef.current.setCallbacks({
      onStateChange: ({ isRecording, isProcessing, isStreaming, micCaptureStatus }) => {
        if (!isRecording) {
          window.electronAPI?.unregisterCancelHotkey?.();
          // Resume media the instant recording ends, not after transcription.
          if (wasRecordingRef.current && getSettings().pauseMediaOnDictation) {
            window.electronAPI?.resumeMediaPlayback?.();
          }
        }
        wasRecordingRef.current = isRecording;
        setIsRecording(isRecording);
        setIsProcessing(isProcessing);
        setIsStreaming(isStreaming ?? false);
        if (micCaptureStatus) {
          setMicCaptureStatus(micCaptureStatus);
          const unavailable = micCaptureStatus === "unavailable";
          if (unavailable && !wasMicUnavailableRef.current) {
            wasMicUnavailableRef.current = true;
            toast({
              title: t("hooks.audioRecording.micDisconnected.title"),
              description: t("hooks.audioRecording.micDisconnected.description"),
              variant: "default",
            });
          } else if (micCaptureStatus === "active" && wasMicUnavailableRef.current) {
            wasMicUnavailableRef.current = false;
            toast({
              title: t("hooks.audioRecording.micRestored.title"),
              description: t("hooks.audioRecording.micRestored.description"),
              variant: "default",
            });
          } else if (micCaptureStatus === "inactive") {
            wasMicUnavailableRef.current = false;
          }
        }
        if (!isStreaming) {
          setPartialTranscript("");
        }
      },
      onError: (error) => {
        if (error?.title !== "Paste Error") {
          window.electronAPI?.hideDictationPreview?.();
        }
        const title = getRecordingErrorTitle(error, t);
        const description = getRecordingErrorDescription(error, t);
        toast({
          title,
          description,
          variant: "destructive",
          duration: error.code === "AUTH_EXPIRED" ? 8000 : undefined,
        });
        if (getSettings().pauseMediaOnDictation) {
          window.electronAPI?.resumeMediaPlayback?.();
        }
      },
      onPartialTranscript: (text) => {
        setPartialTranscript(text);
      },
      onTranscriptionComplete: async (result) => {
        if (result.success) {
          if (result.stats) {
            clearTimeout(statsTimerRef.current);
            setLastStats(result.stats);
            statsTimerRef.current = setTimeout(() => setLastStats(null), STATS_VISIBLE_MS);
          }
          const transcribedText = result.text?.trim();

          if (!transcribedText) {
            window.electronAPI?.hideDictationPreview?.();
            toast({
              title: t("hooks.audioRecording.noAudio.title"),
              description: t("hooks.audioRecording.noAudio.description"),
              variant: "default",
            });
            return;
          }

          result.text = expandSnippets(result.text, getSettings().snippets);

          setTranscript(result.text);
          window.electronAPI?.completeDictationPreview?.({ text: result.text });

          if (result.warning) {
            toast({
              title: t("hooks.audioRecording.partialTranscription.title"),
              description: t("hooks.audioRecording.partialTranscription.description"),
              variant: "default",
            });
          }

          const isStreaming = result.source?.includes("streaming");
          const { autoPasteEnabled, keepTranscriptionInClipboard } = getSettings();

          if (autoPasteEnabled) {
            const pasteStart = performance.now();
            await audioManagerRef.current.safePaste(result.text, {
              ...(isStreaming ? { fromStreaming: true } : {}),
              restoreClipboard: !keepTranscriptionInClipboard,
              allowClipboardFallback: isAccessibilitySkipped(),
            });
            logger.info(
              "Paste timing",
              {
                pasteMs: Math.round(performance.now() - pasteStart),
                source: result.source,
                textLength: result.text.length,
              },
              "streaming"
            );
          } else if (keepTranscriptionInClipboard) {
            await navigator.clipboard.writeText(result.text);
          }

          audioManagerRef.current.saveTranscription(result.text, result.rawText ?? result.text, {
            clientTranscriptionId: result.clientTranscriptionId,
            dual: result.dual ?? null,
          });

          if (result.source === "openai" && getSettings().useLocalWhisper) {
            toast({
              title: t("hooks.audioRecording.fallback.title"),
              description: t("hooks.audioRecording.fallback.description"),
              variant: "default",
            });
          }

          // Cloud usage: limit reached after this transcription
          if (result.source === "openwhispr" && result.limitReached) {
            // Notify control panel to show UpgradePrompt dialog
            window.electronAPI?.notifyLimitReached?.({
              wordsUsed: result.wordsUsed,
              limit:
                result.wordsRemaining !== undefined
                  ? result.wordsUsed + result.wordsRemaining
                  : 2000,
            });
          }

          if (audioManagerRef.current.shouldUseStreaming()) {
            audioManagerRef.current.warmupStreamingConnection();
          }
        }
      },
      onTranslationFallback: ({ reason }) => {
        // Fail-open: the raw text was still pasted; the toast removes the silence.
        toast({
          title:
            reason === "unreachable"
              ? t("hooks.audioRecording.translationFallback.unreachableTitle")
              : t("hooks.audioRecording.translationFallback.failedTitle"),
          description:
            reason === "unreachable"
              ? t("hooks.audioRecording.translationFallback.unreachableDescription")
              : t("hooks.audioRecording.translationFallback.failedDescription"),
          variant: "default",
        });
      },
      onScreenContextBlocked: () => {
        // Screen context is on and did nothing, because macOS has not granted
        // Screen Recording. Destructive and long-lived on purpose: this is a
        // feature the user turned on that is silently inert, and the fix is one
        // click away in a settings pane they would otherwise have to find.
        toast({
          title: t("hooks.audioRecording.screenContextBlocked.title"),
          description: t("hooks.audioRecording.screenContextBlocked.description"),
          variant: "destructive",
          duration: 15000,
          action: createElement(
            "button",
            {
              type: "button",
              onClick: () => window.electronAPI?.openScreenRecordingSettings?.(),
              className:
                "shrink-0 rounded-md border border-white/30 px-2.5 py-1 text-xs font-medium hover:bg-white/10",
            },
            t("hooks.audioRecording.screenContextBlocked.action")
          ),
        });
      },
    });

    audioManagerRef.current.setContext("dictation");
    if (usesOpenWhisprCloud()) {
      window.electronAPI.getSttConfig?.().then((config) => {
        if (config?.success && audioManagerRef.current) {
          audioManagerRef.current.setSttConfig(config);
          if (audioManagerRef.current.shouldUseStreaming()) {
            audioManagerRef.current.warmupStreamingConnection();
          }
        }
      });
    }

    const handleToggle = async ({
      voiceAgentRequested = false,
      translationRequested = false,
    } = {}) => {
      if (!audioManagerRef.current) return;
      // Lazily warm the mic driver on first dictation use, not at launch. See #871.
      audioManagerRef.current.warmupMicDriver?.();
      const currentState = audioManagerRef.current.getState();

      if (!currentState.isRecording && !currentState.isProcessing) {
        await performStartRecording({ voiceAgentRequested, translationRequested });
      } else if (currentState.isRecording) {
        await performStopRecording();
      }
    };

    const handleStart = async () => {
      audioManagerRef.current?.warmupMicDriver?.();
      await performStartRecording();
    };

    const handleStop = async () => {
      await performStopRecording();
    };

    const disposeToggle = window.electronAPI.onToggleDictation(() => {
      handleToggle();
      onToggle?.();
    });

    const disposeVoiceAgentToggle = window.electronAPI.onToggleVoiceAgent?.(() => {
      handleToggle({ voiceAgentRequested: true });
      onToggle?.();
    });

    const disposeTranslationToggle = window.electronAPI.onToggleTranslation?.(() => {
      handleToggle({ translationRequested: true });
      onToggle?.();
    });

    const disposeStart = window.electronAPI.onStartDictation?.(() => {
      handleStart();
      onToggle?.();
    });

    const disposeStop = window.electronAPI.onStopDictation?.(() => {
      handleStop();
      onToggle?.();
    });

    const handleNoAudioDetected = () => {
      if (getSettings().pauseMediaOnDictation) {
        window.electronAPI?.resumeMediaPlayback?.();
      }
      toast({
        title: t("hooks.audioRecording.noAudio.title"),
        description: t("hooks.audioRecording.noAudio.description"),
        variant: "default",
      });
    };

    const disposeNoAudio = window.electronAPI.onNoAudioDetected?.(handleNoAudioDetected);

    // Cleanup
    return () => {
      disposeToggle?.();
      disposeVoiceAgentToggle?.();
      disposeTranslationToggle?.();
      disposeStart?.();
      disposeStop?.();
      disposeNoAudio?.();
      if (audioManagerRef.current) {
        audioManagerRef.current.cleanup();
      }
    };
  }, [toast, onToggle, performStartRecording, performStopRecording, t]);

  const cancelRecording = useCallback(async () => {
    if (audioManagerRef.current) {
      window.electronAPI?.unregisterCancelHotkey?.();
      const state = audioManagerRef.current.getState();
      if (getSettings().pauseMediaOnDictation) {
        window.electronAPI?.resumeMediaPlayback?.();
      }
      if (state.isStreaming) {
        return await audioManagerRef.current.stopStreamingRecording();
      }
      return audioManagerRef.current.cancelRecording();
    }
    return false;
  }, []);

  const cancelProcessing = () => {
    if (audioManagerRef.current) {
      return audioManagerRef.current.cancelProcessing();
    }
    return false;
  };

  const toggleListening = async () => {
    if (!isRecording && !isProcessing) {
      await performStartRecording();
    } else if (isRecording) {
      await performStopRecording();
    }
  };

  return {
    isRecording,
    isProcessing,
    isStreaming,
    micCaptureStatus,
    transcript,
    partialTranscript,
    lastStats,
    startRecording: performStartRecording,
    stopRecording: performStopRecording,
    cancelRecording,
    cancelProcessing,
    toggleListening,
  };
};
