import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Textarea } from "./textarea";
import {
  Eye,
  Edit3,
  Play,
  Save,
  RotateCcw,
  Copy,
  TestTube,
  AlertTriangle,
  Check,
} from "lucide-react";
import { AlertDialog } from "./dialog";
import { useDialogs } from "../../hooks/useDialogs";
import { useAgentName } from "../../utils/agentName";
import ReasoningService from "../../services/ReasoningService";
import { getModelProvider } from "../../models/ModelRegistry";
import logger from "../../utils/logger";
import {
  appendVocabularySuffix,
  getDefaultPromptText,
  resolvePrompt,
  type PromptKind,
} from "../../config/prompts";
import { buildReconcileRequest } from "../../helpers/reconcileRequest";
import {
  getMultiTranscriptionProvider,
  resolveMultiTranscriptionLanes,
  MULTI_TRANSCRIPTION_PROVIDERS,
} from "../../config/multiTranscription";
import {
  useSettingsStore,
  selectEffectiveReconcileModel,
  selectIsCloudCleanupMode,
  selectIsCloudDictationAgentMode,
  selectIsCloudTranslationMode,
} from "../../stores/settingsStore";
import { getLanguageLabel } from "../../utils/languageSupport";
import { getDictionaryHintWords } from "../../utils/snippets";
import { resolveDictationAgentInference } from "../../helpers/dictationAgentInference";

interface PromptStudioProps {
  className?: string;
  kind?: PromptKind;
}

type ProviderConfig = {
  label: string;
  apiKeyStorageKey?: string;
  baseStorageKey?: string;
};

const PROVIDER_CONFIG: Record<string, ProviderConfig> = {
  openai: { label: "OpenAI", apiKeyStorageKey: "openaiApiKey" },
  anthropic: { label: "Anthropic", apiKeyStorageKey: "anthropicApiKey" },
  gemini: { label: "Gemini", apiKeyStorageKey: "geminiApiKey" },
  groq: { label: "Groq", apiKeyStorageKey: "groqApiKey" },
  xai: { label: "xAI", apiKeyStorageKey: "xaiApiKey" },
  openrouter: { label: "OpenRouter", apiKeyStorageKey: "openrouterApiKey" },
  tinfoil: { label: "Tinfoil", apiKeyStorageKey: "tinfoilApiKey" },
  openwhispr: { label: "OpenWhispr Cloud" },
  custom: {
    label: "Custom endpoint",
    apiKeyStorageKey: "openaiApiKey",
    baseStorageKey: "cleanupCloudBaseUrl",
  },
  local: { label: "Local" },
};

export default function PromptStudio({ className = "", kind = "cleanup" }: PromptStudioProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<"current" | "edit" | "test">("current");
  const [testText, setTestText] = useState(() =>
    t(
      kind === "translate"
        ? "promptStudio.defaultTestInputTranslate"
        : kind === "reconcile"
          ? "promptStudio.reconcile.defaultVersionA"
          : "promptStudio.defaultTestInput"
    )
  );
  // The merge reads two transcripts of the same audio, so it needs a second input. Kept
  // separate rather than parsed out of one box: the point of the test is that the two
  // disagree, and a delimiter the user has to get right hides that.
  const [testTextB, setTestTextB] = useState(() => t("promptStudio.reconcile.defaultVersionB"));
  const [testResult, setTestResult] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  const { alertDialog, showAlertDialog, hideAlertDialog } = useDialogs();
  const { agentName } = useAgentName();
  const uiLanguage = useSettingsStore((s) => s.uiLanguage);

  const isCloudMode = useSettingsStore(selectIsCloudCleanupMode);
  const useCleanupModel = useSettingsStore((s) => s.useCleanupModel);
  const cleanupModel = useSettingsStore((s) => s.cleanupModel);

  const isCloudDictationAgent = useSettingsStore(selectIsCloudDictationAgentMode);
  const useDictationAgent = useSettingsStore((s) => s.useDictationAgent);
  const dictationAgentProvider = useSettingsStore((s) => s.dictationAgentProvider);
  const dictationAgentModel = useSettingsStore((s) => s.dictationAgentModel);

  const isCloudTranslation = useSettingsStore(selectIsCloudTranslationMode);
  const useDictationTranslation = useSettingsStore((s) => s.useDictationTranslation);
  const translationMode = useSettingsStore((s) => s.translationMode);
  const translationProvider = useSettingsStore((s) => s.translationProvider);
  const translationModel = useSettingsStore((s) => s.translationModel);
  const translationRemoteUrl = useSettingsStore((s) => s.translationRemoteUrl);
  const translationCloudBaseUrl = useSettingsStore((s) => s.translationCloudBaseUrl);
  const translationCustomApiKey = useSettingsStore((s) => s.translationCustomApiKey);
  const translationDisableThinking = useSettingsStore((s) => s.translationDisableThinking);
  const translationTargetLanguage = useSettingsStore((s) => s.translationTargetLanguage);

  const isTranslate = kind === "translate";
  const isAgent = kind === "dictationAgent";
  // The merge runs on the multi-transcription reconcile scope, not the cleanup scope.
  const isReconcile = kind === "reconcile";
  const multiTranscriptionEnabled = useSettingsStore((s) => s.multiTranscriptionEnabled);
  const reconcileProvider = useSettingsStore((s) => s.dualTranscriptionReconcileProvider);
  // The healed id, which is what the request carries: a stored model the provider no
  // longer serves is substituted, so displaying the raw setting would name a model that
  // is never sent.
  const reconcileModel = useSettingsStore(selectEffectiveReconcileModel);

  const customPrompt = useSettingsStore((s) => s.customPrompts[kind]);
  const setCustomPrompt = useSettingsStore((s) => s.setCustomPrompt);
  const defaultPrompt = getDefaultPromptText(kind, uiLanguage);
  const [editedPrompt, setEditedPrompt] = useState(customPrompt || defaultPrompt);

  const savePrompt = () => {
    setCustomPrompt(kind, editedPrompt);
    showAlertDialog({
      title: t("promptStudio.dialogs.saved.title"),
      description: t("promptStudio.dialogs.saved.description"),
    });
  };

  const resetToDefault = () => {
    setEditedPrompt(defaultPrompt);
    setCustomPrompt(kind, "");
    showAlertDialog({
      title: t("promptStudio.dialogs.reset.title"),
      description: t("promptStudio.dialogs.reset.description"),
    });
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  };

  // The prompt labels each version with the recogniser behind it and has a tie-break
  // ordered by recogniser, so the test uses the names of the lanes that would really
  // run. Falling back to the first two providers keeps the labels real when multi
  // transcription is off and no lanes are resolved.
  const reconcileTestLabels = (() => {
    const settings = useSettingsStore.getState() as unknown as Record<string, unknown>;
    const labels = resolveMultiTranscriptionLanes(settings)
      .map((lane) => getMultiTranscriptionProvider(lane.provider)?.label)
      .filter((label): label is string => !!label);
    const fallback = MULTI_TRANSCRIPTION_PROVIDERS.map((provider) => provider.label);
    return [labels[0] ?? fallback[0], labels[1] ?? fallback[1]];
  })();

  const testPrompt = async () => {
    if (!testText.trim()) return;

    setIsLoading(true);
    setTestResult("");

    try {
      if (isTranslate) {
        if (!useDictationTranslation) {
          setTestResult(t("promptStudio.test.translationDisabled"));
          return;
        }
        if (!translationTargetLanguage.trim()) {
          setTestResult(t("promptStudio.test.noTargetLanguage"));
          return;
        }

        const isSelfHosted = translationMode === "self-hosted" && !!translationRemoteUrl.trim();
        const isCustom = translationMode === "providers" && translationProvider.trim() === "custom";

        if (!isCloudTranslation && !isSelfHosted && !translationModel.trim()) {
          setTestResult(t("promptStudio.test.noModelSelected"));
          return;
        }

        const provider = isCloudTranslation
          ? "openwhispr"
          : translationProvider.trim() || undefined;
        const modelToUse = isCloudTranslation ? translationModel || "auto" : translationModel;

        const previous = customPrompt;
        setCustomPrompt(kind, editedPrompt);
        try {
          const result = await ReasoningService.processText(testText, modelToUse, agentName, {
            provider,
            lanUrl: isSelfHosted ? translationRemoteUrl : undefined,
            baseUrl: isCustom ? translationCloudBaseUrl || undefined : undefined,
            customApiKey:
              isCustom || isSelfHosted ? translationCustomApiKey || undefined : undefined,
            disableThinking: translationDisableThinking,
            language: translationTargetLanguage,
            systemPrompt: resolvePrompt("translate", {
              agentName,
              targetLanguageLabel: getLanguageLabel(translationTargetLanguage),
              customDictionary: getDictionaryHintWords(useSettingsStore.getState()),
              uiLanguage,
            }),
          });
          setTestResult(result);
        } finally {
          setCustomPrompt(kind, previous);
        }
        return;
      }

      // The agent runs on its own inference scope; falling through to the cleanup
      // branch would test the cleanup provider with the cleanup prompt.
      if (isAgent) {
        if (!useDictationAgent) {
          setTestResult(t("promptStudio.test.agentDisabled"));
          return;
        }

        const settings = useSettingsStore.getState();
        const agent = resolveDictationAgentInference(settings, {
          isCloudAgent: isCloudDictationAgent,
        });

        if (!agent.reachable) {
          setTestResult(t("promptStudio.test.noModelSelected"));
          return;
        }

        const previous = customPrompt;
        setCustomPrompt(kind, editedPrompt);
        try {
          const result = await ReasoningService.processText(testText, agent.model, agentName, {
            ...agent.config,
            systemPrompt: resolvePrompt("dictationAgent", {
              agentName,
              language: settings.preferredLanguage,
              customDictionary: getDictionaryHintWords(settings),
              uiLanguage,
            }),
          });
          setTestResult(result);
        } finally {
          setCustomPrompt(kind, previous);
        }
        return;
      }

      // The merge: the same request the dictation path makes, built by the same helper,
      // so a prompt that behaves here behaves there. It runs on the reconcile scope's
      // provider and model — the cleanup scope below is a different model entirely.
      if (isReconcile) {
        if (!testTextB.trim()) {
          setTestResult(t("promptStudio.reconcile.needsTwoVersions"));
          return;
        }

        const settings = useSettingsStore.getState();
        const previous = customPrompt;
        setCustomPrompt(kind, editedPrompt);
        try {
          const request = buildReconcileRequest({
            versions: [
              { text: testText, provider: reconcileTestLabels[0] },
              { text: testTextB, provider: reconcileTestLabels[1] },
            ],
            agentName,
            language: settings.preferredLanguage,
            // The dictionary half of the dictation vocabulary. The screen half is
            // captured per dictation in the main process and has nothing to read here,
            // so the test shows what the curated words do and says so.
            vocabulary: getDictionaryHintWords(settings),
          });
          const result = await ReasoningService.processText(
            request.input,
            request.model,
            null,
            request.options
          );
          setTestResult(result);
        } finally {
          setCustomPrompt(kind, previous);
        }
        return;
      }

      const cleanupProvider = isCloudMode
        ? "openwhispr"
        : cleanupModel
          ? getModelProvider(cleanupModel)
          : "openai";

      logger.debug(
        "PromptStudio test starting",
        {
          useCleanupModel,
          isCloudMode,
          cleanupModel,
          cleanupProvider,
          testTextLength: testText.length,
          agentName,
        },
        "prompt-studio"
      );

      if (!useCleanupModel) {
        setTestResult(t("promptStudio.test.disabledReasoning"));
        return;
      }

      if (!isCloudMode && !cleanupModel) {
        setTestResult(t("promptStudio.test.noModelSelected"));
        return;
      }

      if (!isCloudMode) {
        const providerConfig = PROVIDER_CONFIG[cleanupProvider] || {
          label: cleanupProvider.charAt(0).toUpperCase() + cleanupProvider.slice(1),
        };

        if (providerConfig.baseStorageKey) {
          const baseUrl = (useSettingsStore.getState().cleanupCloudBaseUrl || "").trim();
          if (!baseUrl) {
            setTestResult(
              t("promptStudio.test.baseUrlMissing", {
                provider:
                  cleanupProvider === "custom"
                    ? t("promptStudio.test.customEndpoint")
                    : providerConfig.label,
              })
            );
            return;
          }
        }
      }

      const modelToUse = isCloudMode ? cleanupModel || "auto" : cleanupModel;

      const previous = customPrompt;
      setCustomPrompt(kind, editedPrompt);
      try {
        const result = await ReasoningService.processText(testText, modelToUse, agentName, {
          disableThinking: useSettingsStore.getState().cleanupDisableThinking,
        });
        setTestResult(result);
      } finally {
        setCustomPrompt(kind, previous);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("PromptStudio test failed", { error: errorMessage }, "prompt-studio");
      const typed = error as { code?: string; provider?: string };
      setTestResult(
        typed?.code === "API_KEY_MISSING"
          ? t("promptStudio.test.apiKeyMissing", { provider: typed.provider })
          : t("promptStudio.test.failed", { error: errorMessage })
      );
    } finally {
      setIsLoading(false);
    }
  };

  // The suffix exactly as the merge receives it: appendVocabularySuffix onto an empty
  // prompt is the appended block by itself. Empty when nothing is curated, which is the
  // honest answer — the screen half only exists while a dictation is running.
  // Subscribed as the two stored arrays rather than through one selector that builds a
  // list: a selector returning a fresh array every call is a new snapshot every render.
  const customDictionary = useSettingsStore((s) => s.customDictionary);
  const snippets = useSettingsStore((s) => s.snippets);
  const vocabularyAppendix = isReconcile
    ? appendVocabularySuffix(
        "",
        getDictionaryHintWords({ customDictionary, snippets }),
        uiLanguage
      ).trim()
    : "";

  const isAgentAddressed = testText.toLowerCase().includes(agentName.toLowerCase());
  const isCustomPrompt = customPrompt.length > 0;
  const currentPrompt = customPrompt || defaultPrompt;

  const tabs = [
    { id: "current" as const, label: t("promptStudio.tabs.view"), icon: Eye },
    { id: "edit" as const, label: t("promptStudio.tabs.customize"), icon: Edit3 },
    { id: "test" as const, label: t("promptStudio.tabs.test"), icon: TestTube },
  ];

  return (
    <div className={className}>
      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {/* Tab Navigation + Content in a single panel */}
      <div className="rounded-xl border border-border/60 dark:border-border-subtle bg-card dark:bg-surface-2 overflow-hidden">
        <div className="flex border-b border-border/40 dark:border-border-subtle">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-xs font-medium transition-colors duration-150 border-b-2 ${
                  isActive
                    ? "border-primary text-foreground bg-primary/5 dark:bg-primary/3"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-black/2 dark:hover:bg-white/2"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* ── View Tab ── */}
        {activeTab === "current" && (
          <div className="divide-y divide-border/40 dark:divide-border-subtle">
            <div className="px-5 py-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium text-muted-foreground/60 uppercase tracking-wider">
                    {isCustomPrompt
                      ? t("promptStudio.view.customPrompt")
                      : t("promptStudio.view.defaultPrompt")}
                  </p>
                  {isCustomPrompt && (
                    <span className="text-xs font-semibold uppercase tracking-wider px-1.5 py-px rounded-full bg-primary/10 text-primary">
                      {t("promptStudio.view.modified")}
                    </span>
                  )}
                </div>
                <Button
                  onClick={() => copyText(currentPrompt)}
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                >
                  {copiedPrompt ? (
                    <>
                      <Check className="w-3 h-3 mr-1 text-success" />{" "}
                      {t("promptStudio.common.copied")}
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3 mr-1" /> {t("promptStudio.common.copy")}
                    </>
                  )}
                </Button>
              </div>
              <div className="bg-muted/30 dark:bg-surface-raised/30 border border-border/30 rounded-lg p-4 max-h-80 overflow-y-auto">
                <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed">
                  {currentPrompt.replace(/\{\{agentName\}\}/g, agentName)}
                </pre>
              </div>
            </div>
            {/* What the template alone does not show: the vocabulary is appended per
                dictation, so reading the prompt here used to leave it looking as though
                the speaker's own words never reached the merge. Rendered from the real
                suffix builder rather than described, and the dictionary half is shown
                because it is the half that exists before a dictation starts. */}
            {isReconcile && (
              <div className="px-5 py-4">
                <p className="text-xs font-medium text-muted-foreground/60 uppercase tracking-wider mb-3">
                  {t("promptStudio.reconcile.appendedAtDictation")}
                </p>
                <div className="bg-muted/30 dark:bg-surface-raised/30 border border-border/30 rounded-lg p-4 max-h-40 overflow-y-auto">
                  <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed">
                    {vocabularyAppendix || t("promptStudio.reconcile.noVocabulary")}
                  </pre>
                </div>
                <p className="text-xs text-muted-foreground/40 mt-2">
                  {t("promptStudio.reconcile.screenTermsNote")}
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Edit Tab ── */}
        {activeTab === "edit" && (
          <div className="divide-y divide-border/40 dark:divide-border-subtle">
            <div className="px-5 py-4">
              <p className="text-xs text-muted-foreground leading-relaxed">
                <span className="font-medium text-warning">
                  {t("promptStudio.edit.cautionLabel")}
                </span>{" "}
                {t("promptStudio.edit.cautionTextPrefix")}{" "}
                <code className="text-xs bg-muted/50 px-1 py-0.5 rounded font-mono">
                  {"{{agentName}}"}
                </code>{" "}
                {t("promptStudio.edit.cautionTextSuffix")}
              </p>
            </div>

            <div className="px-5 py-4">
              <Textarea
                value={editedPrompt}
                onChange={(e) => setEditedPrompt(e.target.value)}
                rows={16}
                className="font-mono text-xs leading-relaxed"
                placeholder={t("promptStudio.edit.placeholder")}
              />
              <p className="text-xs text-muted-foreground/50 mt-2">
                {t("promptStudio.edit.agentNameLabel")}{" "}
                <span className="font-medium text-foreground">{agentName}</span>
              </p>
            </div>

            <div className="px-5 py-4">
              <div className="flex gap-2">
                <Button onClick={savePrompt} size="sm" className="flex-1">
                  <Save className="w-3.5 h-3.5 mr-2" />
                  {t("promptStudio.common.save")}
                </Button>
                <Button onClick={resetToDefault} variant="outline" size="sm">
                  <RotateCcw className="w-3.5 h-3.5 mr-2" />
                  {t("promptStudio.common.reset")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Test Tab ── */}
        {activeTab === "test" &&
          (() => {
            // Each kind reports the scope that actually runs it.
            // The merge has no cloud mode: it is a BYOK provider chosen in Settings →
            // Cleanup, and getEffectiveReconcileModel is what actually gets sent (a
            // stored id the provider no longer serves is healed back to the default, so
            // reading the raw setting would display a model the request will not use).
            const testIsCloud = isReconcile
              ? false
              : isTranslate
                ? isCloudTranslation
                : isAgent
                  ? isCloudDictationAgent
                  : isCloudMode;
            const testModel = isReconcile
              ? reconcileModel
              : isTranslate
                ? translationModel
                : isAgent
                  ? dictationAgentModel
                  : cleanupModel;
            const scopeProvider = isReconcile
              ? reconcileProvider.trim()
              : isTranslate
                ? translationProvider.trim()
                : isAgent
                  ? dictationAgentProvider.trim()
                  : "";
            const testProvider = testIsCloud
              ? "openwhispr"
              : scopeProvider || (testModel ? getModelProvider(testModel) : "openai");
            const providerConfig = PROVIDER_CONFIG[testProvider] || {
              label: testProvider.charAt(0).toUpperCase() + testProvider.slice(1),
            };

            const displayModel = testIsCloud
              ? t("promptStudio.test.openwhisprCloud")
              : testModel || t("promptStudio.test.none");
            const displayProvider =
              testProvider === "custom"
                ? t("promptStudio.test.customEndpoint")
                : providerConfig.label;

            return (
              <div className="divide-y divide-border/40 dark:divide-border-subtle">
                {!isTranslate && !isAgent && !isReconcile && !useCleanupModel && (
                  <div className="px-5 py-4">
                    <div className="rounded-lg border border-warning/20 bg-warning/5 dark:bg-warning/10 px-4 py-3">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-warning mt-0.5 shrink-0" />
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {t("promptStudio.test.disabledInSettingsPrefix")}{" "}
                          <span className="font-medium text-foreground">
                            {t("promptStudio.test.aiModels")}
                          </span>{" "}
                          {t("promptStudio.test.disabledInSettingsSuffix")}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="px-5 py-4">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-muted-foreground/60 uppercase tracking-wider">
                        {t("promptStudio.test.modelLabel")}
                      </p>
                      <p className="text-xs font-medium text-foreground font-mono">
                        {displayModel}
                      </p>
                    </div>
                    <div className="h-3 w-px bg-border/40" />
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-muted-foreground/60 uppercase tracking-wider">
                        {t("promptStudio.test.providerLabel")}
                      </p>
                      <p className="text-xs font-medium text-foreground">{displayProvider}</p>
                    </div>
                  </div>
                </div>

                <div className="px-5 py-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-foreground">
                      {isReconcile
                        ? t("promptStudio.reconcile.versionLabel", {
                            recogniser: reconcileTestLabels[0],
                          })
                        : t("promptStudio.test.inputLabel")}
                    </p>
                    {testText && !isReconcile && (
                      <span
                        className={`text-xs font-medium uppercase tracking-wider px-1.5 py-px rounded ${
                          isTranslate || isAgent || isAgentAddressed
                            ? "bg-primary/10 text-primary dark:bg-primary/15"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {isTranslate
                          ? t("promptStudio.test.translation")
                          : isAgent || isAgentAddressed
                            ? t("promptStudio.test.instruction")
                            : t("promptStudio.test.cleanup")}
                      </span>
                    )}
                  </div>
                  <Textarea
                    value={testText}
                    onChange={(e) => setTestText(e.target.value)}
                    rows={3}
                    className="text-xs"
                    placeholder={t("promptStudio.test.inputPlaceholder")}
                  />
                  {/* Two boxes for the merge: it reads independent transcripts of the
                      same audio, and the interesting behaviour is what it does where
                      they disagree. Labelled with the lanes that would really run,
                      because the prompt's tie-break is by recogniser. */}
                  {isReconcile && (
                    <>
                      <p className="text-xs font-medium text-foreground mt-3 mb-2">
                        {t("promptStudio.reconcile.versionLabel", {
                          recogniser: reconcileTestLabels[1],
                        })}
                      </p>
                      <Textarea
                        value={testTextB}
                        onChange={(e) => setTestTextB(e.target.value)}
                        rows={3}
                        className="text-xs"
                        placeholder={t("promptStudio.test.inputPlaceholder")}
                      />
                    </>
                  )}
                  {/* The agent tab always runs the agent prompt, addressed or not. */}
                  {!isAgent && (
                    <p className="text-xs text-muted-foreground/40 mt-1.5">
                      {isReconcile
                        ? t("promptStudio.reconcile.testHint")
                        : isTranslate
                          ? t("promptStudio.test.translateHint", {
                              language: getLanguageLabel(translationTargetLanguage),
                            })
                          : t("promptStudio.test.addressHint", { agentName })}
                    </p>
                  )}
                </div>

                <div className="px-5 py-4">
                  <Button
                    onClick={testPrompt}
                    disabled={
                      !testText.trim() ||
                      isLoading ||
                      (isReconcile && !testTextB.trim()) ||
                      (!isTranslate && !isAgent && !isReconcile && !useCleanupModel)
                    }
                    size="sm"
                    className="w-full"
                  >
                    <Play className="w-3.5 h-3.5 mr-2" />
                    {isLoading ? t("promptStudio.test.processing") : t("promptStudio.test.run")}
                  </Button>
                </div>

                {testResult && (
                  <div className="px-5 py-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-medium text-foreground">
                        {t("promptStudio.test.outputLabel")}
                      </p>
                      <Button
                        onClick={() => copyText(testResult)}
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5"
                      >
                        <Copy className="w-3 h-3 text-muted-foreground" />
                      </Button>
                    </div>
                    <div className="bg-muted/30 dark:bg-surface-raised/30 border border-border/30 rounded-lg p-4 max-h-48 overflow-y-auto">
                      <pre className="text-xs text-foreground whitespace-pre-wrap leading-relaxed">
                        {testResult}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
      </div>
    </div>
  );
}
