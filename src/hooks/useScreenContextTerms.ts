import { useCallback, useEffect, useState } from "react";
import type { ScreenContextTerms } from "../types/electron";

/**
 * The OCR'd vocabulary for recent dictations, fetched from the main process.
 *
 * It has to come over IPC rather than from a module in this window: dictation runs
 * in the overlay window and history renders in the control panel, which are
 * separate renderer processes. The main process holds it, in memory only.
 *
 * Refetched when a dictation is added or removed, so an open history picks up the
 * terms for a dictation that just happened.
 */
export function useScreenContextTerms(): Record<string, ScreenContextTerms> {
  const [terms, setTerms] = useState<Record<string, ScreenContextTerms>>({});

  const refresh = useCallback(async () => {
    const next = await window.electronAPI?.getScreenContextTerms?.();
    setTerms(next ?? {});
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onChanged = () => void refresh();
    const cleanups = [
      window.electronAPI?.onTranscriptionAdded?.(onChanged),
      window.electronAPI?.onTranscriptionDeleted?.(onChanged),
      window.electronAPI?.onTranscriptionsCleared?.(onChanged),
    ];
    return () => {
      for (const cleanup of cleanups) cleanup?.();
    };
  }, [refresh]);

  return terms;
}

export default useScreenContextTerms;
