import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import WindowControls from "./WindowControls";
import PermissionsSection from "./ui/PermissionsSection";
import { usePermissions } from "../hooks/usePermissions";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";

interface FirstRunPermissionsProps {
  onDone: () => void;
}

/**
 * First launch, in place of the setup wizard: grant permissions and start dictating.
 *
 * Everything the wizard used to ask for now has a working default — multi-provider
 * transcription is on, its three slots and the merge model are chosen, the language is
 * set, and the hotkey is registered by HotkeyManager at startup from the platform
 * default. Permissions are the exception, because only the user can grant them.
 *
 * Microphone gates the button: without it the app cannot record at all, so finishing
 * here would drop the user into an app that silently does nothing. Accessibility (paste)
 * and system audio (meeting notes) are offered but not required — they can be granted
 * later from Settings, and dictation still reaches the clipboard without them.
 */
export default function FirstRunPermissions({ onDone }: FirstRunPermissionsProps) {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const systemAudio = useSystemAudioPermission();

  return (
    <div
      className="h-screen flex flex-col bg-background"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div
        className="flex items-center justify-end w-full h-10 shrink-0"
        style={{ WebkitAppRegion: "drag" }}
      >
        {window.electronAPI?.getPlatform?.() !== "darwin" && (
          <div className="pr-1" style={{ WebkitAppRegion: "no-drag" }}>
            <WindowControls />
          </div>
        )}
      </div>

      <div className="flex-1 px-6 pb-6 overflow-y-auto flex items-center">
        <div className="w-full max-w-sm mx-auto">
          <Card className="bg-card/90 backdrop-blur-2xl border border-border/50 dark:border-white/5 shadow-lg rounded-xl overflow-hidden">
            <CardContent className="p-6 space-y-4">
              <div className="space-y-1">
                <h1 className="text-lg font-semibold tracking-[-0.01em]">
                  {t("onboarding.permissions.title")}
                </h1>
                <p className="text-[13px] text-muted-foreground">
                  {t("onboarding.permissions.requiredForApp")}
                </p>
              </div>

              <PermissionsSection permissions={permissions} systemAudio={systemAudio} />

              <Button
                className="w-full"
                onClick={onDone}
                disabled={!permissions.micPermissionGranted}
              >
                {t("common.done")}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
