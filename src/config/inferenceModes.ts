import settingsDefaults from "./settingsDefaults.json" with { type: "json" };
import type { InferenceMode } from "../types/electron";

/**
 * Which mode the Settings tabs select on, derived from the underlying transcription
 * fields. Shared by the provider-settings migration and the onboarding "use this
 * provider everywhere" action so they cannot reach different conclusions.
 *
 * An absent cloud mode means "nobody has chosen", which resolves to the store's default
 * rather than to OpenWhispr cloud. Reading it as a bare null is what made a fresh
 * install land on OpenWhispr cloud while the store's own default said byok: the
 * migration below derived a mode from nulls and *persisted* it, so the wrong answer
 * outlived the default that was supposed to decide.
 */
export function deriveTranscriptionMode(
  useLocalWhisper: boolean,
  cloudTranscriptionMode: string | null,
  cloudTranscriptionProvider: string | null
): InferenceMode {
  if (useLocalWhisper) return "local";
  const mode = cloudTranscriptionMode ?? settingsDefaults.storeDefaults.cloudTranscriptionMode;
  if (mode === "byok") {
    return cloudTranscriptionProvider === "custom" ? "self-hosted" : "providers";
  }
  return "openwhispr";
}

/** The localStorage keys the provider-settings migration converts. */
const MIGRATION_SOURCE_KEYS = [
  "cloudTranscriptionMode",
  "useLocalWhisper",
  "cloudTranscriptionProvider",
  "cloudReasoningMode",
  "reasoningProvider",
];

/**
 * True when there is nothing to migrate, so the migration must write nothing.
 *
 * A migration exists to convert settings an earlier version stored. Run against a
 * profile that has none — a fresh install — it has no input, and anything it writes is
 * an invented default competing with the store's real one. Worse, it wins: the store
 * only falls back when a key is *absent*, and the migration just made it present.
 */
export function hasNoStoredProviderSettings(
  getItem: (key: string) => string | null = (key) =>
    typeof localStorage === "undefined" ? null : localStorage.getItem(key)
): boolean {
  return MIGRATION_SOURCE_KEYS.every((key) => getItem(key) === null);
}
