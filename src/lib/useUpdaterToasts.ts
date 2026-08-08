import { useCallback, useEffect, useRef, useState } from "react";

import type { LocaleState } from "./i18n";
import { skillsApplyBundleUpdate, skillsCheckBundleUpdate } from "./skills";
import {
  checkAppUpdate,
  installAppUpdate,
  listenForCheckUpdatesMenu,
  updaterAvailable,
  type AppUpdateCheckResult,
  type AppUpdateInfo,
  type AppUpdateProgress,
} from "./updater";

// ---------------------------------------------------------------------------
// App-update + skills-bundle toasts (extracted from MainApp in step 9). Owns
// the updateToast state, the consent-first update flow (check -> available ->
// explicit install -> explicit relaunch), the 1.5 s post-launch check, the
// skills-bundle OTA check (3 s after launch, then every 6 h), and the
// check-updates menu listener. The toast JSX stays in MainApp, reading the
// values returned here.
// ---------------------------------------------------------------------------

export type UpdateToast =
  | { kind: "checking" }
  | { kind: "available"; info: AppUpdateInfo }
  | { kind: "notAvailable" }
  | { kind: "downloading"; info: AppUpdateInfo; progress: AppUpdateProgress | null }
  | { kind: "ready"; info: AppUpdateInfo }
  | { kind: "skillsUpdated"; version: string }
  | { kind: "skillsAvailable"; version: string }
  | { kind: "error"; message: string };

export interface UpdaterToasts {
  updateToast: UpdateToast | null;
  installPendingUpdate: () => Promise<void>;
  dismissUpdateToast: () => void;
  /** Manual check entry point (command palette / menu). */
  checkForUpdates: (manual?: boolean) => Promise<void>;
}

export function useUpdaterToasts(t: LocaleState["t"]): UpdaterToasts {
  const [updateToast, setUpdateToast] = useState<UpdateToast | null>(null);
  const pendingUpdateRef = useRef<AppUpdateCheckResult["update"] | null>(null);
  const installingUpdateRef = useRef(false);

  const installUpdate = useCallback(
    async (update: AppUpdateCheckResult["update"], info: AppUpdateInfo) => {
      if (installingUpdateRef.current) return;
      installingUpdateRef.current = true;
      setUpdateToast({ kind: "downloading", info, progress: null });
      try {
        await installAppUpdate(update, (progress) => {
          setUpdateToast({ kind: "downloading", info, progress });
        });
        // Downloaded and installed, but never relaunch on our own: the
        // "ready" toast offers an explicit relaunch action so unsaved
        // drafts are never lost to a surprise restart.
        setUpdateToast({ kind: "ready", info });
      } catch (err) {
        setUpdateToast({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        installingUpdateRef.current = false;
      }
    },
    [],
  );

  const checkForUpdates = useCallback(async (manual = false) => {
    if (!updaterAvailable()) {
      if (manual) setUpdateToast({ kind: "error", message: t("updates.desktopOnly") });
      return;
    }
    if (installingUpdateRef.current) return;
    if (manual) setUpdateToast({ kind: "checking" });
    try {
      const result = await checkAppUpdate();
      if (!result) {
        if (manual) setUpdateToast({ kind: "notAvailable" });
        return;
      }
      pendingUpdateRef.current = result.update;
      // Consent-first: surface an actionable toast; downloading and
      // relaunching only happen from explicit user action.
      setUpdateToast({ kind: "available", info: result.info });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (manual) {
        setUpdateToast({ kind: "error", message });
      } else {
        console.info("[maru] update check failed:", message);
      }
    }
  }, [t]);

  const installPendingUpdate = useCallback(async () => {
    const update = pendingUpdateRef.current;
    if (!update || updateToast?.kind !== "available") return;
    await installUpdate(update, updateToast.info);
  }, [installUpdate, updateToast]);

  const dismissUpdateToast = useCallback(() => {
    setUpdateToast(null);
  }, []);

  useEffect(() => {
    if (!updaterAvailable()) return;
    const timer = window.setTimeout(() => {
      void checkForUpdates();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [checkForUpdates]);

  // Skills bundle OTA: a background check after launch and then every 6 h.
  // Clean, runtime-compatible updates apply silently; an update that needs a
  // human (env change, dirty builtin, app too old) surfaces as a toast with
  // a jump to the skills settings tab. Network errors stay silent;
  // signature/integrity failures surface as a security warning.
  const skillsAvailableNotifiedRef = useRef<string | null>(null);
  const checkSkillsBundle = useCallback(async () => {
    try {
      const status = await skillsCheckBundleUpdate();
      if (!status?.updateAvailable) {
        skillsAvailableNotifiedRef.current = null;
        return;
      }
      if (!status.autoApplicable) {
        const version = status.available?.displayVersion ?? "";
        if (version && skillsAvailableNotifiedRef.current !== version) {
          skillsAvailableNotifiedRef.current = version;
          setUpdateToast({ kind: "skillsAvailable", version });
        }
        return;
      }
      const outcome = await skillsApplyBundleUpdate({ repairEnv: false });
      if (outcome) {
        skillsAvailableNotifiedRef.current = null;
        setUpdateToast({
          kind: "skillsUpdated",
          version: outcome.current.displayVersion,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Verification failures of any kind are security-relevant; only
      // plain network/channel unavailability stays silent.
      if (/signature|sha256_mismatch|size_mismatch|metadata_|archive_|bundle_path/.test(message)) {
        setUpdateToast({
          kind: "error",
          message: t("updates.skillsSecurityError", { message }),
        });
      } else {
        console.info("[maru] skills bundle check failed:", message);
      }
    }
  }, [t]);

  useEffect(() => {
    if (!updaterAvailable()) return;
    const timer = window.setTimeout(() => {
      void checkSkillsBundle();
    }, 3000);
    const interval = window.setInterval(
      () => {
        void checkSkillsBundle();
      },
      6 * 60 * 60 * 1000,
    );
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [checkSkillsBundle]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenForCheckUpdatesMenu(() => {
      void checkForUpdates(true);
    })
      .then((off) => {
        if (disposed) {
          off();
        } else {
          unlisten = off;
        }
      })
      .catch((err) => {
        console.info("[maru] update menu listener unavailable:", err);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [checkForUpdates]);

  return { updateToast, installPendingUpdate, dismissUpdateToast, checkForUpdates };
}
