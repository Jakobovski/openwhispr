// One place that says how the merge is called.
//
// Two callers now: the dictation path in audioManager, and the Cleanup panel's test
// button, which exists so the prompt can be edited and tried against two candidate
// transcripts before it is trusted with real dictation. A test that assembled the call
// itself would be free to drift — a different temperature, a missing vocabulary, a
// different provider — and would then be reassuring about a request the app never makes.

import {
  getReconcileSystemPrompt,
  wrapReconcileVersions,
  type ReconcileVersion,
} from "../config/prompts";
import { getSettings, getEffectiveReconcileModel } from "../stores/settingsStore";
import { DEFAULT_RECONCILE_PROVIDER } from "../config/multiTranscription";

export interface ReconcileRequestOptions {
  /** Candidate transcripts in slot order — the order the prompt's tie-break reads. */
  versions: ReconcileVersion[];
  agentName?: string | null;
  /** Dictation language, so the prompt keeps its language instruction. */
  language?: string;
  /**
   * The speaker's vocabulary: custom dictionary first, then the terms read off screen.
   * The same list the recogniser was biased with — see getDictationVocabulary.
   */
  vocabulary?: string[];
  /**
   * Explicit provider/model, for dual cleanup mode's second race lane. Omit both to get
   * slot A's settings (getEffectiveReconcileModel) — the single-model behaviour every
   * caller had before racing existed, still what the Cleanup panel's test button uses.
   */
  provider?: string;
  model?: string;
}

export interface ReconcileRequest {
  /** The user message: the labelled versions plus the output contract. */
  input: string;
  model: string;
  options: {
    provider: string;
    systemPrompt: string;
    temperature: number;
    disableThinking: boolean;
  };
}

/**
 * The exact request the merge makes, minus the transport.
 *
 * temperature 0 and no thinking budget because this sits in the paste path after the
 * user has stopped speaking: it is a judgement about what was said, not a creative task,
 * and a reasoning model's preamble would blow the merge deadline.
 */
export function buildReconcileRequest({
  versions,
  agentName = null,
  language,
  vocabulary,
  provider,
  model,
}: ReconcileRequestOptions): ReconcileRequest {
  const settings = getSettings();
  return {
    input: wrapReconcileVersions(versions),
    model: model ?? getEffectiveReconcileModel(),
    options: {
      provider:
        provider ?? (settings.dualTranscriptionReconcileProvider || DEFAULT_RECONCILE_PROVIDER),
      // The app's own cleanup prompt with a reconcile step in front: same localisation,
      // {{agentName}} handling, injection resistance and examples.
      systemPrompt: getReconcileSystemPrompt(
        agentName,
        // No separate dictionary argument: it is already the head of the vocabulary, and
        // passing both would list every curated word twice.
        undefined,
        language,
        settings.uiLanguage,
        vocabulary
      ),
      temperature: 0,
      disableThinking: true,
    },
  };
}
