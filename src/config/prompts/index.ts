import i18n, { normalizeUiLanguage } from "../../i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { en as enPrompts } from "../../locales/prompts";
import { getLanguageInstruction } from "../../utils/languageSupport";
import { PROMPT_KINDS, type PromptKind } from "./registry";

export { PROMPT_KINDS, PROMPT_KIND_LIST, type PromptKind } from "./registry";

export interface ResolvePromptOptions {
  agentName: string | null;
  uiLanguage?: string;
  language?: string;
  customDictionary?: string[];
  /**
   * The speaker's vocabulary for this dictation: their custom dictionary followed by the
   * distinctive terms read from the window they were looking at. The same list the
   * recogniser is biased with, so the merge and the recogniser agree about what words
   * were in play.
   *
   * Screen terms are single tokens by construction — extraction splits on whitespace —
   * so this cannot smuggle a sentence into the prompt.
   */
  vocabulary?: string[];
  targetLanguageLabel?: string;
}

export function resolvePrompt(kind: PromptKind, opts: ResolvePromptOptions): string {
  const custom = useSettingsStore.getState().customPrompts[kind];
  const template = custom || getDefaultPromptText(kind, opts.uiLanguage);
  return applySubstitutions(template, opts);
}

export function getDefaultPromptText(kind: PromptKind, uiLanguage?: string): string {
  const def = PROMPT_KINDS[kind];
  if (!def.i18nKey) return def.fallback;
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const t = i18n.getFixedT(locale, "prompts");
  return t(def.i18nKey, { defaultValue: def.fallback });
}

// The cleanup prompt tells the model its input arrives between <transcript>
// tags; the trailing line re-anchors the output contract right after the
// transcript, where models weight instructions most. Mirrors api/reason.ts
// in openwhispr-api.
export function wrapCleanupTranscript(text: string): string {
  return `<transcript>\n${text}\n</transcript>\n\nOutput only the cleaned transcript.`;
}

export function appendDictionarySuffix(
  prompt: string,
  customDictionary?: string[],
  uiLanguage?: string
): string {
  if (!customDictionary?.length) return prompt;
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const suffix = i18n.getFixedT(locale, "prompts")("dictionarySuffix", {
    defaultValue: enPrompts.dictionarySuffix,
  });
  return prompt + suffix + customDictionary.join(", ");
}

/**
 * Appends the speaker's vocabulary for this dictation.
 *
 * One list rather than a curated block and a screen block, because it is one list
 * everywhere else: the same array is what biases the recogniser. Two assemblies of the
 * same idea drifted apart once already — different caps, different contents, and the
 * merge seeing words the recogniser never got. Ordering carries the authority instead:
 * the dictionary comes first, so it survives the cap when a dense window would fill it.
 */
export function appendVocabularySuffix(
  prompt: string,
  vocabulary?: string[],
  uiLanguage?: string
): string {
  if (!vocabulary?.length) return prompt;
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const suffix = i18n.getFixedT(locale, "prompts")("vocabularySuffix", {
    defaultValue: enPrompts.vocabularySuffix,
  });
  return prompt + suffix + vocabulary.join(", ");
}

function applySubstitutions(template: string, opts: ResolvePromptOptions): string {
  const name = opts.agentName?.trim() || "Assistant";
  let prompt = template.replace(/\{\{agentName\}\}/g, name);

  if (opts.targetLanguageLabel) {
    prompt = prompt.replace(/\{\{targetLanguage\}\}/g, opts.targetLanguageLabel);
  }

  const langInstruction = getLanguageInstruction(opts.language);
  if (langInstruction) prompt += "\n\n" + langInstruction;

  const withDictionary = appendDictionarySuffix(prompt, opts.customDictionary, opts.uiLanguage);
  return appendVocabularySuffix(withDictionary, opts.vocabulary, opts.uiLanguage);
}
