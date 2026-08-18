import { resolvePrompt } from "./prompts/index";

export {
  resolvePrompt,
  getDefaultPromptText,
  appendDictionarySuffix,
  wrapCleanupTranscript,
} from "./prompts/index";
export { PROMPT_KINDS, PROMPT_KIND_LIST, type PromptKind } from "./prompts/registry";
export { detectAgentName } from "./agentDetection";

export function getCleanupSystemPrompt(
  agentName: string | null,
  customDictionary?: string[],
  language?: string,
  uiLanguage?: string
): string {
  return resolvePrompt("cleanup", { agentName, language, customDictionary, uiLanguage });
}

// The cleanup prompt adapted for two candidate transcripts: same cleanup rules,
// injection resistance and examples, with a reconcile step in front.
export function getReconcileSystemPrompt(
  agentName: string | null,
  customDictionary?: string[],
  language?: string,
  uiLanguage?: string,
  vocabulary?: string[]
): string {
  return resolvePrompt("reconcile", {
    agentName,
    language,
    customDictionary,
    uiLanguage,
    vocabulary,
  });
}

// Mirrors wrapCleanupTranscript, which tags the single-transcript input.
export interface ReconcileVersion {
  text: string;
  /** Recogniser behind this version, labelled in the prompt so its tie-break applies. */
  provider?: string;
}

/**
 * Wraps two or more candidate transcripts for the merge.
 *
 * Tags are version_a, version_b, version_c… in the order given, and that order matters:
 * asked to choose between readings it cannot separate on the merits, the model favours
 * the earlier version, so callers pass their most trusted recogniser first.
 */
export function wrapReconcileVersions(versions: ReconcileVersion[]): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const blocks = versions.map((version, index) => {
    const tag = `version_${letters[index] ?? index + 1}`;
    // Omitted rather than guessed when unknown: a wrong label is worse than none.
    const open = version.provider ? `<${tag} recogniser="${version.provider}">` : `<${tag}>`;
    return `${open}\n${version.text}\n</${tag}>`;
  });
  return `${blocks.join("\n\n")}\n\nOutput only the reconciled, cleaned transcript.`;
}

export function getWordBoost(customDictionary?: string[]): string[] {
  if (!customDictionary || customDictionary.length === 0) return [];
  return customDictionary.filter((w) => w.trim());
}

const TOOL_INSTRUCTIONS: Record<string, string> = {
  search_notes:
    "Use search_notes to find information from the user's past meetings, discussions, or personal notes before answering from memory.",
  get_note:
    "Use get_note to fetch the full content of a specific note by ID. If the current note's ID is provided in the context, use it directly. Otherwise, use search_notes first to find the note ID.",
  create_note:
    "Use create_note when the user asks you to create, write, or draft a new note. Whenever the note will go into a folder, call list_folders first and reuse an existing folder whose name is a reasonable fit for the note's topic (e.g. a new story belongs in an existing 'Stories' folder) — do this even when the user didn't name a folder but the content clearly fits one. Only pass a new folder name when nothing existing fits. Be tolerant of case, plurals, and typos.",
  update_note:
    "Use update_note to modify an existing note's title, content, or move it to a different folder. If the current note's ID is provided in the context, use it directly. Otherwise, use search_notes first to find the note ID. When moving to a folder, call list_folders first and reuse an existing folder whose name fits the note's topic; only create a new folder when nothing existing fits.",
  list_folders:
    "Use list_folders before create_note or update_note whenever a note is going into a folder, so you can reuse an existing folder whose name fits the note's topic instead of creating a near-duplicate.",
  web_search:
    "Use web_search for questions about current events, facts you're unsure about, or anything requiring up-to-date information.",
  copy_to_clipboard:
    "Use copy_to_clipboard when the user asks you to copy something to their clipboard.",
  get_calendar_events:
    "Use get_calendar_events to check the user's schedule, upcoming meetings, or calendar events.",
};

export function getAgentSystemPrompt(availableTools?: string[], noteContext?: string): string {
  let prompt = resolvePrompt("chatAgent", { agentName: null });

  if (availableTools && availableTools.length > 0) {
    const toolLines = availableTools.map((name) => TOOL_INSTRUCTIONS[name]).filter(Boolean);
    if (toolLines.length > 0) {
      prompt += "\n\nYou have access to tools. " + toolLines.join(" ");
    }
  }

  if (noteContext) {
    prompt +=
      "\n\nBelow are notes from the user's library that may be relevant. " +
      "Reference them naturally if they help answer the question.\n\n" +
      noteContext;
  }

  return prompt;
}
