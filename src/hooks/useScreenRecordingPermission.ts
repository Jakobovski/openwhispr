import { useState, useCallback, useEffect, useRef } from "react";
import { getCachedPlatform } from "../utils/platform";
import type { ScreenRecordingAccessResult } from "../types/electron";

const UNSUPPORTED: ScreenRecordingAccessResult = {
  granted: false,
  status: "unsupported",
  supported: false,
};

/**
 * Screen Recording access, which screen context needs and nothing else does.
 *
 * macOS grants it out-of-process: there is no API that raises the prompt, only a
 * capture attempt that happens to raise it, and the grant lands in System
 * Settings rather than coming back as a return value. So `request()` attempts a
 * capture and reports what the OS decided, and the window-focus re-check is what
 * notices a grant the user made in System Settings while the app was in the
 * background — the same shape as the system audio permission for the same reason.
 */
export function useScreenRecordingPermission() {
  const isMacOS = getCachedPlatform() === "darwin";
  const [access, setAccess] = useState<ScreenRecordingAccessResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const checkingRef = useRef(false);

  const check = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setIsChecking(true);
    try {
      const result = await window.electronAPI?.checkScreenRecordingPermission?.();
      setAccess(result ?? UNSUPPORTED);
    } finally {
      checkingRef.current = false;
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  useEffect(() => {
    if (!isMacOS) return;
    const handleFocus = () => check();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [isMacOS, check]);

  const openSettings = useCallback(async () => {
    await window.electronAPI?.openScreenRecordingSettings?.();
  }, []);

  const request = useCallback(async (): Promise<boolean> => {
    setIsChecking(true);
    try {
      const result = await window.electronAPI?.requestScreenRecordingPermission?.();
      setAccess(result ?? UNSUPPORTED);
      // A denial here is usually a *previous* denial: macOS shows the prompt once
      // and silently refuses after that, so the only way forward is the settings
      // pane. Opening it beats a button that looks broken.
      if (!result?.granted) await window.electronAPI?.openScreenRecordingSettings?.();
      return !!result?.granted;
    } catch {
      return false;
    } finally {
      setIsChecking(false);
    }
  }, []);

  return {
    access: access ?? UNSUPPORTED,
    granted: !!access?.granted,
    isChecking,
    check,
    request,
    openSettings,
  };
}

export default useScreenRecordingPermission;
