// Settings section identity, shared between the sidebar and the panel.
//
// These used to live inside SettingsModal, which was the only thing that could
// open a section. Settings now renders inline in the control panel, so the
// alias tables have to be reachable from the panel itself.

import type { SettingsSectionType } from "./SettingsPage";
import { WORKSPACES_ENABLED } from "../lib/features";

export type { SettingsSectionType };

// Every section id, as a runtime value. The type alone cannot tell us whether an
// arbitrary view string is a settings section, and the panel needs to know that
// to decide whether to render SettingsPage.
export const SETTINGS_SECTION_IDS = [
  "account",
  "plansBilling",
  "workspace",
  "general",
  "hotkeys",
  "speechToText",
  "llms",
  "cleanup",
  "privacyData",
  "system",
] as const satisfies readonly SettingsSectionType[];

const SETTINGS_SECTION_SET: ReadonlySet<string> = new Set(SETTINGS_SECTION_IDS);

export function isSettingsSection(view: string): view is SettingsSectionType {
  return SETTINGS_SECTION_SET.has(view);
}

// The old AI Models sidebar had four items (transcription, meetings,
// intelligence, agentMode) — they now collapse into three: speechToText, llms and
// cleanup. Legacy deep-links land on the matching sub-tab via LEGACY_SUB_TAB.
//
// `intelligence` and `prompts` used to open Language Models -> Dictation Cleanup. That
// tab is gone: multi transcription merges the candidate transcripts and cleans them in
// the same call, so the prompt that matters is the merge prompt. Both now land on the
// Cleanup section, which is where that prompt lives.
const SECTION_ALIASES: Record<string, SettingsSectionType> = {
  aiModels: "cleanup",
  agentConfig: "llms",
  agentMode: "llms",
  intelligence: "cleanup",
  meetings: "llms",
  prompts: "cleanup",
  transcription: "speechToText",
  uploadTranscription: "speechToText",
  softwareUpdates: "system",
  privacy: "privacyData",
  permissions: "privacyData",
  developer: "system",
};

const LEGACY_SUB_TAB: Record<string, string> = {
  transcription: "dictation",
  uploadTranscription: "upload",
  meetings: "noteFormatting",
  agentMode: "chatIntelligence",
  agentConfig: "chatIntelligence",
};

/** The section the panel lands on when nothing more specific was requested. */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionType = "account";

export function resolveSettingsSection(section: string | undefined): SettingsSectionType {
  if (!section) return DEFAULT_SETTINGS_SECTION;
  const resolved = (SECTION_ALIASES[section] ?? section) as SettingsSectionType;
  if (resolved === "workspace" && !WORKSPACES_ENABLED) return DEFAULT_SETTINGS_SECTION;
  if (!SETTINGS_SECTION_SET.has(resolved)) return DEFAULT_SETTINGS_SECTION;
  return resolved;
}

export function resolveSettingsSubTab(section: string | undefined): string | undefined {
  return section ? LEGACY_SUB_TAB[section] : undefined;
}
