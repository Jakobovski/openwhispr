import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle } from "../ui/toggle";
import { SettingsPanel, SettingsPanelRow, SettingsRow, SectionHeader } from "../ui/SettingsSection";
import PromptStudio from "../ui/PromptStudio";
import { REASONING_PROVIDERS } from "../../models/ModelRegistry";
import {
  RECONCILE_PROVIDER_IDS,
  MULTI_TIMEOUT_CHOICES_MS,
  formatTimeoutSeconds,
} from "../../config/multiTranscription";

const PROVIDERS = RECONCILE_PROVIDER_IDS.map((id) => ({
  id,
  name: REASONING_PROVIDERS[id]?.name ?? id,
  models: REASONING_PROVIDERS[id]?.models ?? [],
})).filter((provider) => provider.models.length > 0);

/**
 * One provider + model picker, parameterised by slot so slot A and slot B render
 * identically rather than as two hand-copied blocks that could drift apart.
 */
function ReconcileSlotPicker({
  providerLabel,
  modelLabel,
  provider,
  model,
  setProvider,
  setModel,
}: {
  providerLabel: string;
  modelLabel: string;
  provider: string;
  model: string;
  setProvider: (value: string) => void;
  setModel: (value: string) => void;
}) {
  const { t } = useTranslation();
  const models = PROVIDERS.find((p) => p.id === provider)?.models ?? [];

  // Switching provider has to move the model with it, or the request carries one
  // provider's id to another's endpoint and 404s.
  const handleProviderChange = (providerId: string) => {
    setProvider(providerId);
    const first = PROVIDERS.find((p) => p.id === providerId)?.models[0];
    if (first) setModel(first.value);
  };

  return (
    <>
      <SettingsPanelRow>
        <SettingsRow
          label={providerLabel}
          description={t("settingsPage.transcription.dualReconcileDescription")}
        >
          <Select value={provider} onValueChange={handleProviderChange}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsPanelRow>
      <SettingsPanelRow>
        <SettingsRow label={modelLabel}>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsPanelRow>
    </>
  );
}

/**
 * Cleanup, as multi transcription does it.
 *
 * There is no separate cleanup pass to configure here: the merge model reads the
 * candidate transcripts and cleans the result in the same call, so the prompt it runs is
 * the cleanup prompt. That is why Language Models no longer offers a Dictation Cleanup
 * tab — it configured a model that a multi-provider dictation does not call.
 *
 * The merge model, its deadline and its prompt live together because they are one
 * decision. The lanes that feed it stay in Speech-to-Text, which is where choosing
 * recognisers belongs.
 *
 * Dual cleanup mode races a second model against the first and pastes whichever
 * answers first — the merge sits in the paste path, so the latency that matters is
 * whichever side is faster on a given dictation, not either one picked in advance.
 */
export default function CleanupSettings() {
  const { t } = useTranslation();

  const multiTranscriptionEnabled = useSettingsStore((s) => s.multiTranscriptionEnabled);
  const multiCleanupEnabled = useSettingsStore((s) => s.multiCleanupEnabled);
  const setMultiCleanupEnabled = useSettingsStore((s) => s.setMultiCleanupEnabled);

  const reconcileProvider = useSettingsStore((s) => s.dualTranscriptionReconcileProvider);
  const setReconcileProvider = useSettingsStore((s) => s.setDualTranscriptionReconcileProvider);
  const reconcileModel = useSettingsStore((s) => s.dualTranscriptionReconcileModel);
  const setReconcileModel = useSettingsStore((s) => s.setDualTranscriptionReconcileModel);

  const reconcileProviderB = useSettingsStore((s) => s.dualTranscriptionReconcileProviderB);
  const setReconcileProviderB = useSettingsStore((s) => s.setDualTranscriptionReconcileProviderB);
  const reconcileModelB = useSettingsStore((s) => s.dualTranscriptionReconcileModelB);
  const setReconcileModelB = useSettingsStore((s) => s.setDualTranscriptionReconcileModelB);

  const reconcileTimeoutMs = useSettingsStore((s) => s.dualTranscriptionReconcileTimeoutMs);
  const setReconcileTimeoutMs = useSettingsStore((s) => s.setDualTranscriptionReconcileTimeoutMs);

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("settingsPage.cleanup.title")}
        description={t("settingsPage.cleanup.description")}
      />

      {/* Not an error: the prompt is still worth reading and editing with multi off. It
          just is not what runs, and a panel that stays silent about that is how someone
          spends an afternoon tuning a prompt nothing calls. */}
      {!multiTranscriptionEnabled && (
        <div className="rounded-lg border border-warning/20 bg-warning/5 dark:bg-warning/10 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-3.5 h-3.5 text-warning mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t("settingsPage.cleanup.multiDisabled")}
            </p>
          </div>
        </div>
      )}

      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.cleanup.raceTwoModels")}
            description={t("settingsPage.cleanup.raceTwoModelsDescription")}
          >
            <Toggle checked={multiCleanupEnabled} onChange={setMultiCleanupEnabled} />
          </SettingsRow>
        </SettingsPanelRow>

        <ReconcileSlotPicker
          providerLabel={t(
            multiCleanupEnabled
              ? "settingsPage.cleanup.firstProvider"
              : "settingsPage.transcription.dualReconcileProvider"
          )}
          modelLabel={t(
            multiCleanupEnabled
              ? "settingsPage.cleanup.firstModel"
              : "settingsPage.transcription.dualReconcileModel"
          )}
          provider={reconcileProvider}
          model={reconcileModel}
          setProvider={setReconcileProvider}
          setModel={setReconcileModel}
        />

        {multiCleanupEnabled && (
          <ReconcileSlotPicker
            providerLabel={t("settingsPage.cleanup.secondProvider")}
            modelLabel={t("settingsPage.cleanup.secondModel")}
            provider={reconcileProviderB}
            model={reconcileModelB}
            setProvider={setReconcileProviderB}
            setModel={setReconcileModelB}
          />
        )}

        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.transcription.dualReconcileTimeout")}
            description={
              multiCleanupEnabled
                ? t("settingsPage.cleanup.raceTimeoutDescription")
                : t("settingsPage.transcription.dualReconcileTimeoutDescription")
            }
          >
            <Select
              value={String(reconcileTimeoutMs)}
              onValueChange={(value) => setReconcileTimeoutMs(Number(value))}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MULTI_TIMEOUT_CHOICES_MS.map((ms) => (
                  <SelectItem key={ms} value={String(ms)}>
                    {t("settingsPage.transcription.dualSecondTimeoutValue", {
                      seconds: formatTimeoutSeconds(ms),
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      <PromptStudio kind="reconcile" />
    </div>
  );
}
